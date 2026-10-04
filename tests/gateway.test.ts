import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { after, afterEach, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { prepareGatewayRequest } from "@aihot/backend/providers/gateway";
import { completeReceipt, GatewayNotDispatchedError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";
import { backfillContext, type BackfillBindings } from "@aihot/backend/backfill/context";

let mode = "ok";
let hits = 0;
let invalidRemaining = 0;
const fixtureErrors: unknown[] = [];
const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
const binding = { model: "gpu-qwen", route: "personal_gpu/qwen/stream", actualModel: "self_hosted/qwen" };
const backfillModels: BackfillBindings = { prefilter: binding, structure: binding, score: binding, understand: binding, summarize: binding };
const server = createServer(async (req, res) => {
  if (req.url === "/api/capabilities") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ retry_policy_versions: [1] }));
    return;
  }
  hits++;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const id = req.headers["x-llm-request-id"];
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-llm-project"], "aihot-test");
    assert.equal(req.headers["x-llm-mode"], "stream");
    assert.match(String(id), /^[0-9a-f-]{36}$/);
    const rows = await sql`SELECT r.request_id, r.request, a.request_id AS attempt_request_id
      FROM receipts r JOIN receipt_attempts a ON a.receipt_id = r.id WHERE a.request_id = ${String(id)}`;
    assert.equal(rows.length, 1, "UUID persisted before sending");
    assert.equal(rows[0]!.request_id, id);
    assert.equal(rows[0]!.request.gateway.logicalRequestId, id);
    assert.equal(body.timeout, undefined, "instance policy replaces per-call timeout");
    const retryPolicy = JSON.parse(String(req.headers["x-llm-retry-policy"]));
    assert.deepEqual(retryPolicy, { version: 1, max_attempts: 3, attempt_timeout_ms: 30000, initial_backoff_ms: 3000 });
    res.setHeader("X-LLM-Retry-Policy", JSON.stringify(retryPolicy));
    assert.equal(body.api_key, undefined);
    if (mode === "disconnect") { req.socket.destroy(); return; }
    if (mode === "http-error") { res.writeHead(503); res.end("upstream uncertain"); return; }
    if (mode.startsWith("cooldown") || mode === "no-route" || mode === "attempt-not-crossed") {
      res.writeHead(mode === "cooldown-wrong-status" ? 502 : 422, {
        "content-type": "application/json", ...(mode === "cooldown-header" ? { "x-llm-gateway-attempt-id": "earlier-attempt" } : {}),
      });
      res.end(JSON.stringify({ error: {
        code: mode === "attempt-not-crossed" ? "dispatch_constraint_rejected" : mode === "no-route" ? "no_route" : "route_cooldown",
        ...(mode === "cooldown-mismatch" ? { logical_request_id: "wrong" } : { logical_request_id: id }),
        ...(mode === "cooldown-companion" ? { llm_gateway: { attempt_id: "earlier-attempt" } } : {}),
        ...(mode === "attempt-not-crossed" ? { dispatch_boundary: "not_crossed" } : {}),
      } }));
      return;
    }
    const pinned = req.headers["x-llm-route"] !== undefined;
    if (pinned) { assert.equal(req.headers["x-llm-route"], binding.route); assert.equal(body.model, binding.model); }
    const companion = { projection_version: 1, logical_request_id: mode.includes("mismatch") ? "wrong" : id, attempt_id: "stub-attempt", retry_policy: retryPolicy,
      provider_id: mode.includes("commercial") ? "deepseek" : mode.includes("no-provider") ? undefined : "self-hosted",
      selected_route_id: mode.includes("wrong-route") ? "other-route" : binding.route,
      actual_model: mode.includes("wrong-model") ? "openai/qwen" : binding.actualModel };
    const invalid = mode === "bad-output" || invalidRemaining-- > 0;
    const result = req.url === "/v1/embeddings"
      ? { data: mode === "bad-embedding" ? [null] : body.input.map((_: string, index: number) => ({ index, embedding: [0.25, 0.75] })).reverse() }
      : { choices: [{ message: { content: invalid ? '{"ok":"not boolean"}' : '{"ok":true}', ...(mode === "refusal" ? { refusal: "cannot comply" } : {}) }, ...(mode === "filtered" ? { finish_reason: "content_filter" } : {}) }] };
    if (mode.startsWith("parse-error")) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "parse_error", llm_gateway: companion }, llm_gateway: companion,
        ...(mode === "parse-error-missing-output" ? {} : { output: { choices: [{ message: { content: "not JSON" } }], usage } }), usage }));
      return;
    }
    if (mode.startsWith("gzip")) {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip",
        ...(mode === "gzip-missing" ? {} : { "X-LLM-Gateway-projection-version": "1",
          "X-LLM-Gateway-Retry-Policy": encodeURIComponent(JSON.stringify(retryPolicy)),
          "X-LLM-Gateway-logical-request-id": encodeURIComponent(mode === "gzip-mismatch" ? "wrong" : String(id)),
          ...(pinned ? { "X-LLM-Gateway-selected-route-id": encodeURIComponent(companion.selected_route_id),
            "X-LLM-Gateway-actual-model": encodeURIComponent(companion.actual_model),
            ...(companion.provider_id ? { "X-LLM-Gateway-provider-id": companion.provider_id } : {}) } : {}) }) });
      res.end(gzipSync(JSON.stringify({ ...result, usage })));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...result, usage, ...(mode === "missing" ? {} : { llm_gateway: companion }) }));
  } catch (error) {
    fixtureErrors.push(error);
    res.writeHead(500); res.end(String(error));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
process.env.LLM_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
process.env.LLM_GATEWAY_PROJECT = "aihot-test";
process.env.LLM_GATEWAY_MODE = "stream";
process.env.LLM_MODEL = "fixture-model";
process.env.EMBEDDING_MODEL = "fixture-embedding";
process.env.EMBEDDING_DIMS = "2";
process.env.EMBEDDINGS_ENABLED = "true";
delete process.env.LLM_API_KEY;
delete process.env.EMBEDDING_API_KEY;
delete process.env.DASHSCOPE_API_KEY;
const { embeddingsAvailable, ensureEmbeddings } = await import("@aihot/backend/providers/embeddings");
config.modelCallsEnabled = true;

afterEach(() => assert.deepEqual(fixtureErrors, [], "the stub accepted the request contract"));

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

const ask = (subject: string) => chatJson({ model: "default", purpose: "gateway_test", subject, promptVersion: "1", system: "return JSON", user: subject, schema: z.object({ ok: z.boolean() }) });
const askBackfill = (subject: string) => backfillContext.run({ runId: "fixture", models: backfillModels, beforeCall: async () => {} },
  () => chatJson({ model: "qwen3.8-flash", purpose: "backfill_gateway_test", subject, promptVersion: "1", system: "return JSON", user: subject, schema: z.object({ ok: z.boolean() }) }));

async function restartedAsk(subject: string): Promise<void> {
  const code = `import { chatJson, ModelOutputError } from '@aihot/backend/providers/llm';
    import { closeDb } from '@aihot/backend/db';
    import { config } from '@aihot/backend/config';
    import { z } from 'zod';
    config.modelCallsEnabled = true;
    try { await chatJson({ model: 'default', purpose: 'gateway_test', subject: process.argv[1], promptVersion: '1', system: 'return JSON', user: process.argv[1], schema: z.object({ok:z.boolean()}) }); process.exitCode = 2; }
    catch (error) { if (!(error instanceof ModelOutputError)) { console.error(error); process.exitCode = 3; } }
    finally { await closeDb(); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, subject], { env: process.env, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(exitCode, 0, stderr);
}

for (const encoding of ["", "gzip-"]) {
  test(`backfill ${encoding || "JSON "}accepts only matching self-hosted identity`, async () => {
    mode = `${encoding}ok`;
    assert.deepEqual((await askBackfill(tag())).data, { ok: true });
    for (const failure of ["commercial", "no-provider", "wrong-route", "wrong-model"]) {
      mode = `${encoding}${failure}`;
      const subject = tag(), before = hits;
      await assert.rejects(askBackfill(subject), ReceiptUnknownError);
      mode = `${encoding}ok`;
      await assert.rejects(askBackfill(subject), ReceiptUnknownError);
      assert.equal(hits - before, 1, "identity failures never replay or fall back");
    }
  });
}

test("Gateway chat needs no provider key, persists identity before send, and reuses receipts", async () => {
  mode = "ok";
  const subject = tag();
  const before = hits;
  const first = await ask(subject);
  assert.deepEqual(first.data, { ok: true });
  assert.equal((await ask(subject)).reused, true);
  assert.equal(hits - before, 1);
  const [row] = await sql`SELECT request_id, response, usage, cost FROM receipts WHERE id = ${first.receiptId}`;
  assert.equal(row!.request_id, row!.response.llm_gateway.logical_request_id);
  assert.equal(row!.usage.total_tokens, 20);
  assert.equal(row!.cost, null);
});

test("JSON validation succeeds on the third generation and retains all responses and usage", async () => {
  mode = "ok";
  invalidRemaining = 2;
  const subject = tag(), before = hits;
  const result = await ask(subject);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(hits - before, 3);
  const attempts = await sql`SELECT request_id, status, response, usage, cost, output_validation_error
    FROM receipt_attempts WHERE receipt_id = ${result.receiptId} ORDER BY attempt`;
  assert.equal(new Set(attempts.map((a) => a.request_id)).size, 3);
  assert.deepEqual(attempts.map((a) => a.status), ["failed", "failed", "received"]);
  assert.deepEqual(attempts.map((a) => a.response.choices[0].message.content), ['{"ok":"not boolean"}', '{"ok":"not boolean"}', '{"ok":true}']);
  assert.deepEqual(attempts.map((a) => a.usage), [usage, usage, usage]);
  assert.deepEqual(attempts.map((a) => a.cost), [null, null, null]);
  await completeReceipt(sql, result.receiptId);
  assert.equal((await ask(subject)).receiptId, result.receiptId);
  assert.equal(hits - before, 3, "business completion keeps the same logical receipt");
});

for (const invalidMode of ["bad-output", "parse-error"]) {
  test(`${invalidMode} exhausts the durable JSON budget and a restarted client sends nothing`, async () => {
    mode = invalidMode;
    const subject = tag(), before = hits;
    await assert.rejects(ask(subject), ModelOutputError);
    assert.equal(hits - before, 3);
    const [receipt] = await sql`SELECT id, status FROM receipts WHERE subject = ${subject}`;
    assert.equal(receipt!.status, "failed");
    const attempts = await sql`SELECT response, usage, cost, output_validation_error FROM receipt_attempts WHERE receipt_id = ${receipt!.id}`;
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every((a) => a.response && a.output_validation_error && a.usage.total_tokens === 20 && a.cost === null));
    // A new instance with changed provider policy must not create a new receipt identity.
    process.env.LLM_GATEWAY_INITIAL_BACKOFF_MS = "4000";
    try {
      mode = "ok";
      await assert.rejects(ask(subject), ModelOutputError);
      await restartedAsk(subject);
      assert.equal(hits - before, 3);
    } finally { delete process.env.LLM_GATEWAY_INITIAL_BACKOFF_MS; }
  });
}

test("application bugs during validation do not regenerate or discard a received response", async () => {
  mode = "ok";
  const subject = tag(), before = hits;
  await assert.rejects(chatJson({ model: "default", purpose: "gateway_test", subject, promptVersion: "1", system: "s", user: subject,
    schema: z.object({ ok: z.boolean() }), parse: () => { throw new TypeError("application bug"); } }), /application bug/);
  assert.equal(hits - before, 1);
  const [receipt] = await sql`SELECT status FROM receipts WHERE subject = ${subject}`;
  assert.equal(receipt!.status, "received");
});

for (const point of ["received", "invalid"]) {
  test(`database failure while saving ${point} stops before another paid generation`, async () => {
    mode = "bad-output";
    const subject = tag(), before = hits;
    await sql.unsafe(`CREATE FUNCTION test_gateway_save_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_ARGV[0] = 'received' AND NEW.status = 'received') OR
           (TG_ARGV[0] = 'invalid' AND NEW.output_validation_error IS NOT NULL) THEN
          RAISE EXCEPTION 'injected receipt persistence failure';
        END IF;
        RETURN NEW;
      END $$`);
    await sql.unsafe(`CREATE TRIGGER test_gateway_save_failure BEFORE UPDATE ON receipt_attempts
      FOR EACH ROW EXECUTE FUNCTION test_gateway_save_failure('${point}')`);
    try {
      await assert.rejects(ask(subject), /injected receipt persistence failure/);
      assert.equal(hits - before, 1);
      const [receipt] = await sql`SELECT r.status, a.response, a.output_validation_error FROM receipts r
        JOIN receipt_attempts a ON a.receipt_id = r.id WHERE r.subject = ${subject}`;
      assert.equal(receipt!.status, point === "received" ? "pending" : "received");
      assert.equal(receipt!.output_validation_error, null);
      if (point === "invalid") assert.equal(receipt!.response.choices[0].message.content, '{"ok":"not boolean"}');
    } finally {
      await sql.unsafe("DROP TRIGGER test_gateway_save_failure ON receipt_attempts");
      await sql.unsafe("DROP FUNCTION test_gateway_save_failure()");
    }
  });
}

test("provider policy is instance-scoped and stays below the pending receipt lease", () => {
  const first = prepareGatewayRequest("fixture-model", 120000)!;
  assert.deepEqual(first.client.retry, { maxAttempts: 3, attemptTimeoutMs: 30000, initialBackoffMs: 3000 });
  assert.equal(first.client.deadlineMs, 160000);
  process.env.LLM_GATEWAY_ATTEMPT_TIMEOUT_MS = "180000";
  try { assert.throws(() => prepareGatewayRequest("fixture-model", 120000), /9-minute/); }
  finally { delete process.env.LLM_GATEWAY_ATTEMPT_TIMEOUT_MS; }
  assert.equal(first.client.retry.attemptTimeoutMs, 30000);
});

for (const failure of ["http-error", "disconnect", "missing", "mismatch", "refusal", "filtered", "parse-error-mismatch", "parse-error-missing-output", "gzip-missing", "gzip-mismatch", "cooldown-wrong-status", "cooldown-mismatch", "cooldown-companion", "cooldown-header", "attempt-not-crossed"]) {
  test(`Gateway ${failure} is held, including after automatic recovery`, async () => {
    mode = failure;
    const subject = tag();
    const before = hits;
    await assert.rejects(ask(subject), ReceiptUnknownError);
    await sql`UPDATE receipts SET updated_at = now() - interval '31 minutes' WHERE subject = ${subject}`;
    await autoReleaseUnknownReceipts();
    mode = "ok";
    await assert.rejects(ask(subject), ReceiptUnknownError);
    assert.equal(hits - before, 1, "no second send");
    const [row] = await sql`SELECT status, request_id FROM receipts WHERE subject = ${subject}`;
    assert.equal(row!.status, "unknown");
    assert.ok(row!.request_id);
  });
}

for (const rejection of ["cooldown", "no-route"]) test(`Gateway whole-request ${rejection} can retry with a NEW UUID and retains the failed attempt`, async () => {
  mode = rejection;
  const subject = tag(), before = hits;
  await assert.rejects(ask(subject), GatewayNotDispatchedError);
  const [first] = await sql`SELECT id, status, request_id FROM receipts WHERE subject = ${subject}`;
  assert.equal(first!.status, "failed");
  mode = "ok";
  const result = await ask(subject);
  assert.equal(result.receiptId, first!.id);
  const attempts = await sql`SELECT status, request_id, cost FROM receipt_attempts WHERE receipt_id = ${result.receiptId} ORDER BY attempt`;
  assert.deepEqual(attempts.map((a) => a.status), ["failed", "received"]);
  assert.notEqual(attempts[0]!.request_id, attempts[1]!.request_id);
  assert.equal(attempts[0]!.cost, null);
  assert.equal(hits - before, 2);
});

test("compressed Gateway chat and embeddings use header identity and retain it in receipts", async () => {
  mode = "gzip";
  const result = await ask(tag());
  assert.deepEqual(result.data, { ok: true });
  const [row] = await sql`SELECT request_id, response FROM receipts WHERE id = ${result.receiptId}`;
  assert.equal(row!.response.llm_gateway.logical_request_id, row!.request_id);
  assert.deepEqual(row!.response.llm_gateway.retry_policy, { version: 1, max_attempts: 3, attempt_timeout_ms: 30000, initial_backoff_ms: 3000 });
  const vectors = await ensureEmbeddings("article", [{ id: tag(), text: tag() }]);
  assert.equal(vectors.size, 1);
});

test("Gateway embeddings preserve input order and cache stored vectors", async () => {
  mode = "ok";
  assert.equal(embeddingsAvailable(), true);
  const items = [{ id: tag(), text: "first" + tag() }, { id: tag(), text: "second" + tag() }];
  const before = hits;
  const vectors = await ensureEmbeddings("article", items);
  assert.deepEqual(vectors.get(items[0]!.id), [0.25, 0.75]);
  assert.equal((await ensureEmbeddings("article", items)).size, 2);
  assert.equal(hits - before, 1);
});

test("unusable Gateway embeddings are held for reconciliation", async () => {
  mode = "bad-embedding";
  const items = [{ id: tag(), text: tag() }];
  const before = hits;
  await assert.rejects(ensureEmbeddings("article", items), ReceiptUnknownError);
  mode = "ok";
  await assert.rejects(ensureEmbeddings("article", items), ReceiptUnknownError);
  assert.equal(hits - before, 1);
});

test("model valve disables both Gateway paths before sending", async () => {
  config.modelCallsEnabled = false;
  const before = hits;
  assert.equal(embeddingsAvailable(), false);
  await assert.rejects(ask(tag()), /disabled/);
  await assert.rejects(ensureEmbeddings("article", [{ id: tag(), text: tag() }]), /disabled/);
  assert.equal(hits, before);
  config.modelCallsEnabled = true;
});
