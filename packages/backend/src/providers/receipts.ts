// Paid requests (models, SocialData, Jina, Dajiala) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. Opted-in Gateway recovery reuses the original UUID with durable, bounded sends.
//    A fresh generation requires explicit recovery authority and shares the JSON attempt budget.
//    Other unknown calls still require reconciliation or the legacy direct-provider policy.
import { sql, type Db } from "../db.ts";
import { config } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { GatewayResponseError, imageRequestRejected, safeGatewayFailure } from "./gateway-error.ts";
import { receiptOutcome, recordReceiptOutcome } from "./receipt-review.ts";

export class BudgetExceededError extends Error {
  readonly service: string;
  readonly retryAfterSeconds: number;
  constructor(service: string, window: string, retryAfterSeconds: number) {
    super(`Budget for ${service} exhausted (${window})`);
    this.service = service;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ReceiptBusyError extends Error {}

export class ReceiptRetryError extends ReceiptBusyError {
  readonly receiptId: number;
  readonly retryAfterSeconds: number;
  constructor(receiptId: number, retryAfterSeconds: number) {
    super(`Receipt ${receiptId} will recover after ${retryAfterSeconds}s`);
    this.receiptId = receiptId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ReceiptOutputExhaustedError extends Error {
  readonly receiptId: number;
  readonly maxAttempts: number;
  constructor(receiptId: number, maxAttempts: number) {
    super(`Receipt ${receiptId} exhausted its ${maxAttempts} output validation attempts`);
    this.receiptId = receiptId;
    this.maxAttempts = maxAttempts;
  }
}

export class ReceiptUnknownError extends Error {
  readonly receiptId: number;
  constructor(receiptId: number, message: string) {
    super(message);
    this.receiptId = receiptId;
  }
}

/** Raised by a call when the provider clearly did not accept (and will not bill) the request. */
export class ProviderRejectedError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/** A recovery stop says nothing about whether earlier provider work was charged. */
export class ReceiptRecoveryStoppedError extends Error {
  readonly receiptId: number;
  constructor(receiptId: number, reason = "stopped") {
    super(`Receipt ${receiptId} automatic recovery ${reason}; prior usage and unknown costs are retained`);
    this.receiptId = receiptId;
  }
}

export class ReceiptRecoveryExhaustedError extends ReceiptRecoveryStoppedError {
  constructor(receiptId: number) { super(receiptId, "exhausted"); }
}

/** A whole Gateway logical request was rejected before any provider attempt. */
export class GatewayNotDispatchedError extends ProviderRejectedError {
  readonly requestId: string;
  constructor(requestId: string, message: string) {
    super(message, 422, true);
    this.requestId = requestId;
  }
}

export interface CallOutcome {
  response: unknown;
  requestId?: string | null;
  usage?: Record<string, unknown> | null;
  cost?: { amount: number; currency: string; basis: "actual" | "estimated" } | null;
}

export interface ReceiptRequest {
  service: string;
  model?: string | null;
  purpose: string;
  subject?: string | null;
  /** Everything that determines the output. Hashed into the logical key; only a redacted summary is stored. */
  identity: unknown;
  /** Stored for diagnosis; must not contain secrets. */
  requestSummary?: Record<string, unknown>;
  /** Distinguishes an explicit re-run (e.g. admin "re-evaluate") from recovery of the same request. */
  attemptTag?: string;
  /** Gateway UUID, persisted before dispatch; unknown outcomes require reconciliation. */
  gatewayRequestId?: string;
  /** Versioned Gateway recovery; callers must negotiate before dispatch. */
  gatewayRecovery?: boolean;
  /** Application generation budget; persisted invalid outputs count across worker restarts. */
  outputMaxAttempts?: number;
  /** Text-only continuation of this exact image-rejected attempt. */
  imageFallbackFrom?: { id: number; attempt: number };
}

export interface ReceiptResult {
  receiptId: number;
  response: unknown;
  reused: boolean;
  attemptId: number;
}

const PENDING_STALE_MS = 10 * 60 * 1000;
const MAX_RECOVERY_SENDS = 3;

export function logicalKeyFor(req: ReceiptRequest): string {
  const identity = sha256(stableJson(req.identity));
  return [req.service, req.purpose, req.model ?? "-", identity, req.attemptTag ?? "0"].join(":");
}

interface ReceiptRow {
  id: number;
  status: string;
  response: unknown;
  created_at: Date;
  updated_at: Date;
}

async function checkBudget(tx: Db, service: string): Promise<void> {
  const [budget] = await tx<{ per_minute: number; per_hour: number; per_day: number }[]>`
    SELECT per_minute, per_hour, per_day FROM budgets WHERE service = ${service}`;
  if (!budget) return; // default rows come with the migrations; a service an operator removed is unlimited
  if (budget.per_minute <= 0 || budget.per_hour <= 0 || budget.per_day <= 0) {
    throw new BudgetExceededError(service, "stopped", 3600);
  }
  // The limit-th newest attempt must expire before another fits. This also handles a lowered
  // limit and several exhausted windows; releasing a minute slot does not release an hour slot.
  const [blocked] = await tx<{ window: string; seconds: number }[]>`
    SELECT w.name AS window, ceil(extract(epoch FROM a.started_at + make_interval(secs => w.seconds) - now()))::int AS seconds
    FROM (VALUES ('minute', 60, ${budget.per_minute}::int), ('hour', 3600, ${budget.per_hour}::int),
                 ('day', 86400, ${budget.per_day}::int)) AS w(name, seconds, capacity)
    CROSS JOIN LATERAL (
      SELECT started_at FROM receipt_attempts WHERE service = ${service} AND origin = 'live'
        AND started_at > now() - make_interval(secs => w.seconds)
      ORDER BY started_at DESC OFFSET w.capacity - 1 LIMIT 1
    ) a ORDER BY seconds DESC LIMIT 1`;
  if (blocked) throw new BudgetExceededError(service, blocked.window, Math.max(1, blocked.seconds));
}

/**
 * Reuses settled results and bounds opted-in recovery of the same logical key.
 * The caller parses the response and commits business results, then calls completeReceipt.
 */
export async function paidRequest(req: ReceiptRequest, call: (requestId?: string, outputRetry?: boolean) => Promise<CallOutcome>): Promise<ReceiptResult> {
  const logicalKey = logicalKeyFor(req);
  if (req.outputMaxAttempts !== undefined && (!Number.isSafeInteger(req.outputMaxAttempts) || req.outputMaxAttempts < 1)) {
    throw new Error("outputMaxAttempts must be a positive integer");
  }

  const claimed = await sql.begin(async (tx) => {
    // Serialise budget checks per service so concurrent workers cannot overshoot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + req.service}))`;
    let imageParentKey: string | undefined;
    if (req.imageFallbackFrom) {
      const from = req.imageFallbackFrom;
      const [parent] = await tx`SELECT * FROM receipts WHERE id=${from.id} FOR UPDATE`;
      const [attempt] = await tx`SELECT a.error_details,v.disposition,
        EXISTS(SELECT 1 FROM receipt_recoveries x WHERE x.receipt_id=a.receipt_id AND x.original_attempt=a.attempt AND x.state='recovered') AS recovered
        FROM receipt_attempts a LEFT JOIN receipt_reviews v ON v.receipt_id=a.receipt_id AND v.attempt=a.attempt
        WHERE a.receipt_id=${from.id} AND a.attempt=${from.attempt}`;
      if (!parent || parent.attempts !== from.attempt || parent.subject !== req.subject || parent.purpose !== 'understand_article'
        || req.purpose !== parent.purpose || parent.logical_key === logicalKey || !['unknown','failed'].includes(parent.status)
        || ['stopped','superseded'].includes(attempt?.disposition) || attempt?.recovered || !imageRequestRejected(attempt?.error_details)) {
        throw new ReceiptRecoveryStoppedError(from.id, 'image continuation no longer permitted');
      }
      imageParentKey = parent.logical_key;
    }
    // A corrected article keeps compatible stage identities, even if settings change after preview.
    const corrections = req.subject ? await tx`SELECT v.receipt_id,v.attempt,v.evidence,r.purpose
      FROM receipt_reviews v JOIN receipts r ON r.id=v.receipt_id
      WHERE r.subject=${req.subject} AND v.attempt=r.attempts AND v.disposition='open' AND v.evidence ? 'plannedRequests'` : [];
    let continuationLimit = req.imageFallbackFrom ? req.outputMaxAttempts : undefined;
    for (const correction of corrections) {
      const rootTag = req.purpose === 'prefilter_article' ? req.attemptTag ?? null : req.attemptTag?.split(':').slice(0,-1).join(':') || null;
      if (correction.evidence.rootAttemptTag !== rootTag) continue;
      const stages = correction.evidence.plannedRequests as Array<{ stage:string; logicalKey:string }>;
      const stage = req.imageFallbackFrom ? 'understand-text' : req.purpose === 'score_article' ? req.attemptTag?.split(':').at(-1) : req.purpose.replace('_article','');
      const expected = stages.find(s=>s.stage===stage);
      if (expected && expected.logicalKey!==logicalKey) throw new ReceiptRecoveryStoppedError(Number(correction.receipt_id), 'input changed after correction preview');
      if (correction.evidence.targetLogicalKey===logicalKey || correction.evidence.targetLogicalKey===imageParentKey) continuationLimit=Math.min(continuationLimit ?? 3, (req.outputMaxAttempts ?? 3)-Number(correction.attempt));
    }
    const [existing] = await tx<(ReceiptRow & { attempts: number; request_id: string | null; retry_after: Date | null; recovery_exhausted: boolean })[]>`
      SELECT id, status, response, created_at, updated_at, attempts, request_id, retry_after, recovery_exhausted
      FROM receipts WHERE logical_key = ${logicalKey} FOR UPDATE`;
    if (existing) {
      const [current] = await tx`SELECT a.*,v.disposition,v.outcome,
        EXISTS (SELECT 1 FROM receipt_attempts p WHERE p.receipt_id=a.receipt_id AND p.output_validation_error IS NOT NULL) AS output_retry
        FROM receipt_attempts a
        LEFT JOIN receipt_reviews v ON v.receipt_id=a.receipt_id AND v.attempt=a.attempt
        WHERE a.receipt_id=${existing.id} AND a.attempt=${existing.attempts}`;
      const [recovered] = await tx`SELECT 1 FROM receipt_recoveries WHERE receipt_id=${existing.id} AND original_attempt=${existing.attempts} AND state='recovered'`;
      const known = receiptOutcome(current?.error_details, current?.error ?? null, current?.response ?? existing.response);
      if (recovered || ['stopped','superseded'].includes(current?.disposition) || known !== 'unknown') {
        await recordReceiptOutcome(tx, existing.id, existing.attempts, known);
        return { kind: "stopped" as const, row: existing };
      }
      if (existing.status === "received" || existing.status === "completed") {
        // A separate statement sees the attempt committed by a writer we waited for above.
        const [attempt] = await tx<{ id: number; response: unknown }[]>`
          SELECT id,response FROM receipt_attempts WHERE receipt_id = ${existing.id} AND attempt = ${existing.attempts}`;
        if (!attempt) throw new Error(`Receipt ${existing.id} has no attempt record`);
        return { kind: "reuse" as const, row: { ...existing, response: existing.response ?? attempt.response }, attemptId: attempt.id };
      }
      if (existing.status === "pending") {
        if (Date.now() - existing.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: existing };
        await markUnknown(tx, existing.id, "placeholder went stale without a recorded result");
        existing.status = "unknown";
      }
      if (req.gatewayRecovery && existing.recovery_exhausted) throw new ReceiptRecoveryExhaustedError(existing.id);
      if (req.gatewayRecovery && existing.retry_after && existing.retry_after.getTime() > Date.now()) {
        throw new ReceiptRetryError(existing.id, Math.max(1, Math.ceil((existing.retry_after.getTime()-Date.now())/1000)));
      }
      if (existing.status === "unknown") {
        const [prior] = await tx<{ id: number; recovery_action: string | null; recovery_sends: number }[]>`
          SELECT id,recovery_action,recovery_sends FROM receipt_attempts WHERE receipt_id=${existing.id} AND attempt=${existing.attempts}`;
        if (req.gatewayRecovery && prior?.recovery_action === "stop") throw new ReceiptRecoveryStoppedError(existing.id);
        if (!req.gatewayRecovery || !prior || !existing.request_id ||
            !["retry_same_request", "retry_new_request"].includes(prior.recovery_action ?? "")) return { kind: "unknown" as const, row: existing };
        if (prior.recovery_action === "retry_same_request") {
          if (prior.recovery_sends >= MAX_RECOVERY_SENDS) throw new ReceiptRecoveryExhaustedError(existing.id);
          await tx`UPDATE receipts SET status='pending',retry_after=NULL,updated_at=now() WHERE id=${existing.id}`;
          await tx`UPDATE receipt_attempts SET recovery_sends=recovery_sends+1 WHERE id=${prior.id}`;
          return { kind: "call" as const, id: existing.id, attemptId: prior.id, requestId: existing.request_id, outputRetry: !!current?.output_retry_hint };
        }
        // A fresh generation is allowed only by explicit Gateway evidence. The
        // earlier attempt remains unknown, including any unknown provider cost.
      }
      if (continuationLimit !== undefined && existing.attempts >= continuationLimit) throw new ReceiptRecoveryExhaustedError(existing.id);
      if (req.gatewayRecovery && existing.attempts >= (req.outputMaxAttempts ?? 3)) throw new ReceiptRecoveryExhaustedError(existing.id);
      if (req.outputMaxAttempts !== undefined) {
        const [invalid] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM receipt_attempts
          WHERE receipt_id = ${existing.id} AND output_validation_error IS NOT NULL`;
        if (invalid!.count >= req.outputMaxAttempts) throw new ReceiptOutputExhaustedError(existing.id, req.outputMaxAttempts);
      }
      // failed: the provider did not take the request, or its answer was unusable; a new attempt is allowed.
      await checkBudget(tx, req.service);
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL,
          request_id = ${req.gatewayRequestId ?? null}, request = ${tx.json((req.requestSummary ?? {}) as never)}, retry_after=NULL, updated_at = now()
        WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req, !!current?.output_retry);
      return { kind: "call" as const, id: existing.id, attemptId, requestId: req.gatewayRequestId, outputRetry: !!current?.output_retry };
    }
    if (continuationLimit !== undefined && continuationLimit < 1) throw new ReceiptRecoveryStoppedError(Number(corrections[0]?.receipt_id), 'correction generation allowance exhausted');
    await checkBudget(tx, req.service);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, request_id, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json((req.requestSummary ?? {}) as never)}, ${req.gatewayRequestId ?? null}, 1)
      RETURNING id`;
    const attemptId = await startAttempt(tx, row!.id, 1, req);
    return { kind: "call" as const, id: row!.id, attemptId, requestId: req.gatewayRequestId, outputRetry: false };
  });

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, response: claimed.row.response, reused: true, attemptId: claimed.attemptId };
  if (claimed.kind === "stopped") throw new ReceiptRecoveryStoppedError(claimed.row.id);
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(claimed.row.id, `Receipt ${claimed.row.id} has an unknown outcome; reconcile it before retrying`);
  }

  const { id: receiptId, attemptId, requestId } = claimed;
  const started = Date.now();
  let outcome: CallOutcome;
  try {
    outcome = await call(requestId ?? undefined, claimed.outputRetry);
  } catch (error) {
    const rejected = requestId
      ? error instanceof GatewayNotDispatchedError && error.requestId === requestId
      : error instanceof ProviderRejectedError;
    const status = rejected ? "failed" : "unknown";
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    const message = (error instanceof ProviderRejectedError ? error.message : String(error)).slice(0, 2000);
    let retrySeconds: number | null = null;
    let exhausted = false;
    let stopped = false;
    await sql.begin(async (tx) => {
      const recovery = req.gatewayRecovery && error instanceof GatewayResponseError && error.recovery?.logical_request_id === requestId ? error.recovery : null;
      stopped = recovery?.action === "stop";
      const [attempt] = await tx`SELECT recovery_sends,attempt FROM receipt_attempts WHERE id=${attemptId}`;
      const details = error instanceof GatewayResponseError ? safeGatewayFailure(error.details) : null;
      const known = receiptOutcome(details, message);
      stopped ||= known !== "unknown";
      if (recovery && recovery.action !== 'stop' && !stopped) {
        exhausted = recovery.action === 'retry_same_request' ? attempt!.recovery_sends >= MAX_RECOVERY_SENDS : attempt!.attempt >= (req.outputMaxAttempts ?? 3);
        if (!exhausted) retrySeconds = Math.max(recovery.retry_after_s, 3 * 2 ** (attempt!.recovery_sends-1));
      }
      await tx`UPDATE receipts SET status = ${status}, error = ${message},
        retry_after=${retrySeconds === null ? null : new Date(Date.now()+retrySeconds*1000)},
        recovery_exhausted=${exhausted}, updated_at = now() WHERE id = ${receiptId}`;
      await tx`UPDATE receipt_attempts SET status = ${status}, error = ${message}, error_details = ${tx.json(details as never)},
        recovery_action=${stopped ? "stop" : recovery?.action ?? null}, latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId}`;
      await recordReceiptOutcome(tx, receiptId, attempt!.attempt, known);
    });
    if (exhausted) throw new ReceiptRecoveryExhaustedError(receiptId);
    if (stopped) throw new ReceiptRecoveryStoppedError(receiptId);
    if (retrySeconds !== null) throw new ReceiptRetryError(receiptId, retrySeconds);
    if (req.gatewayRequestId && !rejected) throw new ReceiptUnknownError(receiptId, `Gateway request ${req.gatewayRequestId}: ${message}`);
    throw error;
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE receipts SET
        status = 'received',
        error = NULL, retry_after = NULL, recovery_exhausted = false,
        response = ${config.receiptSingleCopy ? null : tx.json((outcome.response ?? null) as never)},
        request_id = ${outcome.requestId ?? null},
        usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        cost = ${outcome.cost?.amount ?? null},
        currency = ${outcome.cost?.currency ?? null},
        cost_basis = ${outcome.cost?.basis ?? null},
        received_at = now(),
        updated_at = now()
      WHERE id = ${receiptId}`;
    await tx`
      UPDATE receipt_attempts SET
        status = 'received', request_id = ${outcome.requestId ?? null}, usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        response = ${tx.json((outcome.response ?? null) as never)},
        cost = ${outcome.cost?.amount ?? null}, currency = ${outcome.cost?.currency ?? null}, cost_basis = ${outcome.cost?.basis ?? null},
        latency_ms = ${Date.now() - started}, finished_at = now()
      WHERE id = ${attemptId}`;
  });
  return { receiptId, response: outcome.response, reused: false, attemptId };
}

async function startAttempt(tx: Db, receiptId: number, attempt: number, req: ReceiptRequest, outputRetry = false): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, request_id, output_retry_hint)
    VALUES (${receiptId}, ${attempt}, ${req.service}, ${req.model ?? null}, 'pending', ${req.gatewayRequestId ?? null}, ${outputRetry})
    RETURNING id`;
  return row!.id;
}

async function markUnknown(tx: Db, receiptId: number, reason: string) {
  const [row] = await tx`UPDATE receipts SET status='unknown',error=${reason},updated_at=now()
    WHERE id=${receiptId} AND status='pending' AND updated_at<${new Date(Date.now()-PENDING_STALE_MS)}
    RETURNING attempts, request->'gateway'->>'recoveryVersion' AS recovery_version`;
  if (!row) return false;
  // Both worker re-entry and the periodic sweeper preserve the original replay identity.
  await tx`UPDATE receipt_attempts SET status='unknown',error=${reason},finished_at=now(),
    recovery_action=CASE WHEN ${row.recovery_version === '1'} AND recovery_action IS NULL THEN 'retry_same_request' ELSE recovery_action END
    WHERE receipt_id=${receiptId} AND attempt=${row.attempts} AND status IN ('pending','unknown')`;
  return true;
}

/**
 * Placeholders left behind by a process that stopped mid-request (crash, kill) become "unknown", so
 * they are released like any other unknown outcome even when nothing retries them.
 */
export async function markStalePendingReceipts(): Promise<number> {
  const stale = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE status = 'pending' AND updated_at < ${new Date(Date.now() - PENDING_STALE_MS)}`;
  let marked = 0;
  for (const r of stale) if (await sql.begin((tx) => markUnknown(tx, r.id, "placeholder went stale without a recorded result"))) marked++;
  return marked;
}

export async function completeReceipt(db: Db, receiptId: number): Promise<void> {
  await db`UPDATE receipts SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now() WHERE id = ${receiptId}`;
}

/** Marks a received response that could not be used (e.g. unparsable) so a fresh attempt can be made. */
export async function rejectReceivedResponse(receiptId: number, reason: string, reconcile = false): Promise<void> {
  await sql`UPDATE receipts SET status = ${reconcile ? "unknown" : "failed"}, error = ${reason.slice(0, 2000)}, updated_at = now() WHERE id = ${receiptId}`;
}

/** Refusal is a known response, not an authorization to pay for another generation. */
export async function rejectReceivedContent(receiptId: number, attemptId: number): Promise<void> {
  await sql.begin(async tx => {
    const [r] = await tx`SELECT attempts,status FROM receipts WHERE id=${receiptId} FOR UPDATE`;
    const [a] = await tx`SELECT attempt FROM receipt_attempts WHERE id=${attemptId} AND receipt_id=${receiptId}`;
    if (!r || !a || r.attempts !== a.attempt || r.status !== 'received') throw new ReceiptBusyError("Receipt changed during refusal classification");
    await recordReceiptOutcome(tx, receiptId, a.attempt, "content_policy_rejected");
    await tx`UPDATE receipts SET error='Model refused the requested content',retry_after=NULL WHERE id=${receiptId}`;
    await tx`UPDATE receipt_attempts SET error='Model refused the requested content',recovery_action='stop'
      WHERE id=${attemptId}`;
  });
}

/** Fence validation to the received attempt, retaining its response and unknown cost. */
export async function rejectReceivedOutput(receiptId: number, attemptId: number, reason: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [receipt] = await tx`SELECT status, attempts FROM receipts WHERE id = ${receiptId} FOR UPDATE`;
    const [attempt] = await tx`SELECT attempt, output_validation_error FROM receipt_attempts
      WHERE id = ${attemptId} AND receipt_id = ${receiptId}`;
    if (!receipt || !attempt || receipt.attempts !== attempt.attempt) throw new ReceiptBusyError(`Receipt ${receiptId} changed during validation`);
    if (receipt.status === "failed" && attempt.output_validation_error !== null) return;
    if (receipt.status !== "received") throw new ReceiptBusyError(`Receipt ${receiptId} is no longer awaiting validation`);
    const message = reason.slice(0, 2000);
    await tx`UPDATE receipt_attempts SET output_validation_error = ${message}, error = ${message}, status = 'failed' WHERE id = ${attemptId}`;
    await tx`UPDATE receipts SET status = 'failed', error = ${message}, updated_at = now() WHERE id = ${receiptId}`;
  });
}
