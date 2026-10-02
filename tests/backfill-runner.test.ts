import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { configureBackfill, controlBackfill, drainBackfills, importBackfill, runBackfill } from "@aihot/backend/backfill/runs";
import { materialHash } from "@aihot/backend/backfill/manifest";
import { bindingRoutes, type BackfillBindings } from "@aihot/backend/backfill/context";

const T = tag(), source = `runner-${T}`;
const models: BackfillBindings = {
  prefilter: { model: "gpu-qwen", route: "personal_gpu/qwen/stream", actualModel: "self_hosted/qwen" },
  structure: { model: "gpu-qwen", route: "personal_gpu/qwen/stream", actualModel: "self_hosted/qwen" },
  score: { model: "deepseek-v4.1-flash", routes: [{ route: "company_tencent_vod/deepseek-v4.1-flash/stream", actualModel: "openai/deepseek-v4.1-flash", provider: "tencent-vod", credentialProfile: "company_tencent_vod" }] },
  understand: { model: "deepseek-v4.1-flash", routes: [{ route: "company_tencent_vod/deepseek-v4.1-flash/stream", actualModel: "openai/deepseek-v4.1-flash", provider: "tencent-vod", credentialProfile: "company_tencent_vod" }] },
  summarize: { model: "deepseek-v4.1-flash", routes: [{ route: "company_tencent_vod/deepseek-v4.1-flash/stream", actualModel: "openai/deepseek-v4.1-flash", provider: "tencent-vod", credentialProfile: "company_tencent_vod" }] },
};
let requestCount = 0;
let entered: ReturnType<typeof gate> | undefined, release: ReturnType<typeof gate> | undefined;
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") {
    res.end(JSON.stringify({ status: "ok", loaded_registry_revision: "runner-fixture", file_registry_revision: "runner-fixture" })); return;
  }
  if (req.url?.startsWith("/v1/discovery?")) {
    const model = new URL(req.url, "http://localhost").searchParams.get("model");
    res.end(JSON.stringify({ projection_version: 2, view_scope: "logical_model", requested_logical_model: model,
      status: "ready", project: { id: "aihot-runner-test", billing_scope: ["personal", "company"] }, project_allowed_logical_model_ids: [model],
      loaded_registry_revision: "runner-fixture", file_registry_revision: "runner-fixture",
      routes: Object.values(models).filter(b => b.model === model).flatMap(b => bindingRoutes(b).map(r => ({ id: r.route, actual_model: r.actualModel, provider_id: r.provider, credential_profile_id: r.credentialProfile, funding_source: r.provider === "tencent-vod" ? "company_paid" : "personal_paid", project_allowed: true, policy_allowed: true, effectively_eligible: true }))) })); return;
  }
  requestCount++;
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  entered?.open(undefined); if (release) await release.promise;
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ label: "BLOCK", reason: "Local fixture unrelated to AI" }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
    llm_gateway: { projection_version: 1, logical_request_id: req.headers["x-llm-request-id"], provider_id: "self-hosted", selected_route_id: "personal_gpu/qwen/stream", actual_model: "self_hosted/qwen" } }));
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
Object.assign(process.env, { LLM_GATEWAY_URL: base, LLM_GATEWAY_PROJECT: "aihot-runner-test", LLM_GATEWAY_MODE: "stream" });
delete process.env.LLM_GATEWAY_CLI;
config.modelCallsEnabled = true; // The only provider is the loopback stub above.
before(async () => { await sql`INSERT INTO sources(id,name,kind,tier,enabled) VALUES(${source},'Runner fixture','rss','T1',false)`; });
beforeEach(async () => { await sql`UPDATE backfill_runs SET state='paused' WHERE state<>'complete'`; });
after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await stopBoss(); await closeDb(); });

async function batch(count: number, ready = true) {
  const unique = tag();
  const entries = Array.from({ length: count }, (_, i) => {
    const material = { sourceId: source, url: `https://example.com/${T}/${unique}/${i}`, title: `Local unrelated fixture ${i}`, publishedAt: "2026-06-01T12:00:00Z", bodyText: "A full synthetic original about a local gardening festival. ".repeat(6) };
    return { material, quality: { state: "complete", evidence: "Complete synthetic original", contentHash: materialHash(material) } };
  });
  const { id } = await importBackfill({ label: `runner ${unique}`, startDay: "2026-06-01", endDay: "2026-06-01", entries });
  await configureBackfill(id, models);
  if (ready) await controlBackfill(id, "resume", "test");
  return id;
}

test("drain shares claimed-item budget across batches and skips paused/attention/complete", async () => {
  const ids = [await batch(1), await batch(4), await batch(1, false), await batch(1), await batch(1)];
  await sql`UPDATE backfill_runs SET state='needs_attention' WHERE id=${ids[3]!}`;
  await sql`UPDATE backfill_runs SET state='complete' WHERE id=${ids[4]!}`;
  const result = await drainBackfills({ concurrency: 3, maxItems: 3, maxRuns: 10 });
  assert.deepEqual(result.runs.map(r => r.id), ids.slice(0, 2));
  assert.equal(result.runs.reduce((n, r) => n + r.claimed, 0), 3);
  assert.equal(result.runs.reduce((n, r) => n + r.processed, 0), 3);
  assert.equal((await sql`SELECT sum(attempts)::int AS n FROM backfill_items WHERE run_id IN ${sql(ids)}`)[0]!.n, 3);
  assert.equal((await runBackfill(ids[3]!, { concurrency: 1, maxItems: 1 })).state, "needs_attention");
});

test("busy batch is skipped without resetting its running item; another batch can proceed", async () => {
  const busy = await batch(1), next = await batch(1);
  await sql`UPDATE backfill_runs SET state='running' WHERE id=${busy}`;
  await sql`UPDATE backfill_items SET state='running' WHERE run_id=${busy}`;
  const lock = await sql.reserve();
  await lock`SELECT pg_advisory_lock(hashtext(${'backfill:' + busy}))`;
  try {
    const result = await drainBackfills({ concurrency: 2, maxItems: 2, maxRuns: 2 });
    assert.equal(result.runs.find(r => r.id === busy)!.state, "locked");
    assert.equal(result.runs.find(r => r.id === next)!.state, "complete");
    assert.equal((await sql`SELECT state FROM backfill_items WHERE run_id=${busy}`)[0]!.state, "running");
  } finally { await lock`SELECT pg_advisory_unlock(hashtext(${'backfill:' + busy}))`; lock.release(); }
  assert.equal((await drainBackfills({ concurrency: 1, maxItems: 1, maxRuns: 2 })).runs[0]!.state, "complete");
});

test("waiting model batches are bounded by maxRuns and rotated by heartbeat", async () => {
  const a = await batch(1), b = await batch(1);
  await sql`UPDATE backfill_runs SET models=NULL WHERE id IN ${sql([a, b])}`;
  const before = requestCount;
  const first = await drainBackfills({ concurrency: 1, maxItems: 2, maxRuns: 1 });
  const second = await drainBackfills({ concurrency: 1, maxItems: 2, maxRuns: 1 });
  assert.equal(first.runs.length, 1); assert.equal(second.runs.length, 1);
  assert.notEqual(first.runs[0]!.id, second.runs[0]!.id);
  assert.equal(first.runs[0]!.state, "waiting_models"); assert.equal(second.runs[0]!.state, "waiting_models");
  assert.equal(requestCount, before);
});

test("shutdown settles an in-flight receipt, stops new claims, and resumes without duplicate calls", async () => {
  const id = await batch(3), controller = new AbortController();
  entered = gate(); release = gate();
  const before = requestCount;
  const running = drainBackfills({ concurrency: 1, maxItems: 3, maxRuns: 2, signal: controller.signal });
  await entered.promise;
  controller.abort(); release.open(undefined); release = undefined; entered = undefined;
  const result = await running;
  assert.equal(result.stopped, true); assert.equal(result.runs[0]!.claimed, 1);
  assert.equal(requestCount, before + 1);
  const receipt = await sql`SELECT r.status FROM receipts r WHERE r.subject LIKE 'article:%' AND EXISTS (SELECT 1 FROM backfill_items i WHERE i.run_id=${id} AND r.subject LIKE 'article:' || i.article_id || '%')`;
  assert.ok(receipt.length > 0); assert.ok(receipt.every(r => ['received', 'completed'].includes(r.status)));
  const resumed = await drainBackfills({ concurrency: 2, maxItems: 3, maxRuns: 2 });
  assert.equal(resumed.runs[0]!.state, "complete");
  assert.equal(requestCount, before + 3, "one request per article across shutdown and resume");
});

test("aborted drain does not acquire work; invalid capacity is rejected", async () => {
  await batch(2);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual((await drainBackfills({ concurrency: 1, maxItems: 2, maxRuns: 2, signal: controller.signal })).runs, []);
  await assert.rejects(() => drainBackfills({ concurrency: 0, maxItems: 2, maxRuns: 2 }), /capacity/);
});

test("Mac probe distinguishes batch attention, model wait and supervisor failures without sending", () => {
  const code = `import importlib.util
spec=importlib.util.spec_from_file_location('probe','deploy/production/backfill-probe.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
units={'aihot-backfill.timer':{'LoadState':'loaded','ActiveState':'active'},'aihot-backfill.service':{'LoadState':'loaded','ActiveState':'inactive','Result':'success'}}
for state in ['ready','running','paused','complete']:
 assert m.problems({'runs':[{'id':'batch','state':state}]},units)=={}
for state in ['needs_attention','waiting_models']:
 assert 'batch:batch' in m.problems({'runs':[{'id':'batch','state':state}]},units)
units['aihot-backfill.service']['Result']='timeout'
assert 'runner' in m.problems({'runs':[]},units)
units['aihot-backfill.timer']['ActiveState']='inactive'
assert set(m.problems({'runs':[]},units))=={'scheduler','runner'}
import tempfile, pathlib, sys
from unittest.mock import patch
units['aihot-backfill.timer']['ActiveState']='active'
units['aihot-backfill.service']['Result']='success'
sent=[]
report={'runs':[{'id':'batch','state':'needs_attention'}]}
with tempfile.TemporaryDirectory() as home, patch.object(m.Path,'home',return_value=pathlib.Path(home)), patch.object(m,'read_status',side_effect=lambda host:(report,units)), patch.object(m,'notify',side_effect=lambda binary,args:sent.append(args)), patch.object(sys,'argv',['probe']):
 m.main();first=sent[-1];m.main();assert sent[-1]==first
 report['runs']=[];m.main();assert '恢复未核实' in sent[-1][-1];assert not any('--dedup-clear' in args for args in sent)
 report['runs']=[{'id':'batch','state':'paused'}];m.main();assert sent[-1][0]=='--dedup-clear';assert '告警退役' in sent[-2][-1]
 report['runs']=[{'id':'batch','state':'waiting_models'}];m.main()
 report['runs']=[{'id':'batch','state':'ready'}];m.main();assert sent[-1][0]=='--dedup-clear';assert '原异常已解除' in sent[-2][-1]
print('probe state cases passed; no notification sent')`;
  const result = spawnSync("python3", ["-c", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
