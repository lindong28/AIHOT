import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "../db.ts";
import { receiptOutcome } from "./receipt-review.ts";

export interface ReconsiderationRef { receiptId: number; attempt: number }
export const reconsiderationContext = new AsyncLocalStorage<ReconsiderationRef>();
export function withReconsideration<T>(ref: ReconsiderationRef | undefined, run: () => Promise<T>): Promise<T> {
  return ref ? reconsiderationContext.run(ref, run) : run();
}

export interface ReconsiderationGrant {
  batch: string; requestId: string; logicalKey: string;
  gateway: Record<string, unknown>;
  consumed?: { receiptId: number; attempt: number; requestId: string | null; logicalKey: string };
}

export function reconsiderationGateway(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recovery Gateway identity is missing');
  const { logicalRequestId: _requestId, ...identity } = value as Record<string, unknown>;
  if (!identity.baseUrl || !identity.project || !identity.model || !identity.mode) throw new Error('Recovery Gateway identity is incomplete');
  return identity;
}

/** The service budget lock serializes this claim with normal paid requests. */
export async function loadReconsideration(db: Db, req: { service: string; model?: string | null; purpose: string; subject?: string | null; requestSummary?: Record<string, unknown> }) {
  const ref = reconsiderationContext.getStore();
  if (!ref) return null;
  const [row] = await db`SELECT r.*,v.disposition,v.evidence FROM receipts r
    JOIN receipt_reviews v ON v.receipt_id=r.id AND v.attempt=${ref.attempt}
    WHERE r.id=${ref.receiptId} FOR UPDATE OF v`;
  const grant = row?.evidence?.reconsideration as ReconsiderationGrant | undefined;
  if (!row || !grant) throw new Error("Recovery authorization is missing");
  if (req.purpose !== row.purpose) return null; // later business stages retain their ordinary budgets
  if (!isDeepStrictEqual(grant.gateway, reconsiderationGateway(req.requestSummary?.gateway))) throw new Error('Recovery Gateway route or configuration changed');
  const [recovery] = await db`SELECT state FROM receipt_recoveries WHERE receipt_id=${ref.receiptId} AND original_attempt=${ref.attempt} AND batch=${grant.batch}`;
  if (req.service !== row.service || (req.model ?? null) !== row.model || req.subject !== row.subject
    || recovery?.state !== 'queued' || (!grant.consumed && row.status !== 'failed')
    || ['stopped','superseded'].includes(row.disposition)
    || (row.attempts !== ref.attempt && !(grant.consumed?.receiptId === row.id && grant.consumed?.attempt === row.attempts))) {
    throw new Error("Recovery identity or disposition changed");
  }
  const article = /^article:([^:@]+)(?:@(\d+)|:fact:\d+)?$/.exec(row.subject ?? '');
  if (article) {
    const [current] = await db`SELECT revision FROM articles WHERE id=${article[1]!}`;
    if (!current || (article[2] && current.revision !== Number(article[2]))) throw new Error('Recovery article revision changed');
    const related = await db`SELECT a.error_details,a.error,a.response,v.disposition FROM receipts r
      JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts
      LEFT JOIN receipt_reviews v ON v.receipt_id=r.id AND v.attempt=r.attempts
      WHERE r.subject=${`article:${article[1]}`} OR r.subject LIKE ${`article:${article[1]}@%`} OR r.subject LIKE ${`article:${article[1]}:fact:%`}`;
    if (related.some(a => receiptOutcome(a.error_details,a.error,a.response)==='content_policy_rejected' || a.disposition==='stopped')) throw new Error('Recovery article has a stopped or policy-rejected dependency');
  }
  return { ref, grant, evidence: row.evidence };
}

export async function reconsiderationBatchStopped(db: Db, batch: string): Promise<boolean> {
  const rows = await db`SELECT a.error_details,a.error,a.response FROM receipt_reviews v
    JOIN receipt_attempts a ON a.receipt_id=(v.evidence->'reconsideration'->'consumed'->>'receiptId')::bigint
      AND a.attempt=(v.evidence->'reconsideration'->'consumed'->>'attempt')::int
    WHERE v.evidence->'reconsideration'->>'batch'=${batch}`;
  return rows.some(r => receiptOutcome(r.error_details,r.error,r.response) !== 'unknown');
}

export async function consumeReconsideration(db: Db, authorization: NonNullable<Awaited<ReturnType<typeof loadReconsideration>>>, actual: NonNullable<ReconsiderationGrant['consumed']>) {
  if (authorization.grant.consumed) throw new Error("The authorized generation has already been consumed");
  const { ref, grant, evidence } = authorization;
  if (!actual.requestId || actual.requestId === grant.requestId) throw new Error('A new generation requires a fresh Gateway request UUID');
  if (await reconsiderationBatchStopped(db,grant.batch)) throw new Error('Recovery batch stopped after a new rejection');
  await db`UPDATE receipt_reviews SET evidence=${db.json({ ...evidence, reconsideration: { ...grant, consumed: actual } })},updated_at=now()
    WHERE receipt_id=${ref.receiptId} AND attempt=${ref.attempt}`;
}
