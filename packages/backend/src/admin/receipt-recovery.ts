// Reconciliation never infers billing from HTTP status, missing usage, or a missing ledger row.
import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { queueProcessing } from "../jobs/content.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";

export const GatewayEvidenceSchema = z.object({
  receiptId: z.number().int().positive(),
  requestId: z.string().uuid(),
  requests: z.array(z.object({
    project: z.string(), model: z.string(), outcome: z.string(), rejectReason: z.string().nullable(),
    activeAttemptId: z.string().nullable(),
    attempts: z.array(z.object({ id: z.string(), outcome: z.string(), dispatchBoundary: z.string() })),
  })),
});
export type GatewayEvidence = z.infer<typeof GatewayEvidenceSchema>;

interface Receipt {
  id: number; service: string; model: string | null; purpose: string; subject: string | null;
  logical_key: string; status: string; attempts: number; request_id: string | null;
  request: { gateway?: { logicalRequestId?: string; project?: string; model?: string } };
}

const ANALYSIS = new Set(["analyze_article", "prefilter_article", "structure_article", "score_article", "understand_article", "summarize_article"]);

/** Keep the same run tag, including score's two independent votes. */
function analysisTag(r: Receipt): { attemptTag?: string } | null {
  const prefix = `${r.service}:${r.purpose}:${r.model ?? "-"}:`;
  if (!r.logical_key.startsWith(prefix)) return null;
  const [hash, ...parts] = r.logical_key.slice(prefix.length).split(":");
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
  const tag = parts.join(":");
  if (r.purpose === "prefilter_article" || r.purpose === "analyze_article") return tag === "0" ? {} : tag ? { attemptTag: tag } : null;
  const suffix = r.purpose === "score_article" ? /(?:^|:)(score-[12])$/ : new RegExp(`(?:^|:)(${r.purpose.replace("_article", "")})$`);
  const match = suffix.exec(tag);
  if (!match) return null;
  const root = tag.slice(0, match.index);
  return root ? { attemptTag: root } : {};
}

async function recoverTask(db: Db, r: Receipt): Promise<{ requeued: boolean; recovery: string }> {
  const skip = (recovery: string) => ({ requeued: false, recovery });
  if (r.service === "backfill") return skip("managed_backfill_runner");
  if (ANALYSIS.has(r.purpose)) {
    const match = /^article:([^@]+)@(\d+)$/.exec(r.subject ?? "");
    const tag = analysisTag(r);
    if (!match || !tag) return skip("unsupported_analysis_identity");
    const [a] = await db`UPDATE articles SET processing_state = 'new', processing_attempts = 0,
      processing_retry_at = NULL, processing_error = NULL
      WHERE id = ${match[1]!} AND revision = ${Number(match[2])} AND processing_state = 'failed' AND managed_backfill_id IS NULL RETURNING id`;
    if (!a) return skip("article_not_failed_or_revision_changed_or_managed");
    const job = await queueProcessing(match[1]!, { step: "analyze", ...tag, db });
    return { requeued: !!job, recovery: job ? "analysis_queued" : "analysis_queue_already_present" };
  }
  if (["group_article", "group_review", "group_signal"].includes(r.purpose)) {
    const match = /^article:([^:@]+)(?::fact:\d+)?$/.exec(r.subject ?? "");
    if (!match) return skip("unsupported_group_identity");
    // groupArticle also stamps grouped_at on failure so the article can publish
    // standalone. Its own membership/manual guards make a normal retry safe.
    const [a] = await db`SELECT id FROM articles WHERE id = ${match[1]!} AND managed_backfill_id IS NULL FOR UPDATE`;
    if (!a) return skip("article_managed_or_missing");
    const job = await enqueue(QUEUES.group, { articleId: match[1], ...(r.purpose === "group_signal" ? { signalOnly: true } : {}) }, { singletonKey: match[1] }, db);
    return { requeued: !!job, recovery: job ? "group_queued" : "group_queue_already_present" };
  }
  if (r.purpose === "story_digest") {
    const match = /^story:(\d+)@\d+$/.exec(r.subject ?? "");
    if (!match) return skip("unsupported_story_identity");
    const id = Number(match[1]);
    const [story] = await db`SELECT id FROM stories WHERE id = ${id} AND merged_into IS NULL FOR UPDATE`;
    if (!story) return skip("story_merged_or_missing");
    const job = await enqueue(QUEUES.digest, { storyId: id }, { singletonKey: `story:${id}` }, db);
    return { requeued: !!job, recovery: job ? "digest_queued" : "digest_queue_already_present" };
  }
  if (r.purpose === "monitor.recognize") return skip("monitor_next_tick");
  return skip("unsupported_purpose");
}

/** Only AIHOT-generated UUIDs, never manually redispatched at Gateway, are eligible. */
async function evidenceProblem(db: Db, r: Receipt, e: GatewayEvidence): Promise<string | null> {
  const gateway = r.request?.gateway;
  if (e.receiptId !== r.id || r.request_id !== e.requestId || gateway?.logicalRequestId !== e.requestId) return "receipt_identity_changed";
  if (e.requests.length !== 1) return "gateway_request_missing_or_ambiguous";
  const request = e.requests[0]!;
  if (!gateway?.project || request.project !== gateway.project || request.model !== gateway.model) return "gateway_project_or_model_mismatch";
  if (request.outcome !== "local_rejected" || request.activeAttemptId !== null || request.attempts.length !== 0) return "gateway_dispatch_not_excluded";
  const [last] = await db`SELECT request_id, status FROM receipt_attempts WHERE receipt_id = ${r.id} AND attempt = ${r.attempts} FOR UPDATE`;
  if (!last || last.request_id !== e.requestId || last.status !== "unknown") return "application_attempt_mismatch";
  return null;
}

export async function releaseUnknownReceipt(id: number, input: {
  error: string; actor: string; note: string; billed: boolean | null; evidence?: GatewayEvidence; dryRun?: boolean;
}) {
  return sql.begin(async (tx) => {
    const [r] = await tx<Receipt[]>`SELECT * FROM receipts WHERE id = ${id} FOR UPDATE`;
    if (!r || r.status !== "unknown") return null;
    if (input.evidence) {
      const problem = await evidenceProblem(tx, r, input.evidence);
      if (problem) return { id, status: "unknown", requeued: false, recovery: problem };
    }
    if (input.dryRun) return { id, status: "unknown", requeued: false, recovery: "eligible_not_dispatched" };
    await tx`UPDATE receipts SET status = 'failed', error = ${input.error}, updated_at = now() WHERE id = ${id}`;
    // Earlier attempts may have incurred cost. Do not rewrite their history.
    await tx`UPDATE receipt_attempts SET status = 'failed', error = ${input.error}
      WHERE receipt_id = ${id} AND attempt = ${r.attempts} AND status = 'unknown'`;
    const recovered = await recoverTask(tx, r);
    await tx`INSERT INTO audit_log (actor, action, subject, reason, before, after)
      VALUES (${input.actor}, ${input.evidence ? "receipt.reconcile" : "receipt.release"}, ${`receipt:${id}`}, ${input.note},
        ${tx.json({ status: "unknown", requestId: r.request_id })},
        ${tx.json({ status: "failed", billed: input.billed, ...recovered, ...(input.evidence ? { evidence: input.evidence } : {}) } as never)})`;
    return { id, status: "failed", subject: r.subject, purpose: r.purpose, ...recovered };
  });
}
