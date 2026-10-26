// Only explicitly web-authorized batches are picked up by the scheduled runner.
import { sql, type Db } from '../db.ts';
import { createReceiptRecoveryBatch, reconsiderationCandidate, advanceReceiptRecoveryBatch, type RecoveryTarget, type ReconsiderationSnapshot } from './receipt-batch-recovery.ts';
import type { Receipt } from './receipt-recovery.ts';
import { reconsiderationBatchStopped } from '../providers/reconsideration.ts';

const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
function idsOf(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(value).size !== value.length) throw invalid('请选择 1 至 100 条不同的回执');
  return value;
}
function batchOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw invalid('批次标识无效');
  return value;
}
function noteOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw invalid('请填写不超过 2000 字的操作原因');
  return value.trim();
}

export async function previewWebReceiptRecovery(value: unknown) {
  const ids = idsOf(value);
  const receipts = await sql<Receipt[]>`SELECT * FROM receipts WHERE id=ANY(${ids}::bigint[]) ORDER BY id`;
  const targets = new Set<string>();
  const rows = [];
  for (const id of ids) {
    const r = receipts.find(r => r.id === id);
    if (!r) { rows.push({ id, eligible: false, reason: '回执不存在', target: null, snapshot: null }); continue; }
    const candidate = await reconsiderationCandidate(sql, r);
    const key = JSON.stringify(candidate.target);
    if (!candidate.reason && targets.has(key)) candidate.reason = '所选回执指向同一个业务目标，请只保留一条';
    if (!candidate.reason) targets.add(key);
    rows.push({ id, eligible: !candidate.reason, reason: candidate.reason, target: candidate.target,
      snapshot: !candidate.reason ? { id, attempt: r.attempts, requestId: r.request_id!, logicalKey: r.logical_key } : null });
  }
  return { rows };
}

export async function createWebReceiptRecovery(value: unknown, actor: string) {
  const body = value as { batch?: unknown; note?: unknown; receipts?: unknown; acceptDuplicateCharge?: unknown } | null;
  const batch = batchOf(body?.batch), note = noteOf(body?.note);
  if (body?.acceptDuplicateCharge !== true || !Array.isArray(body.receipts)) throw invalid('需要明确接受每条一次新生成及可能重复计费');
  idsOf(body.receipts.map(r => r?.id));
  const receipts = body.receipts as ReconsiderationSnapshot[];
  if (receipts.some(r => !Number.isSafeInteger(r.attempt) || r.attempt < 1 || typeof r.requestId !== 'string' || !r.requestId || r.requestId.length > 100 || typeof r.logicalKey !== 'string' || !r.logicalKey || r.logicalKey.length > 1000)) throw invalid('冻结的回执身份无效，请重新预检');
  try {
    return { batch, ...await createReceiptRecoveryBatch(batch, note, undefined, { receipts, acceptDuplicateCharge: true, webActor: actor }) };
  } catch (error) {
    if (error instanceof Error && !('code' in error)) throw Object.assign(error, { code: 'conflict' });
    throw error;
  }
}

async function activeTarget(db: Db, id: number, target: RecoveryTarget, jobId?: string) {
  const article = target.kind === 'article' || target.kind === 'group' ? target.id : '';
  const [row] = await db`SELECT 1 FROM pgboss.job j WHERE state IN ('created','retry','active') AND (
    j.id::text=${jobId ?? ''} OR j.data->'reconsideration'->>'receiptId'=${String(id)}
    OR (${!!article} AND j.data->>'articleId'=${article} AND j.name IN ('content.analyze','content.extract-body','events.group'))
    OR (${target.kind === 'digest'} AND j.name='events.digest' AND j.data->>'storyId'=${target.kind === 'digest' ? String(target.id) : ''})
    OR (${target.kind === 'report'} AND j.name=${target.kind === 'report' ? `cron.reports.${target.reportKind}` : ''})
    OR (${target.kind === 'monitor'} AND j.name='cron.monitor.tick')) LIMIT 1`;
  return !!row;
}

interface RecoveryRow {
  receipt_id: number; original_attempt: number; batch: string; target_key: string; target: RecoveryTarget;
  state: string; evidence: Record<string, any> | null; authorization: Record<string, any> | null;
}
async function resumeProblem(db: Db, row: RecoveryRow, web: boolean, stopped: boolean): Promise<string | null> {
  if (!web) return '历史脚本批次仅供查看';
  if (row.state !== 'blocked') return '仅调用前中断的条目可继续';
  const grant = row.authorization?.reconsideration;
  if (!grant || grant.batch !== row.batch) return '原授权不存在或已变化';
  if (grant.consumed) return '一次生成额度已消费，不能继续或重新授权';
  if (stopped) return '批次出现新的明确拒绝，已停止后续调用';
  if (!['replay_failed','report_pilot_no_successful_call'].includes(row.evidence?.reason)) return '此停止原因不支持继续，请先核对诊断';
  const [r] = await db<Receipt[]>`SELECT * FROM receipts WHERE id=${row.receipt_id}`;
  if (!r || r.attempts !== row.original_attempt || r.request_id !== grant.requestId || r.logical_key !== grant.logicalKey) return '原请求身份已变化';
  const candidate = await reconsiderationCandidate(db, r, true);
  if (candidate.reason) return candidate.reason;
  if (JSON.stringify(candidate.target) !== row.target_key) return '业务目标已变化';
  if (await activeTarget(db, row.receipt_id, row.target, row.evidence?.jobId)) return '原任务或同一业务目标仍在排队或执行';
  return null;
}

export async function listWebReceiptRecoveries(page = 1) {
  page = Number.isSafeInteger(page) && page > 0 ? page : 1;
  const rows = await sql`SELECT x.batch,min(x.created_at) AS created_at,max(b.actor) AS actor,
    count(*)::int AS total,count(*) FILTER(WHERE x.state='planned')::int AS planned,
    count(*) FILTER(WHERE x.state='queued')::int AS queued,count(*) FILTER(WHERE x.state='recovered')::int AS recovered,
    count(*) FILTER(WHERE x.state='blocked')::int AS blocked,max(b.checked_at) AS checked_at,max(b.runner_error) AS runner_error
    FROM receipt_recoveries x LEFT JOIN receipt_recovery_batches b USING(batch)
    GROUP BY x.batch ORDER BY min(x.created_at) DESC,x.batch LIMIT 20 OFFSET ${(page-1)*20}`;
  const [count] = await sql`SELECT count(DISTINCT batch)::int AS total FROM receipt_recoveries`;
  return { rows, page, total: count!.total as number };
}

export async function webReceiptRecovery(batch: string) {
  const [meta] = await sql`SELECT * FROM receipt_recovery_batches WHERE batch=${batch}`;
  const rows = await sql<RecoveryRow[]>`SELECT x.*,v.evidence AS authorization FROM receipt_recoveries x
    LEFT JOIN receipt_reviews v ON v.receipt_id=x.receipt_id AND v.attempt=x.original_attempt
    WHERE x.batch=${batch} ORDER BY x.receipt_id LIMIT 101`;
  if (!rows.length) return null;
  const stopped = await reconsiderationBatchStopped(sql, batch);
  const items = [];
  for (const row of rows.slice(0,100)) {
    const reason = await resumeProblem(sql,row,!!meta,stopped);
    const t = row.target;
    const [story] = t.kind === 'digest' ? await sql`SELECT public_id FROM stories WHERE id=${t.id}` : [];
    const resultHref = t.kind === 'article' || t.kind === 'group' ? `/admin/content/${encodeURIComponent(t.id)}`
      : t.kind === 'report' ? `/${t.reportKind}/${encodeURIComponent(t.key)}`
      : t.kind === 'monitor' ? '/admin/monitor' : story ? `/story/${encodeURIComponent(story.public_id)}` : null;
    items.push({ resultHref, receiptId: row.receipt_id, attempt: row.original_attempt, target: row.target,
      state: row.state, evidence: row.evidence, consumed: !!row.authorization?.reconsideration?.consumed,
      canResume: !reason, resumeReason: reason });
  }
  return { batch, web: !!meta, actor: meta?.actor ?? null, checkedAt: meta?.checked_at ?? null,
    runnerError: meta?.runner_error ?? null, stopped, items, truncated: rows.length > 100 };
}

export async function resumeWebReceiptRecovery(batch: string, value: unknown, actor: string) {
  batchOf(batch);
  const body = value as { receiptIds?: unknown; note?: unknown } | null;
  const ids = idsOf(body?.receiptIds), note = noteOf(body?.note);
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('receipt-recovery:create'))`;
    const [meta] = await tx`SELECT 1 FROM receipt_recovery_batches WHERE batch=${batch}`;
    if (!meta) throw invalid('历史脚本批次不能从网页续跑');
    await tx`SELECT id FROM receipts WHERE id=ANY(${ids}::bigint[]) ORDER BY id FOR UPDATE`;
    const rows = await tx<RecoveryRow[]>`SELECT x.*,v.evidence AS authorization FROM receipt_recoveries x
      JOIN receipt_reviews v ON v.receipt_id=x.receipt_id AND v.attempt=x.original_attempt
      WHERE x.batch=${batch} AND x.receipt_id=ANY(${ids}::bigint[]) ORDER BY x.receipt_id FOR UPDATE OF x,v`;
    if (rows.length !== ids.length) throw invalid('条目不属于当前批次');
    const stopped = await reconsiderationBatchStopped(tx,batch);
    for (const row of rows) {
      if (row.state === 'planned' && row.evidence?.resumedAt) continue; // duplicate click, no renewed quota
      const reason = await resumeProblem(tx,row,true,stopped);
      if (reason) throw Object.assign(new Error(`回执 ${row.receipt_id}：${reason}`), { code: 'conflict' });
      if (row.target.kind === 'article') {
        await tx`UPDATE articles SET processing_state='failed' WHERE id=${row.target.id}
          AND revision=${row.target.revision} AND managed_backfill_id IS NULL AND processing_state='new'`;
      }
      await tx`INSERT INTO audit_log(actor,action,subject,reason,before,after) VALUES
        (${actor},'receipt.resume_unconsumed',${`receipt:${row.receipt_id}`},${note},${tx.json({ state: row.state, evidence: row.evidence })},${tx.json({ batch, state: 'planned', quotaRenewed: false })})`;
      await tx`UPDATE receipt_recoveries SET state='planned',evidence=coalesce(evidence,'{}'::jsonb) ||
        ${tx.json({ resumedAt: new Date().toISOString(), resumedBy: actor })}
        WHERE receipt_id=${row.receipt_id} AND original_attempt=${row.original_attempt}`;
    }
    return { batch, resumed: rows.length };
  });
}

// Admission never calls a provider. Keep application errors verbatim only when they
// come from our own fixed queue-busy messages; database diagnostics use SQLSTATE.
function runnerDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const busy = [
    'Recovery analysis queue is busy; authorization was not admitted',
    'Recovery group queue is busy; authorization was not admitted',
    'Recovery digest queue is busy; authorization was not admitted',
  ].includes(message);
  const code = (error as { code?: unknown } | null)?.code;
  const sqlstate = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  const stack = error instanceof Error ? error.stack?.split('\n').slice(1,4).map(line => line.match(/([A-Za-z0-9_.-]+\.[cm]?[jt]s:\d+:\d+)/)?.[1]).filter(Boolean).join('\n') : null;
  return { category: busy ? 'queue_busy' : sqlstate ? 'database' : 'runtime',
    message: busy ? message : sqlstate ? `数据库错误 SQLSTATE ${sqlstate}` : '推进异常；错误位置已保存在审计记录',
    sqlstate, stack };
}

/** A finite tick; restarts rediscover persisted web cohorts without browser state. */
export async function advanceWebReceiptRecoveries() {
  const connection = await sql.reserve();
  try {
    const [lock] = await connection`SELECT pg_try_advisory_lock(hashtext('receipt-recovery-script')) AS locked`;
    if (!lock?.locked) return { busy: true, batches: 0 };
    try {
      const batches = await sql`SELECT b.batch FROM receipt_recovery_batches b WHERE EXISTS
        (SELECT 1 FROM receipt_recoveries x WHERE x.batch=b.batch AND x.state IN ('planned','queued'))
        ORDER BY coalesce(b.checked_at,b.created_at),b.batch LIMIT 20`;
      const errors: string[] = [];
      for (const { batch } of batches) {
        try {
          await advanceReceiptRecoveryBatch(batch,4);
          await sql`UPDATE receipt_recovery_batches SET checked_at=now(),runner_error=NULL WHERE batch=${batch}`;
        } catch (error) {
          const diagnostic = runnerDiagnostic(error);
          errors.push(`${batch}: ${diagnostic.message}`);
          await sql`INSERT INTO audit_log(actor,action,subject,reason,after) VALUES
            ('receipt-recovery-worker','receipt.batch_runner_failed',${batch},'批次推进失败，保留授权等待下次检查',${sql.json(diagnostic)})`;
          await sql`UPDATE receipt_recovery_batches SET checked_at=now(),runner_error=${diagnostic.message} WHERE batch=${batch}`;
        }
      }
      if (errors.length) throw new Error(`Receipt recovery admission failed for batches: ${errors.join(', ')}`);
      return { batches: batches.length };
    } finally { await connection`SELECT pg_advisory_unlock(hashtext('receipt-recovery-script'))`; }
  } finally { connection.release(); }
}
