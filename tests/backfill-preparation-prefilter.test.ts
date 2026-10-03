// Offline tests: model, receipt and lock operations use in-memory substitutes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runPreparationPrefilter, durableJson, type PreparationRuntime, type PreparationResult } from "@aihot/backend/backfill/preparation-prefilter";
import { backfillContext } from "@aihot/backend/backfill/context";
import { BudgetExceededError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { MAX_BODY_CHARS } from "@aihot/backend/editorial/writing";
import { sha256 } from "@aihot/backend/lib/ids";
const qwen = { model: "qwen-test", routes: [{ route: "gpu/qwen/stream", actualModel: "self_hosted/qwen", provider: "self-hosted", credentialProfile: "gpu" }] };
const deepseek = { model: "deepseek-v4.1-flash", routes: [{ route: "company_tencent_vod/deepseek-v4.1-flash/stream", actualModel: "openai/deepseek-v4.1-flash", provider: "tencent-vod", credentialProfile: "company_tencent_vod" }] };
const models = { prefilter: qwen, structure: qwen, score: deepseek, understand: deepseek, summarize: deepseek };
function row(key: string, title = "PASS", body: string | null = "Existing feed excerpt") {
  return { key, article: { id: "same-old-id", revision: 1, title, url: "https://example.com/article", author: null, publishedAt: "2026-05-01T00:00:00Z",
    bodyText: body, excerpt: null, xPost: null as Record<string, any> | null, media: [], source: { name: "fixture", kind: "feed", tier: "A", firstParty: true } }, provenance: { legacyId: "same-old-id", version: key } };
}
async function fixture(rows: ReturnType<typeof row>[]) {
  const directory = await mkdtemp(join(tmpdir(), "aihot-preparation-test-"));
  const input = join(directory, "input.jsonl"), output = join(directory, "out");
  await writeFile(input, rows.map(x => JSON.stringify(x)).join("\n") + "\n");
  let locked = false, calls = 0, completions = 0;
  const receipts = new Map<string, number>();
  const runtime: PreparationRuntime = {
    promptVersion: "fixture-v1", environment: { fixture: true }, save: durableJson,
    lock: async () => { if (locked) return null; locked = true; return { check: async () => {}, release: async () => { locked = false; } }; },
    preflight: async () => ({ models, check: async () => {} }),
    prefilter: async (a, opts) => {
      assert.deepEqual(opts, {}); assert.equal(a.bodyText, null); assert.equal(a.bodyStatus, "unconfirmed");
      assert.equal(backfillContext.getStore()!.models.prefilter.model, "qwen-test");
      await backfillContext.getStore()!.beforeCall("prefilter_article", "qwen-test");
      const old = receipts.get(a.id); if (!old) receipts.set(a.id, ++calls);
      return { label: a.title as "PASS" | "BLOCK" | "UNKNOWN", reason: "fixture", model: "qwen-test", receiptId: receipts.get(a.id)!, reused: !!old };
    },
    settle: async (id) => {
      const saved = await results(output);
      assert.ok(saved.some(r => r.receiptId === id && r.receiptCompleted === false), "business result is on disk before completing receipt");
      completions++;
    },
  };
  const options = { input, output, models, concurrency: 2, maxItems: 20, seconds: 10 };
  return { input, output, runtime, options, counts: () => ({ calls, completions }) };
}
async function results(output: string): Promise<PreparationResult[]> {
  return Promise.all((await readdir(join(output, "results"))).filter(f => f.endsWith(".json")).map(async f => JSON.parse(await readFile(join(output, "results", f), "utf8"))));
}
test("PASS/BLOCK/UNKNOWN/title-only, multiversion keys and idempotent rerun", async () => {
  const f = await fixture([row("version-a", "PASS"), row("../version-b", "BLOCK"), row("version-c", "UNKNOWN"), row("title-only", "BLOCK", null)]);
  const first = await runPreparationPrefilter(f.options, f.runtime);
  assert.deepEqual([first.status, first.total, first.filtered, first.needsOriginal, first.unresolvedErrors], ["complete", 4, 1, 3, 0]);
  assert.deepEqual(f.counts(), { calls: 3, completions: 3 });
  const title = (await results(f.output)).find(r => r.key === "title-only")!;
  assert.deepEqual([title.label, title.receiptId, title.reason], [null, null, "missing_evidence"]);
  assert.ok((await readdir(join(f.output, "results"))).every(n => /^[a-f0-9]{64}\.json$/.test(n)));
  const second = await runPreparationPrefilter(f.options, f.runtime);
  assert.equal(second.skippedExisting, 4); assert.deepEqual(f.counts(), { calls: 3, completions: 3 });
});
test("X quoted material survives and native body truncation cannot filter", async () => {
  const x = row("x", "PASS", null); x.article.xPost = { text: "main", quoted: { text: "quoted AI launch", handle: "source" } };
  const f = await fixture([row("long", "BLOCK", "a".repeat(MAX_BODY_CHARS + 1)), x]);
  const prefilter = f.runtime.prefilter;
  f.runtime.prefilter = async (a, opts) => { if (a.title === "PASS") assert.equal(a.xPost?.quoted.text, "quoted AI launch"); return prefilter(a, opts); };
  const r = await runPreparationPrefilter(f.options, f.runtime);
  assert.equal(r.filtered, 0); assert.equal(r.needsOriginal, 2);
  const long = (await results(f.output)).find(r => r.key === "long")!;
  assert.equal(long.nativeLabel, "BLOCK"); assert.equal(long.label, "UNKNOWN");
});
test("frozen input, prompt or raw bindings changes reject without another request", async () => {
  const f = await fixture([row("one")]); await runPreparationPrefilter(f.options, f.runtime);
  await assert.rejects(runPreparationPrefilter(f.options, { ...f.runtime, promptVersion: "fixture-v2" }), /Frozen/);
  await assert.rejects(runPreparationPrefilter({ ...f.options, models: { ...models, prefilter: { ...qwen, model: "other" }, structure: { ...qwen, model: "other" } } }, f.runtime), /Frozen/);
  await writeFile(f.input, JSON.stringify(row("changed")) + "\n");
  await assert.rejects(runPreparationPrefilter(f.options, f.runtime), /Frozen/); assert.equal(f.counts().calls, 1);
});
test("budget exhaustion stops claims; unknown/model errors persist across rounds", async () => {
  const f = await fixture([row("unknown"), row("error"), row("budget"), row("later")]);
  const original = f.runtime.prefilter; let attempts = 0;
  f.runtime.prefilter = async (a, opts) => {
    attempts++;
    if (a.id.endsWith(sha256("unknown"))) throw new ReceiptUnknownError(77, "private upstream text");
    if (a.id.endsWith(sha256("error"))) throw new Error("private upstream text");
    if (a.id.endsWith(sha256("budget"))) throw new BudgetExceededError("backfill", "minute", 12);
    return original(a, opts);
  };
  const a = await runPreparationPrefilter({ ...f.options, concurrency: 1 }, f.runtime);
  assert.equal(a.status, "waiting_budget"); assert.equal(a.unresolvedErrors, 2); assert.equal(attempts, 3);
  assert.equal((await results(f.output)).length, 2);
  f.runtime.prefilter = original;
  const b = await runPreparationPrefilter(f.options, f.runtime);
  assert.equal(b.status, "needs_attention"); assert.equal(b.unresolvedErrors, 2); assert.equal(b.needsOriginal, 2);
  assert.equal(f.counts().calls, 2); assert.ok(!JSON.stringify(await results(f.output)).includes("private upstream"));
});
test("received response before durable output reuses the same request after crash", async () => {
  const f = await fixture([row("one")]); const save = f.runtime.save; let fail = true;
  f.runtime.save = async (path, value) => { if (fail && path.includes("/results/")) { fail = false; throw new Error("disk interrupted"); } await save(path, value); };
  await assert.rejects(runPreparationPrefilter(f.options, f.runtime), /disk interrupted/);
  assert.deepEqual(f.counts(), { calls: 1, completions: 0 });
  const resumed = await runPreparationPrefilter(f.options, f.runtime);
  assert.equal(resumed.status, "complete"); assert.deepEqual(f.counts(), { calls: 1, completions: 1 });
  assert.equal((await results(f.output))[0].reused, true);
});
test("durable result resumes same receipt; unknown is never completed", async () => {
  const f = await fixture([row("one")]); const settle = f.runtime.settle;
  f.runtime.settle = async () => { throw new Error("DB interrupted"); };
  await assert.rejects(runPreparationPrefilter(f.options, f.runtime), /DB interrupted/);
  assert.equal((await results(f.output))[0].receiptCompleted, false);
  f.runtime.settle = settle;
  await runPreparationPrefilter(f.options, f.runtime); assert.equal(f.counts().calls, 1); assert.equal(f.counts().completions, 1);
  const g = await fixture([row("two")]); g.runtime.settle = async id => { throw new ReceiptUnknownError(id, "needs reconciliation"); };
  const r = await runPreparationPrefilter(g.options, g.runtime); assert.equal(r.unresolvedErrors, 1);
  await runPreparationPrefilter(g.options, g.runtime); assert.equal(g.counts().calls, 1); assert.equal(g.counts().completions, 0);
});
test("same-directory reentry is locked while durable output is unfinished", async () => {
  const f = await fixture([row("one"), row("two")]); let release!: () => void, started!: () => void;
  const pending = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { started = r; });
  const save = f.runtime.save;
  f.runtime.save = async (p, v) => { if (p.includes("/results/")) { started(); await pending; } await save(p, v); };
  const first = runPreparationPrefilter({ ...f.options, maxItems: 1 }, f.runtime); await entered;
  const second = await runPreparationPrefilter(f.options, f.runtime); assert.equal(second.status, "locked"); assert.equal(f.counts().completions, 0);
  release(); assert.equal((await first).status, "bounded"); assert.equal(f.counts().calls, 1);
});
test("real native prefilter uses backfill receipts and preserves missingEvidence guard offline", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const script = `
    import assert from 'node:assert/strict'; import {mock} from 'node:test';
    globalThis.fetch=()=>{throw new Error('network forbidden')};
    const receipts=await import('./packages/backend/src/providers/receipts.ts');let requests=[];
    mock.module('./packages/backend/src/providers/receipts.ts',{namedExports:{...receipts,paidRequest:async(req,call)=>{requests.push(req);return {receiptId:91,response:(await call()).response,reused:false}}}});
    mock.module('./packages/backend/src/providers/gateway.ts',{namedExports:{gatewayConfigured:()=>true,prepareGatewayRequest:()=>({identity:{fixture:true},summary:{},requestId:'fixture',send:async()=>({choices:[{message:{content:JSON.stringify({label:'BLOCK',reason:'fixture'})}}]})})}});
    const {runPrefilter}=await import('./packages/backend/src/editorial/analyze.ts');
    const {backfillContext}=await import('./packages/backend/src/backfill/context.ts');
    const a=${JSON.stringify(row("native", "Title", null).article)};a.publishedAt=new Date(a.publishedAt);
    const result=await backfillContext.run({runId:'fixture',models:${JSON.stringify(models)},beforeCall:async()=>{}},()=>runPrefilter(a,{}));
    assert.equal(result.label,'UNKNOWN');assert.equal(requests.length,1);assert.equal(requests[0].service,'backfill');assert.equal(requests[0].purpose,'prefilter_article');assert.equal(requests[0].attemptTag,undefined);
  `;
  const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", script], { cwd: root, env: { ...process.env, MODEL_CALLS_ENABLED: "true" }, encoding: "utf8", timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
});

test("prefilter preflight discovers only Qwen but still verifies routes and revisions", async () => {
  const { preflightPreparationPrefilter } = await import("@aihot/backend/backfill/gateway");
  const originalFetch = globalThis.fetch;
  const names = ["LLM_GATEWAY_URL", "LLM_GATEWAY_PROJECT", "LLM_GATEWAY_CLI"];
  const previous = Object.fromEntries(names.map(n => [n, process.env[n]]));
  process.env.LLM_GATEWAY_URL = "http://fixture.invalid"; process.env.LLM_GATEWAY_PROJECT = "fixture"; delete process.env.LLM_GATEWAY_CLI;
  const calls: string[] = []; let wrongRoute = false;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const value = String(url); calls.push(value);
    if (value.endsWith("/health")) return Response.json({ status: "ok", file_registry_revision: "revision", loaded_registry_revision: "revision" });
    assert.ok(value.includes("model=qwen-test"), "unused DeepSeek is not discovered");
    return Response.json({ projection_version: 2, view_scope: "logical_model", requested_logical_model: qwen.model, status: "ready",
      project: { id: "fixture", billing_scope: "personal" }, project_allowed_logical_model_ids: [qwen.model], loaded_registry_revision: "revision", file_registry_revision: "revision",
      routes: qwen.routes.map(r => ({ id: r.route, actual_model: wrongRoute ? "wrong" : r.actualModel, provider_id: r.provider, credential_profile_id: r.credentialProfile, effectively_eligible: true })) });
  }) as typeof fetch;
  try {
    const ready = await preflightPreparationPrefilter(models); await ready.check();
    assert.equal(calls.filter(u=>u.includes("/v1/discovery")).length,1);
    assert.equal(ready.models.prefilter.registryRevision,"revision"); assert.equal(ready.models.score.registryRevision,undefined);
    wrongRoute=true; await assert.rejects(preflightPreparationPrefilter(models),/route identity/);
  } finally { globalThis.fetch=originalFetch; for(const n of names) { if(previous[n]===undefined) delete process.env[n]; else process.env[n]=previous[n]; } }
});

test("a completed-prefix scan longer than the window still reaches pending work", async () => {
  const f = await fixture([row("prefix"), row("pending")]);
  await runPreparationPrefilter({ ...f.options, maxItems: 1 }, f.runtime);
  const script = `
    import assert from 'node:assert/strict';import {mock} from 'node:test';
    const fs=await import('node:fs/promises');let clock=1000,calls=0;Date.now=()=>clock;
    mock.module('node:fs/promises',{namedExports:{...fs,readFile:async(...args)=>{
      const result=await fs.readFile(...args);if(String(args[0]).endsWith('${sha256("prefix")}.json'))clock+=91000;return result;
    }}});
    const {runPreparationPrefilter}=await import('./packages/backend/src/backfill/preparation-prefilter.ts');
    const outcome=await runPreparationPrefilter(${JSON.stringify({ ...f.options, seconds: 90 })},{
      promptVersion:'fixture-v1',environment:{fixture:true},lock:async()=>({check:async()=>{},release:async()=>{}}),
      preflight:async()=>({models:${JSON.stringify(models)},check:async()=>{}}),
      prefilter:async()=>{calls++;return {label:'PASS',reason:'fixture',model:'qwen-test',receiptId:999,reused:false}},settle:async()=>{}
    });
    assert.equal(calls,1);assert.equal(outcome.skippedExisting,1);assert.equal(outcome.status,'complete');
  `;
  const child=spawnSync(process.execPath,["--experimental-test-module-mocks","--input-type=module","-e",script],{cwd:fileURLToPath(new URL("../",import.meta.url)),encoding:"utf8",timeout:30000});
  assert.equal(child.status,0,child.stderr);
});

test("maxItems stops claiming without cancelling deferred preflight work", async () => {
  for (const maxItems of [1, 16]) {
    const rows = Array.from({ length: maxItems }, (_, i) => row(`claimed-${i}`, "PASS", i % 4 === 0 ? "model evidence" : null));
    rows.push(row("unclaimed-sentinel"));
    const f = await fixture(rows);
    // Release discovery only after the scheduler reads the first row beyond its cap.
    // Promise continuations run before setImmediate, so the cap branch executes first.
    const script = `
      import assert from 'node:assert/strict';import {mock} from 'node:test';
      const fs=await import('node:fs/promises');let release;const discovery=new Promise(r=>release=r);let sent=0,settled=0,beyondCapRead=false;
      mock.module('node:fs/promises',{namedExports:{...fs,readFile:async(...args)=>{
        try{return await fs.readFile(...args)}finally{
          if(String(args[0]).endsWith('${sha256("unclaimed-sentinel")}.json')){beyondCapRead=true;setImmediate(release)}
        }
      }}});
      const {runPreparationPrefilter}=await import('./packages/backend/src/backfill/preparation-prefilter.ts');
      const result=await runPreparationPrefilter(${JSON.stringify({ ...f.options, concurrency: 8, maxItems })},{
        promptVersion:'fixture-v1',environment:{fixture:true},lock:async()=>({check:async()=>{},release:async()=>{}}),
        preflight:async()=>{await discovery;return {models:${JSON.stringify(models)},check:async()=>{}}},
        prefilter:async()=>({label:'PASS',reason:'fixture',model:'qwen-test',receiptId:++sent,reused:false}),
        settle:async()=>{settled++}
      });
      assert.equal(beyondCapRead,true);assert.equal(result.claimed,${maxItems});
      assert.equal(sent,${Math.ceil(maxItems / 4)},'all already claimed model items must run after discovery');
      assert.equal(settled,sent);assert.equal(result.processed,${maxItems});assert.equal(result.status,'bounded');
    `;
    const child=spawnSync(process.execPath,["--experimental-test-module-mocks","--input-type=module","-e",script],{
      cwd:fileURLToPath(new URL("../",import.meta.url)),encoding:"utf8",timeout:30000});
    assert.equal(child.status,0,`concurrency=8 maxItems=${maxItems}\n${child.stderr}`);
  }
});
