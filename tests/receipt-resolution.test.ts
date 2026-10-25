import { tag, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@aihot/backend/db";
import { runsOverview, autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";
import { parseChatResponse, chatJson } from "@aihot/backend/providers/llm";
import { config } from "@aihot/backend/config";
import { ensureQueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { reviewReceipt, settleReceiptReviews } from "@aihot/backend/admin/receipt-reviews";
import { receiptOutcome } from "@aihot/backend/providers/receipt-review";
import { paidRequest, logicalKeyFor, ReceiptUnknownError, ReceiptRecoveryStoppedError } from "@aihot/backend/providers/receipts";
import { businessEvidence } from "@aihot/backend/admin/receipt-batch-recovery";

after(async () => { await stopBoss(); await closeDb(); });

test("receipt totals cover more than one issue page", async () => {
  await ensureQueue(QUEUES.analyze);
  const prefix = tag();
  for (let i = 0; i < 45; i++) await sql`INSERT INTO receipts (logical_key,service,purpose,status,attempts)
    VALUES (${`${prefix}:${i}`},'resolution-test','fixture','unknown',1)`;
  const result = await runsOverview();
  assert.equal(result.receipts.issues.length, 40);
  assert.ok((result.receipts as any).issueTotal >= 45, "total must not be the limited page length");
  const next = await runsOverview({ page: 2 });
  assert.ok(next.receipts.issues.length > 0);
  assert.equal(new Set([...result.receipts.issues, ...next.receipts.issues].map(x => x.id)).size, result.receipts.issues.length + next.receipts.issues.length);
});

async function uncertain() {
  const req = { service: 'resolution-test', purpose: 'fixture', subject: tag(), identity: tag(), gatewayRequestId: randomUUID(), requestSummary: { gateway: {} } };
  await assert.rejects(paidRequest(req, async () => { throw new Error('response lost'); }), ReceiptUnknownError);
  const [r] = await sql`SELECT * FROM receipts WHERE logical_key=${logicalKeyFor(req)}`;
  return { id: Number(r!.id), req };
}

test("billing-only, stop and replay have distinct effects; stale and unacknowledged replay are rejected", async () => {
  const r = await uncertain();
  const base = { attempt: 1, billed: null, note: 'fixture reconciliation' };
  const [before] = await sql`SELECT status,cost,usage,response FROM receipt_attempts WHERE receipt_id=${r.id}`;
  await reviewReceipt(r.id, { ...base, action: 'record' }, 'test');
  await assert.rejects(paidRequest(r.req, async () => { assert.fail('billing must not release'); }), ReceiptUnknownError);
  await assert.rejects(reviewReceipt(r.id, { ...base, action: 'replay' }, 'test'), /单独确认/);
  await assert.rejects(reviewReceipt(r.id, { ...base, attempt: 2, action: 'replay', acceptDuplicateCharge: true }, 'test'), /新 attempt/);
  await reviewReceipt(r.id, { ...base, action: 'stop' }, 'test');
  await assert.rejects(paidRequest(r.req, async () => { assert.fail('stopped must not dispatch'); }), ReceiptRecoveryStoppedError);
  await assert.rejects(reviewReceipt(r.id, { ...base, action: 'replay', acceptDuplicateCharge: true }, 'test'), /不能原样重放/);
  assert.deepEqual((await sql`SELECT status,cost,usage,response FROM receipt_attempts WHERE receipt_id=${r.id}`)[0], before);
  const fresh = await uncertain();
  const [original] = await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${fresh.id}`;
  await reviewReceipt(fresh.id, { ...base, action: 'replay', acceptDuplicateCharge: true }, 'test');
  assert.deepEqual((await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${fresh.id}`)[0], original);
  let calls = 0;
  await paidRequest(fresh.req, async () => { calls++; return { response: { ok: true } }; });
  assert.equal(calls, 1);
  assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${fresh.id}`)[0]!.attempts, 2);
  assert.equal((await sql`SELECT billed FROM receipt_reviews WHERE receipt_id=${fresh.id}`)[0]!.billed, null);
});

test("known refusals classify without altering bills; capability failure remains unknown", async () => {
  assert.equal(receiptOutcome({ version: 1, category: 'invalid_request', httpStatus: null }, null), 'unknown');
  assert.equal(receiptOutcome({ version: 1, category: 'invalid_request', httpStatus: 400 }, null), 'invalid_request');
  for (const kind of ['filter', 'invalid']) {
    const r = await uncertain();
    const response = kind === 'filter' ? { choices: [{ finish_reason: 'content_filter', message: { content: '' } }], usage: { total_tokens: 12 } } : null;
    await sql`UPDATE receipt_attempts SET response=${sql.json(response as never)},error_details=${kind === 'invalid' ? sql.json({ version: 1, category: 'invalid_request', httpStatus: 400 }) : null}
      WHERE receipt_id=${r.id}`;
    await assert.rejects(paidRequest(r.req, async () => { assert.fail('rejection must block'); }), ReceiptRecoveryStoppedError);
    const [a] = await sql`SELECT response,cost,status FROM receipt_attempts WHERE receipt_id=${r.id}`;
    assert.deepEqual(a!.response, response); assert.equal(a!.cost, null); assert.equal(a!.status, 'unknown');
    assert.equal((await sql`SELECT outcome FROM receipt_reviews WHERE receipt_id=${r.id}`)[0]!.outcome, kind === 'filter' ? 'content_policy_rejected' : 'invalid_request');
  }
});

test("a current digest closes only failures older than its persisted success", async () => {
  const [s] = await sql`INSERT INTO stories(public_id,title,digest,version) VALUES (${randomUUID()},'fixture','这是一份完整而有效的事件综述。',2) RETURNING id`;
  const success = await uncertain();
  await sql`UPDATE receipts SET status='completed' WHERE id=${success.id}`;
  await sql`INSERT INTO story_digests(story_id,version,digest,receipt_id,created_at)
    VALUES (${s!.id},2,'这是一份完整而有效的事件综述。',${success.id},now()-interval '1 minute')`;
  const old = await uncertain();
  await sql`UPDATE receipts SET purpose='story_digest',subject=${`story:${s!.id}@2`},created_at=now()-interval '2 hours' WHERE id=${old.id}`;
  // Parent predates the success, but this attempt does not: never hide the new failure.
  await settleReceiptReviews();
  assert.equal((await sql`SELECT * FROM receipt_reviews WHERE receipt_id=${old.id}`).length, 0);
  await sql`UPDATE receipt_attempts SET started_at=now()-interval '2 minutes' WHERE receipt_id=${old.id}`;
  const preview = await settleReceiptReviews({ dryRun: true });
  assert.ok(preview.actions.some(x => x.id === old.id && x.disposition === 'superseded'));
  assert.equal((await sql`SELECT * FROM receipt_reviews WHERE receipt_id=${old.id}`).length, 0);
  await settleReceiptReviews();
  assert.equal((await sql`SELECT disposition FROM receipt_reviews WHERE receipt_id=${old.id}`)[0]!.disposition, 'superseded');
  await assert.rejects(paidRequest(old.req, async () => { assert.fail('superseded must not dispatch'); }), ReceiptRecoveryStoppedError);
  await sql`UPDATE receipts SET status='failed' WHERE id=${old.id}`;
  await assert.rejects(paidRequest(old.req, async () => { assert.fail('superseded failed must not dispatch'); }), ReceiptRecoveryStoppedError);
  await sql`UPDATE stories SET version=3 WHERE id=${s!.id}`;
  assert.equal(await businessEvidence(sql, { kind: 'digest', id: Number(s!.id) }, new Date(Date.now()-3600_000)), null);
});

test("digest retries add a compact-output instruction within the same generation budget", async () => {
  const bodies: any[] = [];
  const server = await stub((hit, req) => {
    bodies.push(JSON.parse(req.body));
    return { choices: [{ finish_reason: hit === 1 ? 'length' : 'stop', message: { content: '{"digest":"这是一份压缩后完整返回的事件综述。"}' } }], usage: { total_tokens: 20 } };
  });
  const saved = { enabled: config.modelCallsEnabled, url: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL };
  config.modelCallsEnabled = true;
  process.env.LLM_BASE_URL = server.url; process.env.LLM_API_KEY = 'fixture-key'; process.env.LLM_MODEL = 'fixture';
  try {
    const options = { model: 'default', purpose: 'story_digest', subject: tag(), promptVersion: 'fixture',
      system: '输出事件综述JSON', user: tag(), schema: z.object({ digest: z.string().min(10).max(2000) }), maxTokens: 1200 };
    const result = await chatJson(options);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].messages.length, 2); assert.equal(bodies[1].messages.length, 3);
    assert.match(bodies[1].messages[2].content, /150–400/);
    assert.deepEqual(bodies.map(x => x.max_tokens), [1200, 1200]);
    const attempts = await sql`SELECT output_validation_error,cost FROM receipt_attempts WHERE receipt_id=${result.receiptId} ORDER BY attempt`;
    assert.match(attempts[0]!.output_validation_error, /truncated/); assert.equal(attempts[1]!.cost, null);
    // Re-enter chatJson with no in-memory retry state; durable history supplies the hint.
    await sql`UPDATE receipts SET status='failed' WHERE id=${result.receiptId}`;
    await chatJson(options);
    assert.deepEqual(bodies[2].messages, bodies[1].messages);
    assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${result.receiptId}`)[0]!.attempts, 3);
  } finally {
    config.modelCallsEnabled = saved.enabled;
    for (const [name, value] of [['LLM_BASE_URL',saved.url],['LLM_API_KEY',saved.key],['LLM_MODEL',saved.model]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    await server.close();
  }
});

test("a syntactically valid JSON cut off by the token budget is not accepted", () => {
  assert.throws(() => parseChatResponse({ schema: z.object({ ok: z.boolean() }) }, {
    choices: [{ finish_reason: "length", message: { content: '{"ok":true}' } }],
  }), /truncated.*length/);
  assert.deepEqual(parseChatResponse({ schema: z.object({ ok: z.boolean() }) }, {
    choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
  }), { ok: true });
});


test("old UUID recovery retains its frozen output hint; only a new generation selects feedback", async () => {
  const r = await uncertain();
  await sql`UPDATE receipt_attempts SET output_validation_error='bad JSON' WHERE receipt_id=${r.id}`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,request_id,recovery_action)
    VALUES (${r.id},2,'resolution-test','unknown',${r.req.gatewayRequestId},'retry_same_request')`;
  await sql`UPDATE receipts SET attempts=2 WHERE id=${r.id}`;
  const hints: boolean[] = [];
  await paidRequest({ ...r.req, gatewayRecovery: true }, async (id,hint) => {
    assert.equal(id, r.req.gatewayRequestId); hints.push(!!hint); return { response: { ok: true } };
  });
  assert.deepEqual(hints, [false]);
  await sql`UPDATE receipts SET status='failed' WHERE id=${r.id}`;
  const nextId = randomUUID();
  await paidRequest({ ...r.req, gatewayRequestId: nextId, gatewayRecovery: true }, async (id,hint) => {
    assert.equal(id,nextId); hints.push(!!hint); return { response: { ok: true } };
  });
  assert.deepEqual(hints, [false,true]);
  assert.equal((await sql`SELECT output_retry_hint FROM receipt_attempts WHERE receipt_id=${r.id} AND attempt=3`)[0]!.output_retry_hint,true);
});

test("automatic recovery skips closed rows and releases later eligible rows once without rewriting attempts", async () => {
  const stopped = await uncertain(), eligible = await uncertain();
  for (const r of [stopped,eligible]) await sql`UPDATE receipts SET request='{}',updated_at=now()-interval '1 hour' WHERE id=${r.id}`;
  await reviewReceipt(stopped.id, { attempt: 1, action: 'stop', billed: null, note: 'test stop' }, 'test');
  const [original] = await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${eligible.id}`;
  await autoReleaseUnknownReceipts();
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${stopped.id}`)[0]!.status,'unknown');
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${eligible.id}`)[0]!.status,'failed');
  assert.deepEqual((await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${eligible.id}`)[0],original);
  await sql`UPDATE receipts SET status='unknown',updated_at=now()-interval '1 hour' WHERE id=${eligible.id}`;
  await autoReleaseUnknownReceipts();
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${eligible.id}`)[0]!.status,'unknown');
});

test("malformed review input is a client error", async () => {
  for (const input of [null, {}, { attempt: 0, action: 'record', billed: null, note: 'test' }]) {
    await assert.rejects(reviewReceipt(1, input as any, 'test'), (e: any) => e.statusCode === 400);
  }
});


test("legacy recovered attempts stay closed in history and all replay entry points", async () => {
  const r = await uncertain();
  await sql`INSERT INTO receipt_recoveries(receipt_id,original_attempt,batch,target_key,target,state,note,original_status)
    VALUES (${r.id},1,${tag()},${tag()},'{}','recovered','fixture','unknown')`;
  await assert.rejects(reviewReceipt(r.id, { attempt: 1, action: 'replay', billed: null, note: 'test', acceptDuplicateCharge: true },'test'), /不能原样重放/);
  await assert.rejects(paidRequest(r.req,async()=>{assert.fail('closed attempt must not dispatch');}),ReceiptRecoveryStoppedError);
  const history = await runsOverview({view:'history'});
  assert.equal((history.receipts.issues.find(x=>x.id===r.id) as any)?.business_recovery?.state,'recovered');
  await sql`UPDATE receipt_attempts SET attempt=2 WHERE receipt_id=${r.id}`;
  await sql`UPDATE receipts SET attempts=2 WHERE id=${r.id}`;
  // A different current attempt must not inherit the old business disposition.
  await assert.rejects(paidRequest(r.req,async()=>{assert.fail('unknown must not dispatch');}),ReceiptUnknownError);
});
