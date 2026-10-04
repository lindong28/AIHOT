// Operator-authorized business replay. It does not reconcile the original provider bill.
import { sql, type Db } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { loadPreparation, storePreparation } from "../backfill/history-input.ts";
import { recoverTask, type Receipt } from "./receipt-recovery.ts";
import { contentPolicyRejected } from "../providers/gateway-error.ts";

type Item = { runId: string; key: string };
export type RecoveryTarget =
  | { kind: "article"; id: string; revision: number }
  | { kind: "group"; id: string }
  | { kind: "digest"; id: number }
  | { kind: "monitor"; id: string }
  | { kind: "backfill"; items: Item[] }
  | { kind: "unsupported"; reason: string };
interface Recovery {
  receipt_id: number; original_attempt: number; batch: string; target_key: string;
  target: RecoveryTarget; state: string; note: string; original_status: string;
  created_at: Date; started_at: Date | null;
  evidence: { jobId?: string } | null;
}
const analysisPurposes = new Set(["analyze_article", "prefilter_article", "structure_article", "score_article", "understand_article", "summarize_article"]);

function backfillTargets(receipts: Receipt[], db: Db) {
  let cached: Promise<Map<number, Item[]>> | undefined;
  return () => cached ??= (async () => {
    const wanted = receipts.filter(r => r.service === 'backfill');
    const subjects = new Map<string, number[]>(), articles = new Map<string, number[]>();
    const ids = new Set<number>();
    for (const r of wanted) {
      const a = /^article:([^@]+)@(\d+)$/.exec(r.subject ?? '');
      if (a && !a[1]!.startsWith('preparation:')) articles.set(a[1]!, [...(articles.get(a[1]!) ?? []),r.id]);
      else {
        ids.add(r.id);
        if (r.subject) subjects.set(r.subject, [...(subjects.get(r.subject) ?? []), r.id]);
      }
    }
    const result = new Map<number, Item[]>();
    if (!wanted.length) return result;
    // Stream once with bounded memory. Searching every receipt ID inside every
    // archived body is expensive and cannot establish the exact identity anyway.
    for await (const candidates of db`SELECT run_id,identity_key,article_id,preparation FROM backfill_items
      WHERE (${ids.size>0} AND preparation IS NOT NULL) OR article_id=ANY(${[...articles.keys()]}::text[])`.cursor(256)) {
      for (const i of candidates) {
        const matched = new Set<number>(articles.get(i.article_id) ?? []);
        if (ids.size && i.preparation) {
          const p = loadPreparation(i.preparation);
          for (const v of p.versions) {
            for (const id of subjects.get(`article:preparation:${sha256(v.key)}@1`) ?? []) matched.add(id);
          }
          for (const v of Object.values(p.results)) {
            if (ids.has(v.prefilter?.receiptId)) matched.add(v.prefilter.receiptId);
            const id = v.error?.startsWith('receipt_unknown:') ? Number(v.error.slice('receipt_unknown:'.length)) : NaN;
            if (ids.has(id)) matched.add(id);
          }
        }
        for (const id of matched) {
          const items = result.get(id) ?? [];
          items.push({ runId: String(i.run_id), key: String(i.identity_key) }); result.set(id, items);
        }
      }
    }
    return result;
  })();
}

async function targetFor(r: Receipt, backfill: ReturnType<typeof backfillTargets>): Promise<RecoveryTarget> {
  const article = /^article:([^@]+)@(\d+)$/.exec(r.subject ?? "");
  if (r.service === "backfill") {
    const items = (await backfill()).get(r.id) ?? [];
    items.sort((a,b) => `${a.runId}:${a.key}`.localeCompare(`${b.runId}:${b.key}`));
    return items.length ? { kind: "backfill", items } : { kind: "unsupported", reason: "backfill_item_not_found" };
  }
  if (article && analysisPurposes.has(r.purpose)) return { kind: "article", id: article[1]!, revision: Number(article[2]) };
  const group = /^article:([^:@]+)(?::fact:\d+)?$/.exec(r.subject ?? "");
  if (group && ["group_article", "group_review", "group_signal"].includes(r.purpose)) return { kind: "group", id: group[1]! };
  const story = /^story:(\d+)@\d+$/.exec(r.subject ?? "");
  if (story && r.purpose === "story_digest") return { kind: "digest", id: Number(story[1]) };
  if (r.purpose === "monitor.recognize" && r.subject?.startsWith("x:")) return { kind: "monitor", id: r.subject.slice(2) };
  return { kind: "unsupported", reason: "unsupported_receipt_subject" };
}

/** No writes, no model calls. The same selection as the administration incident table. */
export async function previewReceiptRecovery() {
  const receipts = await sql<Receipt[]>`SELECT r.* FROM receipts r
    WHERE (r.status='unknown' OR (r.status='failed' AND r.updated_at > now()-interval '3 days'))
      AND NOT EXISTS (SELECT 1 FROM receipt_recoveries x WHERE x.receipt_id=r.id AND x.original_attempt=r.attempts)
    ORDER BY r.id`;
  const rows = [];
  const backfill = backfillTargets(receipts, sql);
  for (const r of receipts) {
    const target = await targetFor(r, backfill);
    rows.push({ receiptId: r.id, attempt: r.attempts, status: r.status, target });
  }
  return rows;
}

/** A batch name freezes a cohort, once. Continuing it never discovers newly failed calls. */
export async function createReceiptRecoveryBatch(batch: string, note: string, receiptIds?: number[]) {
  if (!batch.trim() || !note.trim()) throw new Error("batch and authorization note are required");
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('receipt-recovery:create'))`;
    const [existing] = await tx`SELECT 1 FROM receipt_recoveries WHERE batch=${batch} LIMIT 1`;
    if (existing) return { created: 0, reused: true };
    const rows = await tx<Receipt[]>`SELECT r.* FROM receipts r
      WHERE (r.status='unknown' OR (r.status='failed' AND r.updated_at > now()-interval '3 days'))
        ${receiptIds ? tx`AND r.id = ANY(${receiptIds}::bigint[])` : tx``}
        AND NOT EXISTS (SELECT 1 FROM receipt_recoveries x WHERE x.receipt_id=r.id AND x.original_attempt=r.attempts)
      ORDER BY r.id FOR UPDATE`;
    if (!rows.length) throw new Error("No eligible receipts: no batch was created");
    const backfill = backfillTargets(rows, tx);
    for (const r of rows) {
      const target = await targetFor(r, backfill);
      await tx`INSERT INTO receipt_recoveries(receipt_id,original_attempt,batch,target_key,target,note,original_status,state)
        VALUES (${r.id},${r.attempts},${batch},${JSON.stringify(target)},${tx.json(target as never)},${note},${r.status},
          ${target.kind === 'unsupported' ? 'blocked' : 'planned'})`;
    }
    return { created: rows.length, reused: false };
  });
}

async function businessEvidence(db: Db, t: RecoveryTarget, since: Date, jobId?: string): Promise<object | null> {
  if (t.kind === "article") {
    const [row] = await db`SELECT a.id,a.revision,a.processing_state,p.analysis_id FROM articles a
      JOIN publications p ON p.article_id=a.id JOIN analyses n ON n.id=p.analysis_id
      WHERE a.id=${t.id} AND a.revision>=${t.revision} AND n.article_id=a.id AND n.input_revision=a.revision
        AND n.created_at>=${since} AND a.processing_state IN ('analyzed','blocked')`;
    return row ? { kind: "article", ...row, capturedRevision: t.revision,
      reason: row.revision > t.revision ? "superseded_revision" : "business_completed" } : null;
  }
  if (t.kind === "backfill") {
    const proof = [];
    for (const i of t.items) {
      const [row] = await db`SELECT state,article_id,updated_at FROM backfill_items WHERE run_id=${i.runId} AND identity_key=${i.key}`;
      if (!row || !['published','filtered','existing'].includes(row.state) || row.updated_at < since) return null;
      proof.push({ ...i, ...row });
    }
    return { kind: "backfill", items: proof };
  }
  if (t.kind === "group") {
    const [row] = await db`SELECT f.fact_id,f.article_id FROM fact_articles f WHERE article_id=${t.id} AND created_at>=${since} LIMIT 1`;
    if (row) return { kind: "group", ...row };
    if (jobId) {
      const [done] = await db`SELECT j.id AS job_id,p.article_id,p.fact_id FROM pgboss.job j JOIN publications p ON p.article_id=${t.id}
        WHERE j.id=${jobId} AND j.name='events.group' AND j.data->>'articleId'=${t.id} AND j.state='completed' LIMIT 1`;
      if (done) return { kind: "group", ...done };
    }
    return null;
  }
  if (t.kind === "digest") {
    const [row] = await db`SELECT story_id,version,receipt_id FROM story_digests WHERE story_id=${t.id} AND created_at>=${since} ORDER BY version DESC LIMIT 1`;
    if (row) return { kind: "digest", ...row };
    if (jobId) {
      const [done] = await db`SELECT j.id AS job_id,d.story_id,d.version FROM pgboss.job j JOIN story_digests d ON d.story_id=${t.id}
        WHERE j.id=${jobId} AND j.name='events.digest' AND j.data->>'storyId'=${String(t.id)} AND j.state='completed'
        ORDER BY d.version DESC LIMIT 1`;
      if (done) return { kind: 'digest', ...done };
    }
    return null;
  }
  if (t.kind === "monitor") {
    const [row] = await db`SELECT id,processed_at FROM monitor_posts WHERE id=${t.id} AND processed_at>=${since} AND recognition IS NOT NULL`;
    return row ? { kind: "monitor", ...row } : null;
  }
  return null;
}

/** Successful business state closes only the captured attempt, never a subsequent failure. */
export async function settleReceiptRecoveryBatch(batch: string) {
  const rows = await sql<Recovery[]>`SELECT * FROM receipt_recoveries WHERE batch=${batch} AND
    (state IN ('planned','queued') OR (state='blocked' AND evidence->>'reason' IN ('article_not_failed_current_revision','content_policy_rejected'))) ORDER BY receipt_id`;
  let recovered = 0;
  for (const x of rows) {
    await sql.begin(async tx => {
      const [r] = await tx`SELECT * FROM receipts WHERE id=${x.receipt_id} FOR UPDATE`;
      if (!r) return;
      // A new unknown/failed attempt must stay visible even if an older business result exists.
      if (r.attempts > x.original_attempt && !['received','completed'].includes(r.status)) {
        if (['unknown','failed'].includes(r.status)) await tx`UPDATE receipt_recoveries SET state='blocked',evidence=${tx.json({ reason: 'new_attempt_failed' })}
          WHERE receipt_id=${x.receipt_id} AND original_attempt=${x.original_attempt} AND state='queued'`;
        return;
      }
      const proof = await businessEvidence(tx, x.target, r.created_at, x.evidence?.jobId);
      if (!proof) {
        if (x.state === 'queued' && x.started_at && await targetFailed(tx, x.target, x.started_at, x.evidence?.jobId)) {
          await tx`UPDATE receipt_recoveries SET state='blocked',evidence=${tx.json({ reason: 'replay_failed' })}
            WHERE receipt_id=${x.receipt_id} AND original_attempt=${x.original_attempt} AND state='queued'`;
        }
        return;
      }
      const result = await tx`UPDATE receipt_recoveries SET state='recovered',recovered_at=now(),evidence=${tx.json(proof as never)}
        WHERE receipt_id=${x.receipt_id} AND original_attempt=${x.original_attempt} AND
          (state IN ('planned','queued') OR (state='blocked' AND evidence->>'reason' IN ('article_not_failed_current_revision','content_policy_rejected')))`;
      recovered += result.count;
    });
  }
  return { recovered };
}

/** Re-evaluate existing business evidence only; never authorize or dispatch a paid replay. */
export async function settleReceiptRecoveries() {
  const batches = await sql<{ batch: string }[]>`SELECT DISTINCT batch FROM receipt_recoveries WHERE
    state IN ('planned','queued') OR (state='blocked' AND evidence->>'reason' IN ('article_not_failed_current_revision','content_policy_rejected'))`;
  let recovered = 0;
  for (const { batch } of batches) recovered += (await settleReceiptRecoveryBatch(batch)).recovered;
  return { recovered };
}

async function targetFailed(db: Db, t: RecoveryTarget, started: Date, jobId?: string) {
  if (t.kind === 'article') {
    const [row] = await db`SELECT 1 FROM articles a WHERE a.id=${t.id} AND a.processing_state='failed'
      AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.data->>'articleId'=a.id AND j.name IN ('content.analyze','content.extract-body')
        AND j.state IN ('created','retry','active'))`;
    return !!row;
  }
  if (t.kind === 'backfill') {
    for (const i of t.items) {
      const [row] = await db`SELECT 1 FROM backfill_items WHERE run_id=${i.runId} AND identity_key=${i.key} AND state='failed' AND updated_at>=${started}`;
      if (row) return true;
    }
  }
  if (t.kind === 'group' || t.kind === 'digest') {
    const name = t.kind === 'group' ? 'events.group' : 'events.digest';
    const field = t.kind === 'group' ? 'articleId' : 'storyId';
    const [row] = jobId ? await db`SELECT 1 FROM pgboss.job WHERE id=${jobId} AND name=${name} AND data->>${field}=${String(t.id)} AND state IN ('failed','cancelled')` : [];
    return !!row;
  }
  return false;
}

async function queueBackfill(db: Db, items: Item[]): Promise<string | null> {
  for (const runId of [...new Set(items.map(i => i.runId))].sort()) {
    const [lock] = await db`SELECT pg_try_advisory_xact_lock(hashtext(${'backfill:' + runId})) AS locked`;
    if (!lock?.locked) return "backfill_executor_busy";
    const [run] = await db`SELECT state FROM backfill_runs WHERE id=${runId} FOR UPDATE`;
    if (!run || run.state === 'paused') return "backfill_paused_or_missing";
  }
  for (const i of items) {
    const [row] = await db`SELECT state,preparation,day FROM backfill_items WHERE run_id=${i.runId} AND identity_key=${i.key} FOR UPDATE`;
    if (!row || !row.day || !['failed','pending','published','filtered','existing'].includes(row.state)) return "backfill_item_not_retryable";
  }
  for (const i of items) {
    const [row] = await db`SELECT state,preparation FROM backfill_items WHERE run_id=${i.runId} AND identity_key=${i.key}`;
    if (row!.state !== 'failed') continue;
    if (row!.preparation) {
      const p = loadPreparation(row!.preparation);
      for (const result of Object.values(p.results)) delete result.error;
      await db`UPDATE backfill_items SET preparation=${db.json(storePreparation(p))} WHERE run_id=${i.runId} AND identity_key=${i.key}`;
    }
    await db`UPDATE backfill_items SET state='pending',reason=NULL,retry_after=NULL,updated_at=now() WHERE run_id=${i.runId} AND identity_key=${i.key}`;
    await db`UPDATE backfill_runs SET state='ready',error=NULL WHERE id=${i.runId} AND state IN ('needs_attention','complete')`;
  }
  return null;
}

/** Each target transaction releases all of its frozen blockers and enqueues once. */
export async function advanceReceiptRecoveryBatch(batch: string, limit = 4, backfillLimit?: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1..100");
  if (backfillLimit !== undefined && (!Number.isInteger(backfillLimit) || backfillLimit < 1 || backfillLimit > 100)) throw new Error("backfill limit must be 1..100");
  await settleReceiptRecoveryBatch(batch);
  // Existing queued work consumes the allowance: repeated invocations cannot flood the live worker.
  const active = await sql<{ pool: string; n: number }[]>`SELECT
    CASE WHEN ${backfillLimit !== undefined} AND target->>'kind'='backfill' THEN 'backfill' ELSE 'ordinary' END AS pool,
    count(DISTINCT target_key)::int AS n FROM receipt_recoveries WHERE batch=${batch} AND state='queued' GROUP BY 1`;
  const remaining: Record<string, number> = { ordinary: limit, backfill: backfillLimit ?? 0 };
  for (const row of active) remaining[row.pool] = Math.max(0, remaining[row.pool]! - row.n);
  const targets = await sql<{ target_key: string; kind: string }[]>`SELECT DISTINCT target_key,target->>'kind' AS kind FROM receipt_recoveries
    WHERE batch=${batch} AND state='planned' ORDER BY target_key`;
  const results = [];
  for (const { target_key: key, kind } of targets) {
    if (!remaining.ordinary && !remaining.backfill) break;
    const pool = backfillLimit !== undefined && kind === 'backfill' ? 'backfill' : 'ordinary';
    if (!remaining[pool]) continue;
    const result = await sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('receipt-recovery:' || ${key}))`;
      const rows = await tx<Recovery[]>`SELECT * FROM receipt_recoveries WHERE batch=${batch} AND target_key=${key} AND state='planned' ORDER BY receipt_id FOR UPDATE`;
      if (!rows.length) return { target: key, result: "already_started" };
      const t = rows[0]!.target;
      const receipts: Receipt[] = [];
      for (const x of rows) {
        const [r] = await tx<Receipt[]>`SELECT * FROM receipts WHERE id=${x.receipt_id} FOR UPDATE`;
        if (!r || r.attempts !== x.original_attempt || !['failed','unknown'].includes(r.status)) {
          await tx`UPDATE receipt_recoveries SET state='blocked',evidence=${tx.json({ reason: "receipt_changed" })} WHERE batch=${batch} AND target_key=${key} AND state='planned'`;
          return { target: key, result: "receipt_changed" };
        }
        receipts.push(r);
      }
      // One refused stage blocks replay of the entire frozen business target: another
      // receipt from that target must not indirectly dispatch the same rejected input.
      const attempts = await tx`SELECT a.error_details,a.error FROM receipt_attempts a
        JOIN receipt_recoveries x ON x.receipt_id=a.receipt_id AND x.original_attempt=a.attempt
        WHERE x.batch=${batch} AND (x.target_key=${key}
          ${t.kind === 'backfill' ? tx`OR (x.target->>'kind'='backfill' AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(x.target->'items') i WHERE ${tx.json(t.items as never)} @> jsonb_build_array(i)
          ))` : tx``})`;
      if (attempts.some(a => contentPolicyRejected(a.error_details, a.error))) {
        await tx`UPDATE receipt_recoveries SET state='blocked',evidence=${tx.json({ reason: 'content_policy_rejected' })}
          WHERE batch=${batch} AND target_key=${key} AND state='planned'`;
        return { target: key, result: "content_policy_rejected" };
      }
      if (t.kind === 'backfill') {
        const problem = await queueBackfill(tx, t.items);
        if (problem) {
          if (problem !== 'backfill_executor_busy') await tx`UPDATE receipt_recoveries SET state='blocked',evidence=${tx.json({ reason: problem })}
            WHERE batch=${batch} AND target_key=${key} AND state='planned'`;
          return { target: key, result: problem };
        }
      } else if (t.kind === 'article') {
        const [a] = await tx`SELECT revision,processing_state,managed_backfill_id FROM articles WHERE id=${t.id} FOR UPDATE`;
        if (!a || a.revision !== t.revision || a.managed_backfill_id || a.processing_state !== 'failed') {
          await tx`UPDATE receipt_recoveries SET state='blocked',evidence=${tx.json({ reason: 'article_not_failed_current_revision' })}
            WHERE batch=${batch} AND target_key=${key} AND state='planned'`;
          return { target: key, result: "article_not_failed_current_revision" };
        }
      }
      for (const r of receipts) {
        // Deliberately leave receipt_attempts untouched: the historical dispatch remains unknown.
        if (r.status === 'unknown') await tx`UPDATE receipts SET status='failed',error='Operator authorized one business replay; original billing remains unknown',updated_at=now() WHERE id=${r.id}`;
        await tx`INSERT INTO audit_log(actor,action,subject,reason,before,after)
          VALUES ('receipt-recovery-script','receipt.authorize_replay',${`receipt:${r.id}`},${rows[0]!.note},
            ${tx.json({ status: r.status, attempt: r.attempts })},${tx.json({ batch, billed: null, target: t } as never)})`;
      }
      const routed = t.kind === 'backfill' ? { recovery: 'managed_backfill_runner', jobId: undefined } : await recoverTask(tx, receipts[0]!);
      const queued = t.kind === 'backfill' || t.kind === 'monitor' || routed.recovery.endsWith('_queued') || routed.recovery.endsWith('_queue_already_present');
      if ((t.kind === 'group' || t.kind === 'digest') && queued && !routed.jobId) {
        // A reused job can finish between send's conflict and our lookup. Roll back
        // authorization too; the next invocation can observe its result or enqueue anew.
        throw new Error(`Recovery task was not linked: ${routed.recovery}`);
      }
      await tx`UPDATE receipt_recoveries SET state=${queued?'queued':'blocked'},started_at=now(),evidence=${tx.json({ route: routed.recovery, ...(routed.jobId ? { jobId: routed.jobId } : {}) })}
        WHERE batch=${batch} AND target_key=${key} AND state='planned'`;
      return { target: key, result: routed.recovery, admitted: queued };
    });
    results.push(result);
    if ('admitted' in result && result.admitted) remaining[pool] = remaining[pool]! - 1;
  }
  return { results, ...(await receiptRecoveryStatus(batch)) };
}

export async function receiptRecoveryStatus(batch: string) {
  const counts = await sql<{ state: string; n: number }[]>`SELECT state,count(*)::int AS n FROM receipt_recoveries WHERE batch=${batch} GROUP BY state`;
  if (!counts.length) throw new Error("Recovery batch not found");
  const outstanding = await sql`SELECT x.receipt_id,x.original_attempt,x.target,x.state,r.status AS receipt_status,r.attempts,
    x.evidence FROM receipt_recoveries x JOIN receipts r ON r.id=x.receipt_id
    WHERE x.batch=${batch} AND x.state<>'recovered' ORDER BY x.receipt_id`;
  return { batch, counts: Object.fromEntries(counts.map(r => [r.state,r.n])), outstanding };
}
