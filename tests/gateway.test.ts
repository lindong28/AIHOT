import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { after, afterEach, test } from "node:test";
import { z } from "zod";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";

let mode = "ok";
let hits = 0;
const fixtureErrors: unknown[] = [];
const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
const server = createServer(async (req, res) => {
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
    assert.ok(body.timeout > 0 && body.timeout <= 180);
    assert.equal(body.api_key, undefined);
    if (mode === "disconnect") { req.socket.destroy(); return; }
    if (mode === "http-error") { res.writeHead(503); res.end("upstream uncertain"); return; }
    const companion = { projection_version: 1, logical_request_id: mode === "mismatch" ? "wrong" : id, attempt_id: "stub-attempt" };
    const result = req.url === "/v1/embeddings"
      ? { data: mode === "bad-embedding" ? [null] : body.input.map((_: string, index: number) => ({ index, embedding: [0.25, 0.75] })).reverse() }
      : { choices: [{ message: { content: mode === "bad-output" ? '{"ok":"not boolean"}' : '{"ok":true}' } }] };
    if (mode.startsWith("gzip")) {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip",
        ...(mode === "gzip-missing" ? {} : { "X-LLM-Gateway-projection-version": "1",
          "X-LLM-Gateway-logical-request-id": encodeURIComponent(mode === "gzip-mismatch" ? "wrong" : String(id)) }) });
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

for (const failure of ["http-error", "disconnect", "missing", "mismatch", "bad-output", "gzip-missing", "gzip-mismatch"]) {
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

test("compressed Gateway chat and embeddings use header identity and retain it in receipts", async () => {
  mode = "gzip";
  const result = await ask(tag());
  assert.deepEqual(result.data, { ok: true });
  const [row] = await sql`SELECT request_id, response FROM receipts WHERE id = ${result.receiptId}`;
  assert.equal(row!.response.llm_gateway.logical_request_id, row!.request_id);
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
