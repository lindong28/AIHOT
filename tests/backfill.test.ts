import { tag, gate } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { processArticle, queueProcessing, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { translateArticle, translatePending } from "@aihot/backend/editorial/translate";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { rerun } from "@aihot/backend/admin/content";
import { chatJson } from "@aihot/backend/providers/llm";
import { materialHash, validateManifest, type ManifestEntry } from "@aihot/backend/backfill/manifest";
import { backfillOverview, importBackfill, configureBackfill, controlBackfill, runBackfill } from "@aihot/backend/backfill/runs";
import { verifyDiscovery } from "@aihot/backend/backfill/gateway";
import { bindingRoutes, type BackfillBindings } from "@aihot/backend/backfill/context";

const T = tag(), source = `bf-${T}`;
const models: BackfillBindings = {
  prefilter: { model: "gpu-qwen", route: "personal_gpu/qwen/stream", actualModel: "self_hosted/qwen" },
  structure: { model: "gpu-qwen", route: "personal_gpu/qwen/stream", actualModel: "self_hosted/qwen" },
  score: { model: "deepseek-v4.1-flash", routes: [{ route: "company_tencent_vod/deepseek-v4.1-flash/stream", actualModel: "openai/deepseek-v4.1-flash", provider: "tencent-vod", credentialProfile: "company_tencent_vod" }] },
  understand: { model: "deepseek-v4.1-flash", routes: [{ route: "company_tencent_vod/deepseek-v4.1-flash/stream", actualModel: "openai/deepseek-v4.1-flash", provider: "tencent-vod", credentialProfile: "company_tencent_vod" }] },
  summarize: { model: "deepseek-v4.1-flash", routes: [{ route: "company_tencent_vod/deepseek-v4.1-flash/stream", actualModel: "openai/deepseek-v4.1-flash", provider: "tencent-vod", credentialProfile: "company_tencent_vod" }] },
};
const requests: Array<{ model: string; route: string | undefined; stage: string; user: string; thinking: unknown; maxTokens: number; temperature: number; timeout: number; reasoningEffort?: string; topP?: number }> = [];
let pauseOnPrefilter: string | null = null, malformed = false, healthRevision = "test-revision";
let waiting: ReturnType<typeof gate> | null = null, entered: ReturnType<typeof gate> | null = null;
let healthWait: ReturnType<typeof gate> | null = null, healthEntered: ReturnType<typeof gate> | null = null;
const server = createServer(async (req,res) => {
  if (req.url === "/health") { if (healthWait) { healthEntered?.open(undefined); await healthWait.promise; } res.setHeader("content-type","application/json"); res.end(JSON.stringify({ status:"ok",file_registry_revision:healthRevision,loaded_registry_revision:healthRevision })); return; }
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const system = String(body.messages[0]?.role === "system" ? body.messages[0].content : "");
  const user = JSON.stringify(body.messages.at(-1).content);
  const stage = system.includes("宽召回的AI相关性预筛") ? "prefilter" : system.includes("事件注意力评分器") ? "score" : system.includes("内容理解编辑") ? "understand" : system.includes("资料结构化助手") ? "structure" : "summarize";
  requests.push({ model:body.model,route:req.headers["x-llm-route"] as string|undefined ?? (req.headers["x-llm-allowed-routes"] ? JSON.parse(String(req.headers["x-llm-allowed-routes"]))[0] : undefined),stage,user,thinking:body.thinking,maxTokens:body.max_tokens,temperature:body.temperature,timeout:body.timeout,reasoningEffort:body.reasoning_effort,topP:body.top_p });
  if (stage === "prefilter" && pauseOnPrefilter) { const id=pauseOnPrefilter;pauseOnPrefilter=null;await controlBackfill(id,"pause","test"); }
  if (stage === "prefilter" && waiting) { entered?.open(undefined); await waiting.promise; }
  const answer = stage === "prefilter" ? { label:user.includes("OFFTOPIC") ? "BLOCK" : "PASS",reason:"fixture" }
    : stage === "score" ? {attentionScore:user.includes("LOW") ? 35 : 80}
    : stage === "structure" ? {category:"ai-models",tags:["模型发布"],subjects:[],fact:{title:"新模型发布",subject:"实验室",action:"发布",object:"模型",occurredAt:null}}
    : stage === "understand" ? {itemType:"model_release",authorRole:"principal",tags:["模型发布"],editorialJudgment:"发布了可下载的新模型",titleZh:user.includes("IDENTITY_GUARD") ? "OpenAI 发布开放模型" : "实验室发布开放模型",summaryZh:user.includes("IDENTITY_GUARD") ? "OpenAI 发布可下载的新模型。" : "实验室发布可下载的新模型，并公布基准成绩与使用说明。"}
    : "title_zh: 模型更新\nsummary_zh: 实验室更新模型，并公布测试方法及使用说明。";
  const binding = Object.values(models).find(b=>b.model===body.model);
  const route = binding && bindingRoutes(binding)[0];
  res.setHeader("content-type","application/json");res.end(JSON.stringify({
    choices:[{message:{content:malformed ? "bad" : binding ? typeof answer === "string" ? answer : JSON.stringify(answer) : '{"ok":true}'}}],
    usage:{prompt_tokens:20,completion_tokens:10},
    llm_gateway:{projection_version:1,logical_request_id:req.headers["x-llm-request-id"],provider_id:route?.provider ?? "bailian",selected_route_id:route?.route,actual_model:route?.actualModel,credential_profile_id:route?.credentialProfile},
  }));
});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
Object.assign(process.env,{LLM_GATEWAY_URL:baseUrl,LLM_GATEWAY_PROJECT:"aihot-test",LLM_GATEWAY_MODE:"stream"});
config.modelCallsEnabled=true;
const directory=await mkdtemp(join(tmpdir(),"aihot-backfill-fixtures-"));
const cli=join(directory,"gateway-discover");
const discovery=(model:string)=>({projection_version:2,view_scope:"logical_model",requested_logical_model:model,status:"ready",
  project:{id:"aihot-test",billing_scope:["personal","company"]},project_allowed_logical_model_ids:[model],registry:{file_revision:"test-revision",loaded_revision:"test-revision"},endpoint:`${baseUrl}/v1/chat/completions`,
  routes:Object.values(models).filter(b=>b.model===model).flatMap(b=>bindingRoutes(b).map(r=>({id:r.route,logical_model:model,actual_model:r.actualModel,provider_id:r.provider,credential_profile_id:r.credentialProfile,funding_source:r.provider==="tencent-vod" ? "company_paid" : "personal_paid",effectively_eligible:true,project_allowed:true,policy_allowed:true}))),
});
await writeFile(cli,`#!${process.execPath}\nconst views=${JSON.stringify(Object.fromEntries(["gpu-qwen","gpu-glm","deepseek-v4.1-flash"].map(m=>[m,discovery(m)])))}; console.log(JSON.stringify(views[process.argv.at(-1)]));\n`,{mode:0o700});
process.env.LLM_GATEWAY_CLI=cli;
before(async()=>{ await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,enabled,site_fulltext) VALUES(${source},'Backfill fixture','rss','T1','editorial',false,false)`; });
after(async()=>{ server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await stopBoss();await closeDb();await rm(directory,{recursive:true,force:true}); });
function entry(marker:string, day="2026-06-01", quality:ManifestEntry["quality"]["state"]="complete"):ManifestEntry {
  const material={sourceId:source,url:`https://example.com/backfill/${T}/${marker}`,title:`${marker} open model ${T}`,publishedAt:`${day}T10:00:00Z`,bodyText:`${marker}. A lab released an open model and published its benchmark and documentation. `.repeat(8)};
  return {material,quality:{state:quality,evidence:"Synthetic complete original fixture",contentHash:materialHash(material)}};
}
async function batch(entries:ManifestEntry[]) {
  const r=await importBackfill({label:`本机模拟回填 ${T}`,startDay:"2026-06-01",endDay:"2026-06-02",entries});
  await configureBackfill(r.id,models);await controlBackfill(r.id,"resume","test");return r.id;
}

test("manifest rejects stale completeness evidence, duplicate identities and gaps after cleaning",()=>{
  const first=entry("valid"), second=entry("valid2","2026-06-02");
  assert.equal(validateManifest([first,second],"2026-06-01","2026-06-02").entries.length,2);
  assert.throws(()=>validateManifest([first,{...second,quality:{...second.quality,state:"unverified"}}],"2026-06-01","2026-06-02"),/No verified complete/);
  assert.throws(()=>validateManifest([first,{...second,material:{...second.material,bodyText:"changed"}}],"2026-06-01","2026-06-02"),/does not match/);
  assert.throws(()=>validateManifest([first,first],"2026-06-01","2026-06-01"),/Duplicate/);
  const short=entry("short");short.material.bodyText="We released the weights today.";short.quality.contentHash=materialHash(short.material);
  assert.equal(validateManifest([short],"2026-06-01","2026-06-01").entries.length,1,"complete short originals are not discarded by length");
});

test("discovery rejects commercial, wrong-project and ineligible routes before inference",()=>{
  const view=discovery("gpu-qwen");assert.equal(verifyDiscovery(view,"gpu-qwen",models,"aihot-test",baseUrl),"test-revision");
  for(const change of [ {project:{id:"company",billing_scope:"company"}}, {routes:view.routes.map(r=>({...r,actual_model:"openai/qwen"}))}, {routes:view.routes.map(r=>({...r,effectively_eligible:false}))}, {endpoint:"http://elsewhere/v1/chat/completions"} ]) {
    assert.throws(()=>verifyDiscovery({...view,...change},"gpu-qwen",models,"aihot-test",baseUrl));
  }
  for (const provider_id of ["deepseek", "bailian", undefined]) {
    assert.throws(()=>verifyDiscovery({...view,routes:view.routes.map(r=>({...r,provider_id}))},"gpu-qwen",models,"aihot-test",baseUrl),/Backfill route identity or funding changed/);
  }
});

test("native publication progresses by day, filters noise, preserves existing originals and isolates live routing",async()=>{
  const e=entry("EXISTING"); const existing=await upsertMaterial({...e.material,publishedAt:new Date(e.material.publishedAt),bodyText:"Keep native original",via:"fetch"});
  const entries=[entry("CLEAR"),entry("LOW","2026-06-02"),entry("OFFTOPIC","2026-06-02"),e,entry("UNVERIFIED","2026-06-02","unverified")];
  const id=await batch(entries);
  const duplicate=await importBackfill({label:"same",startDay:"2026-06-01",endDay:"2026-06-02",entries});assert.equal(duplicate.id,id);assert.equal(duplicate.reused,true);
  const start=requests.length;
  const [result,live]=await Promise.all([runBackfill(id,{concurrency:2,maxItems:10}),chatJson({model:"qwen3.8-flash",purpose:"live_isolation",subject:T,promptVersion:"1",system:"live",user:"live",schema:z.object({ok:z.boolean()})})]);
  assert.equal(live.data.ok,true);assert.equal(result.state,"complete");
  const sent=requests.slice(start);assert.ok(sent.some(r=>r.model==="qwen3.8-flash"&&!r.route));assert.ok(sent.filter(r=>r.model.startsWith("gpu-")).every(r=>r.route?.startsWith("personal_gpu/")));
  assert.deepEqual([...new Set(sent.filter(r=>r.route).map(r=>r.stage))].sort(),["prefilter","score","structure","summarize","understand"]);
  assert.ok(sent.some(r=>r.model==="deepseek-v4.1-flash"&&r.route==="company_tencent_vod/deepseek-v4.1-flash/stream"));
  for (const stage of ["score", "understand", "summarize"]) {
    const calls = sent.filter(r => r.stage === stage && r.route);
    assert.ok(calls.length > 0, `${stage} was called`);
    assert.ok(calls.every(r => r.model === "deepseek-v4.1-flash" && r.route === "company_tencent_vod/deepseek-v4.1-flash/stream"));
    for (const call of calls) {
      if (stage === "score") {
        assert.deepEqual(call.thinking, { type: "enabled", clear_thinking: false });
        assert.deepEqual([call.temperature, call.maxTokens, call.timeout, call.reasoningEffort, call.topP], [1, 65536, 180, "high", 0.95]);
      } else if (stage === "understand") {
        assert.deepEqual(call.thinking, { type: "enabled" });
        assert.deepEqual([call.temperature, call.maxTokens, call.timeout, call.reasoningEffort], [0.2, 16384, 180, "low"]);
      } else {
        assert.deepEqual(call.thinking, { type: "disabled" });
        assert.deepEqual([call.temperature, call.maxTokens, call.timeout], [0.2, 2048, 120]);
      }
    }
  }
  const rows=await sql`SELECT * FROM backfill_items WHERE run_id=${id}`;
  assert.deepEqual(rows.map(r=>r.state).sort(),["excluded","existing","filtered","published","published"]);
  assert.equal((await sql`SELECT body_text FROM articles WHERE id=${existing.articleId}`)[0]!.body_text,"Keep native original");
  const overview=await backfillOverview(), run=overview.runs.find((r:any)=>r.id===id)!;
  assert.equal(run.days.reduce((s,d)=>s+Number(d.done),0),4);assert.equal(run.days.length,2);
  const [a]=await sql`SELECT * FROM articles WHERE managed_backfill_id=${id} AND title LIKE 'CLEAR%'`;
  assert.equal(a!.backfill,true);assert.equal(a!.timeline_at.toISOString().slice(0,10),"2026-06-01");
  assert.equal((await sql`SELECT count(*) AS n FROM fact_articles WHERE article_id=${a!.id}`)[0]!.n,0);
  const before=requests.length;await runBackfill(id,{concurrency:2,maxItems:10});assert.equal(requests.length,before,"completed batch makes no additional calls");
  assert.equal(await queueProcessing(a!.id),null);assert.equal((await processArticle(a!.id)).state,"managed-backfill");
  await assert.rejects(()=>analyzeArticle(a!.id),/Managed history/);
  await assert.rejects(()=>rerun(a!.id,"group","test-request-123","test"),/回填/);
  assert.equal((await translateArticle(a!.id)).status,"skipped");
  const managedReceipts = async () => (await sql`SELECT count(*) AS n FROM receipts r WHERE EXISTS (SELECT 1 FROM articles a WHERE a.managed_backfill_id=${id} AND r.subject LIKE 'article:' || a.id || '%')`)[0]!.n;
  const receiptCount = await managedReceipts();await translatePending();assert.equal(await managedReceipts(),receiptCount);
  await upsertMaterial({...entries[0]!.material,publishedAt:new Date(entries[0]!.material.publishedAt),bodyText:"overwrite attempt",via:"fetch"});
  const [same]=await sql`SELECT revision,body_text FROM articles WHERE id=${a!.id}`;assert.equal(same!.revision,1);assert.equal(same!.body_text,a!.body_text);
  const receipts=await sql`SELECT service FROM receipts WHERE subject LIKE ${`article:${a!.id}%`}`;assert.ok(receipts.length>=5);assert.ok(receipts.every(r=>r.service==="backfill"));
});

test("pause at the next call boundary persists progress and resume reuses the received prefilter",async()=>{
  const id=await batch([entry("PAUSE"),entry("PAUSE2","2026-06-02")]);pauseOnPrefilter=id;
  const before=requests.length;
  assert.equal((await runBackfill(id,{concurrency:1,maxItems:10})).state,"paused");
  assert.equal(requests.length-before,1);
  await controlBackfill(id,"resume","test");assert.equal((await runBackfill(id,{concurrency:1,maxItems:10})).state,"complete");
  assert.equal(requests.slice(before).filter(r=>r.stage==="prefilter").length,2,"one prefilter per article, including resumed one");
});

test("missing models wait without inference; unknown responses stay failed without blind retry",async()=>{
  const raw=await importBackfill({label:"模型待部署",startDay:"2026-06-01",endDay:"2026-06-02",entries:[entry("NO_MODEL"),entry("NO_MODEL2","2026-06-02")]});
  await controlBackfill(raw.id,"resume","test");const before=requests.length;
  assert.equal((await runBackfill(raw.id,{concurrency:1,maxItems:2})).state,"waiting_models");assert.equal(requests.length,before);
  const id=await batch([entry("BAD"),entry("BAD2","2026-06-02")]);malformed=true;
  assert.equal((await runBackfill(id,{concurrency:2,maxItems:2})).state,"needs_attention");malformed=false;
  const afterFailure=requests.length;await controlBackfill(id,"retry","test");await runBackfill(id,{concurrency:2,maxItems:2});assert.equal(requests.length,afterFailure);
});

test("executor lock prevents concurrent drains; stale running rows recover using persisted receipts",async()=>{
  const id=await batch([entry("LOCK"),entry("LOCK2","2026-06-02")]);
  waiting=gate();entered=gate();const run=runBackfill(id,{concurrency:1,maxItems:1});await entered.promise;
  await assert.rejects(()=>runBackfill(id,{concurrency:1,maxItems:1}),/already has an executor/);
  waiting.open(undefined);waiting=null;entered=null;await run;
  await sql`UPDATE backfill_items SET state='running' WHERE run_id=${id} AND state='published'`;
  const before=requests.length;await runBackfill(id,{concurrency:2,maxItems:2});
  assert.equal(requests.length-before,5,"only unprocessed article calls the model");
  const [a]=await sql`SELECT article_id FROM backfill_items WHERE run_id=${id} LIMIT 1`;
  await sql`UPDATE articles SET processing_state='new',created_at=now()-interval '1 hour' WHERE id=${a!.article_id}`;
  await sweepUnprocessed();assert.equal(await queueProcessing(a!.article_id),null);
});

test("native content rejection counts as filtered, including recovery of previously failed items",async()=>{
  const short=entry("LOW_SHORT");short.material.bodyText="We shipped it.";short.quality.contentHash=materialHash(short.material);
  const id=await batch([short,entry("IDENTITY_GUARD"),entry("GOOD_AFTER_SHORT","2026-06-02")]);
  assert.equal((await runBackfill(id,{concurrency:2,maxItems:3})).state,"complete");
  const rejected=await sql`SELECT i.article_id,i.reason,a.processing_state,n.relevance,n.output,p.eligible,p.selected
    FROM backfill_items i JOIN articles a ON a.id=i.article_id JOIN analyses n ON n.article_id=a.id
    JOIN publications p ON p.article_id=a.id WHERE i.run_id=${id} AND i.state='filtered'`;
  assert.equal(rejected.length,2);
  for (const row of rejected) {
    assert.equal(row.processing_state,"analyzed");assert.equal(row.relevance,"unknown");
    assert.equal(row.eligible,false);assert.equal(row.selected,false);assert.equal(row.reason,"analysis_unknown");
  }
  assert.ok(rejected.some(row=>row.output.identityGuard?.outcome==="fallback"));
  // Recreate the old runner's terminal state; recovery must reuse the existing analyses and receipts.
  await sql`UPDATE backfill_items SET state='failed',reason='Error: Analysis not complete: unknown' WHERE run_id=${id} AND state='filtered'`;
  await sql`UPDATE backfill_runs SET state='needs_attention' WHERE id=${id}`;
  await controlBackfill(id,"retry","test");const before=requests.length;
  assert.equal((await runBackfill(id,{concurrency:2,maxItems:2})).state,"complete");
  assert.equal(requests.length,before);
  const run=(await backfillOverview()).runs.find((r:any)=>r.id===id)!;
  assert.equal(run.days.reduce((s,d)=>s+Number(d.done),0),3);
  assert.equal(run.days.reduce((s,d)=>s+Number(d.filtered),0),2);
  assert.equal(run.days.reduce((s,d)=>s+Number(d.failed),0),0);
  assert.equal(run.days.filter(d=>d.done===d.total).length,2);
});

test("model bindings cannot change while discovery is in flight even after pause",async()=>{
  const id=await batch([entry("CONFIG_RACE"),entry("CONFIG_RACE2","2026-06-02")]);
  healthWait=gate();healthEntered=gate();
  const running=runBackfill(id,{concurrency:1,maxItems:1});await healthEntered.promise;
  try {
    await controlBackfill(id,"pause","test");
    const otherQwen = { ...models.prefilter, model: "other-qwen-model" };
    await assert.rejects(()=>configureBackfill(id,{...models,prefilter:otherQwen,structure:otherQwen}),/executor/);
  } finally { healthWait.open(undefined);healthWait=null;healthEntered=null;await running; }
});
