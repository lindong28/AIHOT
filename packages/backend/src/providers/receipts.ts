// Paid requests (models, SocialData, Jina, Dajiala) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. A request whose outcome is unknown (timeout after sending, crash mid-flight) is not re-sent by the
//    caller. Gateway requests require reconciliation; legacy direct-provider requests may be
//    released once after 30 minutes by ops.recover (admin/runs.ts).
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { GatewayResponseError, safeGatewayFailure } from "./gateway-error.ts";

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
  /** Application generation budget; persisted invalid outputs count across worker restarts. */
  outputMaxAttempts?: number;
}

export interface ReceiptResult {
  receiptId: number;
  response: unknown;
  reused: boolean;
  attemptId: number;
}

const PENDING_STALE_MS = 10 * 60 * 1000;

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
 * Runs a paid request at most once per logical key and returns its raw response.
 * The caller parses the response and commits business results, then calls completeReceipt.
 */
export async function paidRequest(req: ReceiptRequest, call: () => Promise<CallOutcome>): Promise<ReceiptResult> {
  const logicalKey = logicalKeyFor(req);
  if (req.outputMaxAttempts !== undefined && (!Number.isSafeInteger(req.outputMaxAttempts) || req.outputMaxAttempts < 1)) {
    throw new Error("outputMaxAttempts must be a positive integer");
  }

  const claimed = await sql.begin(async (tx) => {
    // Serialise budget checks per service so concurrent workers cannot overshoot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + req.service}))`;
    const [existing] = await tx<ReceiptRow[]>`
      SELECT id, status, response, created_at, updated_at FROM receipts WHERE logical_key = ${logicalKey} FOR UPDATE`;
    if (existing) {
      if (existing.status === "received" || existing.status === "completed") {
        const [attempt] = await tx<{ id: number }[]>`SELECT id FROM receipt_attempts WHERE receipt_id = ${existing.id} ORDER BY attempt DESC LIMIT 1`;
        if (!attempt) throw new Error(`Receipt ${existing.id} has no attempt record`);
        return { kind: "reuse" as const, row: existing, attemptId: attempt.id };
      }
      if (existing.status === "pending") {
        if (Date.now() - existing.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: existing };
        await markUnknown(tx, existing.id, "placeholder went stale without a recorded result");
        return { kind: "unknown" as const, row: existing };
      }
      if (existing.status === "unknown") return { kind: "unknown" as const, row: existing };
      if (req.outputMaxAttempts !== undefined) {
        const [invalid] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM receipt_attempts
          WHERE receipt_id = ${existing.id} AND output_validation_error IS NOT NULL`;
        if (invalid!.count >= req.outputMaxAttempts) throw new ReceiptOutputExhaustedError(existing.id, req.outputMaxAttempts);
      }
      // failed: the provider did not take the request, or its answer was unusable; a new attempt is allowed.
      await checkBudget(tx, req.service);
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL,
          request_id = ${req.gatewayRequestId ?? null}, request = ${tx.json((req.requestSummary ?? {}) as never)}, updated_at = now()
        WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req);
      return { kind: "call" as const, id: existing.id, attemptId };
    }
    await checkBudget(tx, req.service);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, request_id, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json((req.requestSummary ?? {}) as never)}, ${req.gatewayRequestId ?? null}, 1)
      RETURNING id`;
    const attemptId = await startAttempt(tx, row!.id, 1, req);
    return { kind: "call" as const, id: row!.id, attemptId };
  });

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, response: claimed.row.response, reused: true, attemptId: claimed.attemptId };
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(claimed.row.id, `Receipt ${claimed.row.id} has an unknown outcome; reconcile it before retrying`);
  }

  const { id: receiptId, attemptId } = claimed;
  const started = Date.now();
  let outcome: CallOutcome;
  try {
    outcome = await call();
  } catch (error) {
    const rejected = req.gatewayRequestId
      ? error instanceof GatewayNotDispatchedError && error.requestId === req.gatewayRequestId
      : error instanceof ProviderRejectedError;
    const status = rejected ? "failed" : "unknown";
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    const message = (error instanceof ProviderRejectedError ? error.message : String(error)).slice(0, 2000);
    await sql.begin(async (tx) => {
      await tx`UPDATE receipts SET status = ${status}, error = ${message}, updated_at = now() WHERE id = ${receiptId}`;
      const details = error instanceof GatewayResponseError ? safeGatewayFailure(error.details) : null;
      await tx`UPDATE receipt_attempts SET status = ${status}, error = ${message}, error_details = ${tx.json(details as never)}, latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId}`;
    });
    if (req.gatewayRequestId && !rejected) throw new ReceiptUnknownError(receiptId, `Gateway request ${req.gatewayRequestId}: ${message}`);
    throw error;
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE receipts SET
        status = 'received',
        response = ${tx.json((outcome.response ?? null) as never)},
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

async function startAttempt(tx: Db, receiptId: number, attempt: number, req: ReceiptRequest): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, request_id)
    VALUES (${receiptId}, ${attempt}, ${req.service}, ${req.model ?? null}, 'pending', ${req.gatewayRequestId ?? null})
    RETURNING id`;
  return row!.id;
}

async function markUnknown(tx: Db, receiptId: number, reason: string) {
  await tx`UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now() WHERE id = ${receiptId}`;
  await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now() WHERE receipt_id = ${receiptId} AND status = 'pending'`;
}

/**
 * Placeholders left behind by a process that stopped mid-request (crash, kill) become "unknown", so
 * they are released like any other unknown outcome even when nothing retries them.
 */
export async function markStalePendingReceipts(): Promise<number> {
  const stale = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE status = 'pending' AND updated_at < ${new Date(Date.now() - PENDING_STALE_MS)}`;
  for (const r of stale) await sql.begin((tx) => markUnknown(tx, r.id, "placeholder went stale without a recorded result"));
  return stale.length;
}

export async function completeReceipt(db: Db, receiptId: number): Promise<void> {
  await db`UPDATE receipts SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now() WHERE id = ${receiptId}`;
}

/** Marks a received response that could not be used (e.g. unparsable) so a fresh attempt can be made. */
export async function rejectReceivedResponse(receiptId: number, reason: string, reconcile = false): Promise<void> {
  await sql`UPDATE receipts SET status = ${reconcile ? "unknown" : "failed"}, error = ${reason.slice(0, 2000)}, updated_at = now() WHERE id = ${receiptId}`;
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
