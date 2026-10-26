import { sql } from "../db.ts";
import { Conflict } from "./sources.ts";
import { receiptOutcome, recordReceiptOutcome } from "../providers/receipt-review.ts";
import { businessEvidence, type RecoveryTarget } from "./receipt-batch-recovery.ts";
import { releaseUnknownReceipt } from "./receipt-recovery.ts";

export async function reviewReceipt(id: number, input: { attempt: number; action: "record" | "stop" | "replay"; billed: boolean | null; note: string; acceptDuplicateCharge?: boolean }, actor: string) {
  if (!input || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || !["record", "stop", "replay"].includes(input.action)
      || ![true, false, null].includes(input.billed) || typeof input.note !== "string" || !input.note.trim() || input.note.length > 2000) throw Object.assign(new Error("需要当前 attempt、明确操作、计费状态和核对说明"), { statusCode: 400 });
  if (input.action === "replay") {
    if (input.acceptDuplicateCharge !== true) throw new Conflict("重放须单独确认可能再次计费");
    return releaseUnknownReceipt(id, { expectedAttempt: input.attempt, billed: input.billed, actor, note: input.note,
      error: "人工授权业务重放；原费用记录保留" });
  }
  return sql.begin(async tx => {
    const [r] = await tx`SELECT attempts,status FROM receipts WHERE id=${id} FOR UPDATE`;
    if (!r) return null;
    if (input.action !== "record" && (r.attempts !== input.attempt || r.status === "pending")) throw new Conflict("回执已变化或仍在调用，请刷新后核对");
    if (input.action === "record" && r.attempts === input.attempt && r.status === "pending") throw new Conflict("请求仍在调用，请稍后核账");
    const [a] = await tx`SELECT error_details,error,response FROM receipt_attempts WHERE receipt_id=${id} AND attempt=${input.attempt}`;
    if (!a) throw new Conflict("缺少 attempt，不能核对");
    const [before] = await tx`SELECT * FROM receipt_reviews WHERE receipt_id=${id} AND attempt=${input.attempt}`;
    const outcome = receiptOutcome(a.error_details, a.error, a.response);
    const disposition = input.action === "stop" ? "stopped" : before?.disposition ?? (outcome === "content_policy_rejected" ? "stopped" : "open");
    if (input.action === "stop" && r.status === "completed") throw new Conflict("已完成的请求无需停止");
    await tx`INSERT INTO receipt_reviews (receipt_id,attempt,outcome,disposition,billed,note,actor)
      VALUES (${id},${input.attempt},${outcome},${disposition},${input.billed},${input.note.trim()},${actor})
      ON CONFLICT (receipt_id,attempt) DO UPDATE SET outcome=excluded.outcome,disposition=excluded.disposition,billed=excluded.billed,
        note=excluded.note,actor=excluded.actor,updated_at=now()`;
    await tx`INSERT INTO audit_log (actor,action,subject,reason,before,after)
      VALUES (${actor},${`receipt.${input.action}`},${`receipt:${id}`},${input.note},${tx.json((before ?? null) as never)},
        ${tx.json({ attempt: input.attempt, disposition, billed: input.billed })})`;
    return { id, attempt: input.attempt, disposition, billed: input.billed, requeued: false };
  });
}

function targetFor(purpose: string, subject: string | null): RecoveryTarget | null {
  if (["analyze_article", "prefilter_article", "structure_article", "score_article", "understand_article", "summarize_article"].includes(purpose)) {
    const m = /^article:([^@]+)@(\d+)$/.exec(subject ?? "");
    return m ? { kind: "article", id: m[1]!, revision: Number(m[2]) } : null;
  }
  if (["group_article", "group_review", "group_signal"].includes(purpose)) {
    const m = /^article:([^:@]+)(?::fact:\d+)?$/.exec(subject ?? "");
    return m ? { kind: "group", id: m[1]! } : null;
  }
  const m = purpose === "story_digest" && /^story:(\d+)@\d+$/.exec(subject ?? "");
  return m ? { kind: "digest", id: Number(m[1]) } : null;
}

/** Evidence-only maintenance: no queues, no calls, no mutation of the original bill or response. */
export async function settleReceiptReviews(input: { dryRun?: boolean } = {}) {
  const rows = await sql`SELECT id FROM receipts WHERE status='unknown' OR
    (status='failed' AND updated_at>now()-interval '7 days') OR id IN
    (SELECT receipt_id FROM receipt_reviews WHERE disposition<>'superseded') ORDER BY id`;
  let classified = 0, superseded = 0;
  const actions: Array<{ id: number; attempt: number; outcome: string; disposition: string }> = [];
  for (const { id } of rows) await sql.begin(async tx => {
    const [r] = await tx`SELECT * FROM receipts WHERE id=${id} ${input.dryRun ? tx`` : tx`FOR UPDATE`}`;
    if (!r || !['unknown','failed','received'].includes(r.status)) return;
    const [a] = await tx`SELECT * FROM receipt_attempts WHERE receipt_id=${id} AND attempt=${r.attempts}`;
    if (!a) return;
    const [before] = await tx`SELECT * FROM receipt_reviews WHERE receipt_id=${id} AND attempt=${r.attempts}`;
    const outcome = receiptOutcome(a.error_details, a.error, a.response ?? r.response);
    if (!input.dryRun) await recordReceiptOutcome(tx, id, r.attempts, outcome);
    if (outcome !== 'unknown' && before?.outcome !== outcome) {
      classified++;
      actions.push({ id: Number(id), attempt: r.attempts, outcome, disposition: outcome === 'content_policy_rejected' ? 'stopped' : 'open' });
    }
    if (before?.disposition === 'superseded' || r.service === 'backfill') return;
    const target = targetFor(r.purpose, r.subject);
    if (!target || !a.started_at) return;
    const evidence = await businessEvidence(tx, target, a.started_at);
    if (!evidence) return;
    superseded++;
    actions.push({ id: Number(id), attempt: r.attempts, outcome, disposition: 'superseded' });
    if (input.dryRun) return;
    await tx`INSERT INTO receipt_reviews (receipt_id,attempt,outcome,disposition,note,actor,evidence)
      VALUES (${id},${r.attempts},${outcome},'superseded','后续业务结果已持久化；旧费用原样保留','ops.recover',${tx.json(evidence as never)})
      ON CONFLICT (receipt_id,attempt) DO UPDATE SET disposition='superseded',evidence=receipt_reviews.evidence || excluded.evidence,updated_at=now()`;
    await tx`INSERT INTO audit_log (actor,action,subject,reason,before,after)
      VALUES ('ops.recover','receipt.supersede',${`receipt:${id}`},'后续业务结果已持久化；旧费用保留',
        ${tx.json((before ?? null) as never)},${tx.json({ attempt: r.attempts, evidence } as never)})`;
  });
  return { classified, superseded, actions };
}
