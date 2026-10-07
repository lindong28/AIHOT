import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { paidRequest, ReceiptRetryError, ReceiptBusyError, ReceiptRecoveryStoppedError, ReceiptRecoveryExhaustedError, ReceiptUnknownError, rejectReceivedOutput, markStalePendingReceipts } from "@aihot/backend/providers/receipts";
import { GatewayResponseError } from "@aihot/backend/providers/gateway-error";

after(closeDb);
const request = () => ({ service: "recovery-test", purpose: "test", identity: tag(), gatewayRequestId: randomUUID(),
  gatewayRecovery: true, outputMaxAttempts: 3, requestSummary: { gateway: { recoveryVersion: 1 } } });
const failure = (id: string, action: "retry_same_request" | "retry_new_request" = "retry_same_request") =>
  new GatewayResponseError(503, id, { version: 1, httpStatus: 503, providerCode: null, category: "upstream_unavailable", retryable: true },
    "ledger_unavailable", { version: 1, logical_request_id: id, action, retry_after_s: 3 });
const due = () => sql`UPDATE receipts SET retry_after=now()-interval '1 second' WHERE service='recovery-test'`;

test("transient recovery reuses persisted UUID after re-entry and respects backoff", async () => {
  const req = request(); const ids: string[] = [];
  await assert.rejects(paidRequest(req, async id => { ids.push(id!); throw failure(id!); }), ReceiptRetryError);
  const retry = { ...req, gatewayRequestId: randomUUID() };
  await assert.rejects(paidRequest(retry, async () => { throw Error("must wait"); }), ReceiptRetryError);
  await due();
  const result = await paidRequest(retry, async id => { ids.push(id!); return { response: { ok: true }, requestId: id }; });
  assert.deepEqual(ids, [req.gatewayRequestId, req.gatewayRequestId]);
  assert.deepEqual(result.response, { ok: true });
  const rows = await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${result.receiptId}`;
  assert.equal(rows.length, 1, "same logical request is not another paid generation");
  assert.equal(rows[0]!.recovery_sends, 2);
  assert.equal((await sql`SELECT error FROM receipts WHERE id=${result.receiptId}`)[0]!.error, null);
});

test("recovery send budget survives re-entry and terminal exhaustion cannot spin", async () => {
  const req = request(); let calls = 0;
  for (let i=0;i<3;i++) {
    await assert.rejects(paidRequest({ ...req, gatewayRequestId: randomUUID() }, async id => { calls++; throw failure(id!); }),
      i===2 ? ReceiptRecoveryExhaustedError : ReceiptRetryError);
    await due();
  }
  await assert.rejects(paidRequest(req, async () => { calls++; return { response: {} }; }), ReceiptRecoveryExhaustedError);
  assert.equal(calls, 3);
});

test("new generations share the three-generation JSON and transient budget; unknown attempts survive", async () => {
  const req = request(); const ids: string[] = [];
  await assert.rejects(paidRequest(req, async id => { ids.push(id!); throw failure(id!, "retry_new_request"); }), ReceiptRetryError);
  await due();
  const second = await paidRequest({ ...req, gatewayRequestId: randomUUID() }, async id => { ids.push(id!); return { response: { bad: true }, requestId: id }; });
  await rejectReceivedOutput(second.receiptId, second.attemptId, "invalid JSON");
  const third = await paidRequest({ ...req, gatewayRequestId: randomUUID() }, async id => { ids.push(id!); return { response: { bad: true }, requestId: id }; });
  await rejectReceivedOutput(third.receiptId, third.attemptId, "invalid JSON");
  await assert.rejects(paidRequest({ ...req, gatewayRequestId: randomUUID() }, async () => { throw Error("fourth call forbidden"); }), ReceiptRecoveryExhaustedError);
  assert.equal(new Set(ids).size, 3);
  const [first] = await sql`SELECT status,cost FROM receipt_attempts WHERE receipt_id=${third.receiptId} ORDER BY attempt LIMIT 1`;
  assert.equal(first!.status, "unknown"); assert.equal(first!.cost, null);
});

test("non-opted requests retain unknown protection", async () => {
  const req = { ...request(), gatewayRecovery: false };
  await assert.rejects(paidRequest(req, async () => { throw failure(req.gatewayRequestId); }), ReceiptUnknownError);
  await assert.rejects(paidRequest(req, async () => { throw Error("not replayed"); }), ReceiptUnknownError);
});

test("permanent recovery stop is terminal while billing stays unknown", async () => {
  const req = request(); let calls = 0;
  const stopped = new GatewayResponseError(400, req.gatewayRequestId,
    { version: 1, httpStatus: 400, providerCode: "1301", category: "content_policy_rejected", retryable: false },
    "1301", { version: 1, logical_request_id: req.gatewayRequestId, action: "stop", retry_after_s: 0 });
  await assert.rejects(paidRequest(req, async () => { calls++; throw stopped; }), ReceiptRecoveryStoppedError);
  await assert.rejects(paidRequest(req, async () => { calls++; return { response: {} }; }), ReceiptRecoveryStoppedError);
  assert.equal(calls, 1);
  const [attempt] = await sql`SELECT status,cost,recovery_action FROM receipt_attempts WHERE request_id=${req.gatewayRequestId}`;
  assert.equal(attempt!.status, "unknown"); assert.equal(attempt!.cost, null); assert.equal(attempt!.recovery_action, "stop");
});

test("malformed recovery authority cannot trigger another dispatch", async () => {
  for (const projection of [
    { version: 1, logical_request_id: "another-request", action: "retry_same_request", retry_after_s: 3 },
    { version: 1, action: "retry_same_request", retry_after_s: Number.MAX_SAFE_INTEGER },
  ]) {
    const req = request(); let calls = 0;
    const error = new GatewayResponseError(503, req.gatewayRequestId, failure(req.gatewayRequestId).details,
      "ledger_unavailable", { logical_request_id: req.gatewayRequestId, ...projection });
    await assert.rejects(paidRequest(req, async () => { calls++; throw error; }), ReceiptUnknownError);
    await assert.rejects(paidRequest(req, async () => { calls++; return { response: {} }; }), ReceiptUnknownError);
    assert.equal(calls, 1);
  }
});

test("concurrent re-entry cannot dispatch while the receipt lease is active", async () => {
  const req = request();
  let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
  let finish!: () => void; const hold = new Promise<void>(r => { finish = r; });
  const first = paidRequest(req, async id => { entered(); await hold; return { response: {}, requestId: id }; });
  await ready;
  try { await assert.rejects(paidRequest(req, async () => { throw Error("duplicate dispatch"); }), ReceiptBusyError); }
  finally { finish(); await first; }
});

test("stale opted-in placeholders recover the persisted UUID after process loss", async () => {
  const req = request();
  await assert.rejects(paidRequest(req, async id => { throw failure(id!); }), ReceiptRetryError);
  await sql`UPDATE receipts SET status='pending',updated_at=now()-interval '11 minutes',retry_after=NULL WHERE request_id=${req.gatewayRequestId}`;
  await sql`UPDATE receipt_attempts SET recovery_action=NULL WHERE request_id=${req.gatewayRequestId}`;
  const recovered = await paidRequest({ ...req, gatewayRequestId: randomUUID() }, async id => {
    assert.equal(id, req.gatewayRequestId); return { response: { recovered: true }, requestId: id };
  });
  assert.deepEqual(recovered.response, { recovered: true });
});

test("periodic stale sweep preserves opt-in recovery and protects legacy requests", async () => {
  for (const opted of [true,false]) {
    const req = { ...request(), gatewayRecovery: opted, requestSummary: opted ? { gateway: { recoveryVersion: 1 } } : {} };
    await assert.rejects(paidRequest(req, async id => { throw failure(id!); }), opted ? ReceiptRetryError : ReceiptUnknownError);
    await sql`UPDATE receipts SET status='pending',updated_at=now()-interval '11 minutes',retry_after=NULL WHERE request_id=${req.gatewayRequestId}`;
    await sql`UPDATE receipt_attempts SET status='pending',recovery_action=NULL WHERE request_id=${req.gatewayRequestId}`;
    await markStalePendingReceipts();
    let called = false;
    const result = paidRequest({ ...req, gatewayRecovery: true, gatewayRequestId: randomUUID() }, async id => {
      called=true; assert.equal(id,req.gatewayRequestId); return { response:{ok:true},requestId:id };
    });
    if (opted) assert.deepEqual((await result).response,{ok:true});
    else await assert.rejects(result,ReceiptUnknownError);
    assert.equal(called,opted);
  }
});
