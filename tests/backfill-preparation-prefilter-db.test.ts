import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { paidRequest } from "@aihot/backend/providers/receipts";
import { durableJson, runPreparationPrefilter, type PreparationRuntime } from "@aihot/backend/backfill/preparation-prefilter";
const T = tag();
const qwen = { model: "qwen-test", routes: [{ route: "gpu/qwen/stream", actualModel: "self_hosted/qwen", provider: "self-hosted", credentialProfile: "gpu" }] };
const deepseek = { model: "deepseek-v4.1-flash", routes: [{ route: "company_tencent_vod/deepseek-v4.1-flash/stream", actualModel: "openai/deepseek-v4.1-flash", provider: "tencent-vod", credentialProfile: "company_tencent_vod" }] };
const models = { prefilter: qwen, structure: qwen, score: deepseek, understand: deepseek, summarize: deepseek };
after(closeDb);
async function fixture(suffix: string) {
  const d = await mkdtemp(join(tmpdir(), "aihot-preparation-db-test-")), input = join(d,"input.jsonl"), output = join(d,"output");
  await writeFile(input, JSON.stringify({ key: T+suffix, article: { id: "raw", revision: 1, title: "AI release", url: "https://example.com/x", author: null,
    publishedAt: "2026-05-01T00:00:00Z", bodyText: "announcement", excerpt: null, xPost: null, media: [], source: { name: "fixture", kind: "feed", tier: "A", firstParty: true } }, provenance: { test: T } })+"\n");
  let calls = 0;
  const runtime: Partial<PreparationRuntime> = { preflight: async () => ({ models, check: async () => {} }), prefilter: async (a) => {
    const r = await paidRequest({ service: "backfill", purpose: "prefilter_article", model: qwen.model, subject: a.id, identity: { test: T, suffix, article: a.id } }, async () => { calls++; return { response: { label: "PASS" } }; });
    return { label: "PASS", reason: "fixture", model: qwen.model, receiptId: r.receiptId, reused: r.reused };
  } };
  return { output, options: { input, output, models, concurrency: 1, maxItems: 1, seconds: 10 }, runtime, calls: () => calls };
}
async function result(output: string) {
  const file = (await readdir(join(output,"results"))).find(f=>f.endsWith('.json'))!;
  return JSON.parse(await readFile(join(output,"results",file),'utf8'));
}
test("real received receipt survives output failure and settles only after durable result", async () => {
  const f = await fixture("received"); let fail = true;
  f.runtime.save = async (p,v) => { if (fail && p.includes('/results/')) { fail=false; throw new Error('disk stopped'); } await durableJson(p,v); };
  await assert.rejects(runPreparationPrefilter(f.options,f.runtime),/disk stopped/);
  const [before] = await sql`SELECT id,status FROM receipts WHERE subject=${'preparation:' + (await import('@aihot/backend/lib/ids')).sha256(T+'received')}`;
  assert.equal(before.status,'received');
  await runPreparationPrefilter(f.options,f.runtime);
  assert.equal(f.calls(),1); assert.equal((await result(f.output)).receiptId,before.id);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${before.id}`)[0].status,'completed');
});
test("real pending completion cannot overwrite an unknown receipt", async () => {
  const f = await fixture("unknown");
  f.runtime.settle = async id => { await sql`UPDATE receipts SET status='unknown' WHERE id=${id}`; throw new Error('stopped before settle'); };
  await assert.rejects(runPreparationPrefilter(f.options,f.runtime),/stopped before settle/);
  const saved = await result(f.output); delete f.runtime.settle;
  const resumed = await runPreparationPrefilter(f.options,f.runtime);
  assert.equal(resumed.unresolvedErrors,1); assert.equal(f.calls(),1);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${saved.receiptId}`)[0].status,'unknown');
});
test("real advisory session lock excludes the second executor until inflight work settles", async () => {
  const f=await fixture('lock'), entered=gate(), release=gate(); const prefilter=f.runtime.prefilter!;
  f.runtime.prefilter=async(a,o)=>{entered.open();await release.promise;return prefilter(a,o)};
  const first=runPreparationPrefilter(f.options,f.runtime); await entered.promise;
  const second=await runPreparationPrefilter(f.options,f.runtime); assert.equal(second.status,'locked');
  release.open();assert.equal((await first).status,'complete');assert.equal(f.calls(),1);
});

test("actual CLI reports title-only completion and nonzero cumulative errors without model calls", async () => {
  const { spawnSync } = await import('node:child_process');
  const f=await fixture('cli-title');
  const raw=JSON.parse(await readFile(f.options.input,'utf8'));raw.article.bodyText=null;
  await writeFile(f.options.input,JSON.stringify(raw)+'\n');
  const modelsFile=join(f.output,'..','models.json');await writeFile(modelsFile,JSON.stringify(models));
  const cli=()=>spawnSync(process.execPath,['scripts/backfill-prefilter.ts',f.options.input,modelsFile,f.output,'1','10','10','--json'],{
    env:{...process.env,MODEL_CALLS_ENABLED:'false'},encoding:'utf8',timeout:30000});
  const first=cli();assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).needsOriginal,1);
  const g=await fixture('cli-error');g.runtime.prefilter=async()=>{throw new Error('unlogged provider payload')};
  await runPreparationPrefilter(g.options,g.runtime);
  const failed=spawnSync(process.execPath,['scripts/backfill-prefilter.ts',g.options.input,modelsFile,g.output,'1','10','10','--json'],{
    env:{...process.env,MODEL_CALLS_ENABLED:'false'},encoding:'utf8',timeout:30000});
  assert.equal(failed.status,2,failed.stderr);assert.equal(JSON.parse(failed.stdout).unresolvedErrors,1);
});
