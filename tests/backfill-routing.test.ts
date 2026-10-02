import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { bindingsSchema, preflightBackfill, verifyDiscovery } from "@aihot/backend/backfill/gateway";
import { prepareGatewayRequest } from "@aihot/backend/providers/gateway";
import type { BackfillBindings } from "@aihot/backend/backfill/context";
import { closeDb } from "@aihot/backend/db";
import { paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";

const gpu = { route: "gpu/qwen/stream", actualModel: "self_hosted/qwen", provider: "self-hosted", credentialProfile: "gpu" };
const glmGpu = { ...gpu, route: "gpu/glm/stream", actualModel: "self_hosted/glm" };
const zai = { route: "personal_zai/glm/stream", actualModel: "openai/glm", provider: "zhipu", credentialProfile: "personal_zai" };
const ark = { ...zai, route: "personal_ark/glm/stream", provider: "volcengine-ark", credentialProfile: "personal_ark" };
const qwen = { model: "qwen", routes: [gpu] };
const glm = { model: "glm-flash", routes: [glmGpu, zai, ark] };
const tencent = { route: "company_tencent_vod/deepseek-v4.1-flash/stream", actualModel: "openai/deepseek-v4.1-flash", provider: "tencent-vod", credentialProfile: "company_tencent_vod" };
const deepseek = { model: "deepseek-v4.1-flash", routes: [tencent] };
const models: BackfillBindings = { prefilter: qwen, structure: qwen, score: glm, understand: glm, summarize: deepseek };
const revision = "a".repeat(64);
function view(model: string) {
  return { projection_version: 2, view_scope: "logical_model", requested_logical_model: model, status: "ready",
    project: { id: "fixture", billing_scope: ["personal", "company"] }, project_allowed_logical_model_ids: [model],
    loaded_registry_revision: revision, file_registry_revision: revision,
    routes: (model === "qwen" ? [gpu] : model === deepseek.model ? [tencent] : [glmGpu, zai, ark]).map((r) => ({ id: r.route, actual_model: r.actualModel,
      provider_id: r.provider, credential_profile_id: r.credentialProfile, funding_source: r === tencent ? "company_paid" : r === zai || r === ark ? "personal_subscription" : "personal_paid",
      effectively_eligible: r !== glmGpu })),
  };
}
let selected = zai, hits = 0, stale = false;
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url?.startsWith("/v1/discovery?")) {
    assert.equal(req.headers["x-llm-project"], "fixture");
    res.end(JSON.stringify(view(new URL(req.url, "http://fixture").searchParams.get("model")!))); return;
  }
  if (req.url === "/health") { res.end(JSON.stringify({ status: "ok", loaded_registry_revision: stale ? "changed" : revision, file_registry_revision: revision })); return; }
  hits++;
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const binding = body.model === deepseek.model ? deepseek : glm;
  assert.equal(body.model, binding.model); assert.equal(body.enable_thinking, false);
  assert.equal(req.headers["x-llm-route"], undefined);
  assert.equal(req.headers["x-llm-allowed-routes"], JSON.stringify(binding.routes.map((r) => r.route)));
  assert.equal(req.headers["x-llm-registry-revision"], revision);
  res.end(JSON.stringify({ llm_gateway: { projection_version: 1, logical_request_id: req.headers["x-llm-request-id"],
    provider_id: selected.provider, credential_profile_id: selected.credentialProfile, selected_route_id: selected.route, actual_model: selected.actualModel } }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
Object.assign(process.env, { LLM_GATEWAY_URL: baseUrl, LLM_GATEWAY_PROJECT: "fixture" });
delete process.env.LLM_GATEWAY_CLI;
after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await closeDb(); });

test("GLM subscription fallback is role/profile bounded; Qwen and summaries cannot use subscriptions", () => {
  assert.ok(bindingsSchema.safeParse(models).success);
  for (const role of ["prefilter", "structure", "summarize"]) {
    assert.equal(bindingsSchema.safeParse({ ...models, [role]: glm }).success, false);
  }
  for (const candidate of [{ ...zai, credentialProfile: "other_account" }, { ...zai, provider: "paid" }]) {
    assert.equal(bindingsSchema.safeParse({ ...models, score: { ...glm, routes: [candidate] } }).success, false);
  }
});

test("production summaries require exactly Tencent VOD V4.1 and reject old, mixed or reassigned routes", () => {
  const production = JSON.parse(readFileSync(new URL("../deploy/production/backfill-models.json", import.meta.url), "utf8"));
  assert.ok(bindingsSchema.safeParse(production).success);
  assert.deepEqual(production.summarize, deepseek);
  for (const summarize of [qwen, glm, { ...deepseek, model: "deepseek-v4-flash-0731" },
    { ...deepseek, routes: [tencent, gpu] }, ...[
      { provider: "deepseek" }, { credentialProfile: "personal_deepseek" },
      { actualModel: "openai/deepseek-v4-flash" }, { route: "other/deepseek-v4.1-flash/stream" },
    ].map((change) => ({ ...deepseek, routes: [{ ...tencent, ...change }] }))]) {
    assert.equal(bindingsSchema.safeParse({ ...models, summarize }).success, false);
  }
  assert.equal(bindingsSchema.safeParse({ ...models, score: { ...glm, model: deepseek.model } }).success, false);
});

test("Tencent discovery preserves company funding and requires Gateway project eligibility", () => {
  assert.equal(verifyDiscovery(view(deepseek.model), deepseek.model, models, "fixture", baseUrl), revision);
  for (const billing_scope of ["personal", "company", [], ["personal"], ["personal", "company", "company"], ["personal", "unknown"]]) {
    assert.throws(() => verifyDiscovery({ ...view(deepseek.model), project: { id: "fixture", billing_scope } }, deepseek.model, models, "fixture", baseUrl));
  }
  assert.equal(verifyDiscovery({ ...view("qwen"), project: { id: "fixture", billing_scope: "personal" } }, "qwen", models, "fixture", baseUrl), revision);
  for (const change of [
    { funding_source: "personal_paid" }, { funding_source: "personal_subscription" },
    { project_allowed: false }, { policy_allowed: false }, { effectively_eligible: false },
    { provider_id: "deepseek" }, { credential_profile_id: "personal_deepseek" }, { actual_model: "openai/deepseek-v4-flash" },
  ]) {
    const d = view(deepseek.model);
    Object.assign(d.routes[0]!, change);
    assert.throws(() => verifyDiscovery(d, deepseek.model, models, "fixture", baseUrl));
  }
});

test("DeepSeek transport sends the Tencent-only allowlist and rejects other response identities", async () => {
  const ready = await preflightBackfill(models);
  selected = tencent;
  await prepareGatewayRequest(deepseek.model, 1000, ready.models.summarize)!.send("chat/completions", { enable_thinking: false });
  for (const wrong of [zai, { ...tencent, credentialProfile: "other_account" }, { ...tencent, actualModel: "openai/deepseek-v4-flash" }]) {
    selected = wrong;
    await assert.rejects(() => prepareGatewayRequest(deepseek.model, 1000, ready.models.summarize)!.send("chat/completions", { enable_thinking: false }), /route mismatch/);
  }
  selected = zai;
});

test("discovery accepts an unavailable GPU plus eligible subscription and rejects funding/revision/identity drift", () => {
  assert.equal(verifyDiscovery(view("glm-flash"), "glm-flash", models, "fixture", baseUrl), revision);
  for (const change of ["funding", "actual", "profile", "revision", "unavailable"]) {
    const d = view("glm-flash");
    if (change === "funding") d.routes[1]!.funding_source = "personal_paid";
    if (change === "actual") d.routes[1]!.actual_model = "openai/other";
    if (change === "profile") d.routes[1]!.credential_profile_id = "other_account";
    if (change === "revision") d.loaded_registry_revision = "changed";
    if (change === "unavailable") d.routes.forEach((r) => { r.effectively_eligible = false; });
    assert.throws(() => verifyDiscovery(d, "glm-flash", models, "fixture", baseUrl));
  }
});

test("remote HTTP preflight binds revision; transport sends one constrained request and validates Zai/Ark identities", async () => {
  const ready = await preflightBackfill(models);
  for (const candidate of [zai, ark]) {
    selected = candidate;
    const before = hits;
    await prepareGatewayRequest("glm-flash", 1000, ready.models.score)!.send("chat/completions", { enable_thinking: false });
    assert.equal(hits - before, 1);
  }
  selected = { ...zai, credentialProfile: "other_account" };
  await assert.rejects(() => prepareGatewayRequest("glm-flash", 1000, ready.models.score)!.send("chat/completions", { enable_thinking: false }), /route mismatch/);
  assert.throws(() => prepareGatewayRequest("glm-flash", 1000, glm), /verified Gateway registry revision/);
  stale = true; await assert.rejects(ready.check, /configuration changed/); stale = false;
});

test("registry edits cannot bypass unknown receipts or discard settled answers", async () => {
  const purpose = `registry-recovery-${tag()}`;
  for (const outcome of ["unknown", "received"]) {
    let calls = 0;
    const call = async () => { calls++; if (outcome === "unknown") throw new Error("answer lost after dispatch"); return { response: { ok: true } }; };
    const request = (registryRevision: string) => {
      const gateway = prepareGatewayRequest("glm-flash", 1000, { ...glm, registryRevision })!;
      assert.equal(gateway.summary.registryRevision, registryRevision);
      return { service: "backfill", model: "glm-flash", purpose: purpose + outcome,
        identity: { gateway: gateway.identity }, requestSummary: gateway.summary, gatewayRequestId: gateway.requestId };
    };
    if (outcome === "unknown") {
      await assert.rejects(() => paidRequest(request(revision), call), ReceiptUnknownError);
      await assert.rejects(() => paidRequest(request("b".repeat(64)), call), ReceiptUnknownError);
    } else {
      const first = await paidRequest(request(revision), call);
      const next = await paidRequest(request("b".repeat(64)), call);
      assert.equal(next.receiptId, first.receiptId);
      assert.equal(next.reused, true);
    }
    assert.equal(calls, 1, `${outcome} must not dispatch twice after a registry edit`);
  }
});
