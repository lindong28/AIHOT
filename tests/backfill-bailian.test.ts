import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "@aihot/backend/config";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { cachedPrefilter } from "@aihot/backend/backfill/preparation";
import { preparationArticle } from "@aihot/backend/backfill/preparation-prefilter";
import { PROMPT_VERSIONS, prefilterRequest } from "@aihot/backend/editorial/analyze";
import { MODELS } from "@aihot/backend/providers/llm";
import type { HistoryVersion } from "@aihot/backend/backfill/history-input";
import { sql, closeDb } from "@aihot/backend/db";
import { BAILIAN_QWEN_FALLBACK, bindingRoutes, bindingsIdentity, type BackfillBindings } from "@aihot/backend/backfill/context";
import { bindingsSchema, verifyDiscovery } from "@aihot/backend/backfill/gateway";
import { enableBailianFallback } from "../packages/backend/src/backfill/fallback.ts";
import { prepareGatewayRequest } from "@aihot/backend/providers/gateway";
import { logicalKeyFor, paidRequest, ReceiptUnknownError, ReceiptBusyError, completeReceipt } from "@aihot/backend/providers/receipts";

const models: BackfillBindings = JSON.parse(readFileSync(new URL("../deploy/production/backfill-models.json", import.meta.url), "utf8"));
const original = bindingsIdentity(models) as BackfillBindings;
const revision = "a".repeat(64);
Object.assign(process.env, { LLM_GATEWAY_URL: "http://127.0.0.1:1", LLM_GATEWAY_PROJECT: "fixture" });
after(closeDb);

test("only the approved Qwen subscription fallback passes schema and funding checks", () => {
  assert.ok(bindingsSchema.safeParse(models).success);
  for (const change of [{ route: "personal_dashscope/qwen3.8-flash/stream" }, { provider: "dashscope" },
    { actualModel: "openai/other" }, { credentialProfile: "other" }]) {
    const b = { ...models.prefilter, fallbackRoutes: [{ ...BAILIAN_QWEN_FALLBACK, ...change }] };
    assert.equal(bindingsSchema.safeParse({ ...models, prefilter: b, structure: b }).success, false);
  }
  for (const model of ["qwen3.7-flash", "deepseek-v4.1-flash"]) {
    const b = { ...models.prefilter, model };
    assert.equal(bindingsSchema.safeParse({ ...models, prefilter: b, structure: b }).success, false);
  }
  const view = { projection_version: 2, view_scope: "logical_model", requested_logical_model: "qwen3.8-flash", status: "ready",
    project: { id: "fixture", billing_scope: "personal" }, project_allowed_logical_model_ids: ["qwen3.8-flash"],
    loaded_registry_revision: revision, file_registry_revision: revision,
    routes: bindingRoutes(models.prefilter).map((r, i) => ({ id: r.route, actual_model: r.actualModel, provider_id: r.provider,
      credential_profile_id: r.credentialProfile, funding_source: i ? "personal_subscription" : "personal_paid", effectively_eligible: !!i })) };
  assert.equal(verifyDiscovery(view, "qwen3.8-flash", models, "fixture", "http://127.0.0.1:1"), revision);
  view.routes[1]!.funding_source = "personal_paid";
  assert.throws(() => verifyDiscovery(view, "qwen3.8-flash", models, "fixture", "http://127.0.0.1:1"), /funding/);
});

test("fallback sends both allowed routes and accepts only their exact response identities", async () => {
  const saved = globalThis.fetch;
  let selected = BAILIAN_QWEN_FALLBACK;
  globalThis.fetch = async (_url, init) => {
    const h = new Headers(init!.headers);
    assert.equal(h.get("X-LLM-Allowed-Routes"), JSON.stringify(bindingRoutes(models.prefilter).map(r => r.route)));
    assert.equal(h.get("X-LLM-Route"), null);
    assert.equal(h.get("X-LLM-Registry-Revision"), revision);
    return Response.json({ llm_gateway: { projection_version: 1, logical_request_id: h.get("X-LLM-Request-ID"),
      provider_id: selected.provider, selected_route_id: selected.route, actual_model: selected.actualModel, credential_profile_id: selected.credentialProfile } });
  };
  try {
    const request = () => prepareGatewayRequest("qwen3.8-flash", 1000, { ...models.prefilter, registryRevision: revision })!;
    await request().send("chat/completions", {});
    selected = { ...selected, credentialProfile: "other" };
    await assert.rejects(() => request().send("chat/completions", {}), /route mismatch/);
    selected = { ...models.prefilter.routes![0]!, credentialProfile: "personal_self_hosted" };
    await request().send("chat/completions", {});
  } finally { globalThis.fetch = saved; }
});

test("adding fallback preserves pending/unknown protection and received/completed reuse", async () => {
  for (const outcome of ["pending", "unknown", "received", "completed"] as const) {
    const purpose = "fallback-" + outcome + tag();
    const request = (bindings: BackfillBindings) => {
      const gateway = prepareGatewayRequest("qwen3.8-flash", 1000, { ...bindings.prefilter, registryRevision: revision })!;
      return { service: "backfill", model: "qwen3.8-flash", purpose, identity: { gateway: gateway.identity },
        requestSummary: gateway.summary, gatewayRequestId: gateway.requestId };
    };
    assert.equal(logicalKeyFor(request(original)), logicalKeyFor(request(models)));
    let calls = 0;
    const call = async () => { calls++; if (outcome === "unknown") throw new Error("lost answer"); return { response: { ok: true } }; };
    if (outcome === "unknown") {
      await assert.rejects(() => paidRequest(request(original), call), ReceiptUnknownError);
      await assert.rejects(() => paidRequest(request(models), call), ReceiptUnknownError);
    } else {
      const first = await paidRequest(request(original), call);
      if (outcome === "pending") {
        await sql`UPDATE receipts SET status='pending' WHERE id=${first.receiptId}`;
        await assert.rejects(() => paidRequest(request(models), call), ReceiptBusyError);
      } else {
        if (outcome === "completed") await completeReceipt(sql, first.receiptId);
        const second = await paidRequest(request(models), call);
        assert.equal(second.receiptId, first.receiptId); assert.equal(second.reused, true);
      }
    }
    assert.equal(calls, 1);
  }
});

test("enabling fallback requires paused batch and executor lock; no receipt or item rewrite", async () => {
  const id = randomUUID();
  await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,models,state)
    VALUES (${id},'fallback-test',${tag()},'2026-01-01','2026-01-01',${sql.json(original as never)},'ready')`;
  await assert.rejects(() => enableBailianFallback(id), /Pause/);
  await sql`UPDATE backfill_runs SET state='paused' WHERE id=${id}`;
  for (const state of ["pending", "failed", "published"]) {
    await sql`INSERT INTO backfill_items(run_id,identity_key,material,content_hash,evidence,state,attempts)
      VALUES (${id},${state},'{}','fixture','fixture',${state},1)`;
  }
  const items = await sql`SELECT * FROM backfill_items WHERE run_id=${id} ORDER BY identity_key`;
  const lock = await sql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(hashtext(${'backfill:' + id}))`;
    await assert.rejects(() => enableBailianFallback(id), /executor/);
  } finally { await lock`SELECT pg_advisory_unlock(hashtext(${'backfill:' + id}))`; lock.release(); }
  const [before] = await sql`SELECT * FROM backfill_runs WHERE id=${id}`;
  await enableBailianFallback(id);
  await enableBailianFallback(id);
  const [after] = await sql`SELECT * FROM backfill_runs WHERE id=${id}`;
  assert.deepEqual(after!.models, models);
  assert.deepEqual({ ...after, models: null }, { ...before, models: null });
  assert.deepEqual(await sql`SELECT * FROM backfill_items WHERE run_id=${id} ORDER BY identity_key`, items);
});

test("old preparation cache retains its manifest and receipt identity after fallback expansion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bailian-cache-"));
  process.env.BACKFILL_PREFILTER_CACHE = directory;
  const key = tag(), row = { key, article: { id: key, revision: 1, title: "Fixture", url: "https://example.com/news", author: null,
    publishedAt: "2026-01-01T00:00:00Z", bodyText: "Archived original text.", excerpt: null, xPost: null, media: [],
    source: { name: "Fixture", kind: "feed", tier: "A", firstParty: true } }, provenance: {} };
  const v: HistoryVersion = { key, day: "2026-01-01", provenance: {}, targetUrls: [row.article.url], material: null, context: {},
    prefilter: { row, inputHash: sha256(JSON.stringify(row)) } };
  const request = prefilterRequest(preparationArticle(row));
  const gateway = prepareGatewayRequest("qwen3.8-flash", 120000, { ...original.prefilter, registryRevision: revision })!;
  const response = await paidRequest({ service: "backfill", purpose: request.purpose, model: "qwen3.8-flash",
    identity: { model: "qwen3.8-flash", promptVersion: request.promptVersion, system: sha256(request.system), user: sha256(request.user),
      temperature: request.temperature, maxTokens: request.maxTokens, extra: MODELS["qwen3.8-flash"]!.extra ?? null, gateway: gateway.identity } },
    async () => ({ response: { choices: [{ message: { content: JSON.stringify({ label: "PASS", reason: "fixture" }) } }] } }));
  const manifest = { promptVersion: PROMPT_VERSIONS.prefilter, models: original, environment: { database: sha256(config.databaseUrl),
    gateway: process.env.LLM_GATEWAY_URL, project: "fixture", mode: "stream" } };
  try {
    await mkdir(join(directory, "results"));
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(directory, "results", sha256(key) + ".json"), JSON.stringify({ key, inputHash: v.prefilter!.inputHash,
      manifestHash: sha256(stableJson(manifest)), receiptId: response.receiptId, state: "needs_original", label: "PASS" }));
    assert.equal((await cachedPrefilter(v, models))!.receiptId, response.receiptId);
    await sql`UPDATE receipts SET status='unknown' WHERE id=${response.receiptId}`;
    await assert.rejects(() => cachedPrefilter(v, models), ReceiptUnknownError);
  } finally { delete process.env.BACKFILL_PREFILTER_CACHE; await rm(directory, { recursive: true, force: true }); }
});
