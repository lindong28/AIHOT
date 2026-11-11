import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { BackfillBinding } from "@aihot/backend/backfill/context";

let hits=0,wrong="";
const seen: Array<Record<string,unknown>>=[];
const route={provider:"dashscope",route:"fixture/embedding/stream",actualModel:"openai/fixture-embedding"};
const server=createServer(async(req,res)=>{
  res.setHeader("content-type","application/json");
  if(req.url==="/api/capabilities") {res.end(JSON.stringify({retry_policy_versions:[1],request_recovery_versions:[1]}));return;}
  for await(const _ of req) { /* consume request */ }
  hits++;seen.push({...req.headers});
  const retry=JSON.parse(String(req.headers["x-llm-retry-policy"]));
  res.setHeader("x-llm-retry-policy",JSON.stringify(retry));
  res.end(JSON.stringify({data:[{index:0,embedding:[1,0,0]}],llm_gateway:{projection_version:1,logical_request_id:req.headers["x-llm-request-id"],retry_policy:retry,
    provider_id:route.provider,selected_route_id:route.route,actual_model:route.actualModel,...(wrong?{[wrong]:"wrong"}:{})}}));
});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
Object.assign(process.env,{LLM_GATEWAY_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}`,LLM_GATEWAY_PROJECT:"semantic-fixture",EMBEDDING_MODEL:"fixture-embedding",EMBEDDING_DIMS:"3",MODEL_CALLS_ENABLED:"true",
  RESEARCH_SEMANTIC_MODEL:"fixture-embedding",RESEARCH_SEMANTIC_DIMS:"3",RESEARCH_SEMANTIC_PROFILE:"title-summary-v1",RESEARCH_SEMANTIC_PROVIDER:route.provider,
  RESEARCH_SEMANTIC_ROUTE:route.route,RESEARCH_SEMANTIC_ACTUAL_MODEL:route.actualModel,RESEARCH_SEMANTIC_REGISTRY_REVISION:"a".repeat(64)});
const {sql,closeDb}=await import("@aihot/backend/db");
const {embedResearchQuery}=await import("@aihot/backend/providers/embeddings");
const {semanticProfile,submitSemanticQuery}=await import("@aihot/backend/research/semantic");
const {executeSemanticQuery}=await import("@aihot/backend/jobs/semantic");
const {stopBoss}=await import("@aihot/backend/jobs/queue");
const pin:BackfillBinding={model:"fixture-embedding",routes:[route],registryRevision:"a".repeat(64)};
const encode=embedResearchQuery as (q:string,subject:string,identity:unknown,pin:BackfillBinding)=>ReturnType<typeof embedResearchQuery>;
await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('embedding',1000,1000,1000) ON CONFLICT(service) DO UPDATE SET per_minute=1000,per_hour=1000,per_day=1000`;
after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await stopBoss();await closeDb();});

test("Gateway semantic configuration requires a verified route and actual model",()=>{
  for(const key of ["RESEARCH_SEMANTIC_ROUTE","RESEARCH_SEMANTIC_ACTUAL_MODEL","RESEARCH_SEMANTIC_REGISTRY_REVISION"]) {
    const old=process.env[key];delete process.env[key];
    try {assert.throws(()=>semanticProfile(),/embedding_profile_unverified/);} finally {process.env[key]=old;}
  }
});
test("query dispatch pins the route; same-dimension provider drift cannot produce a vector",async()=>{
  for(const field of ["provider_id","selected_route_id","actual_model"]) {
    wrong=field;
    try {await assert.rejects(encode("drift",`semantic:${tag()}`,{case:tag()},pin));} finally {wrong="";}
  }
  const out=await encode("valid",`semantic:${tag()}`,{case:tag()},pin);
  assert.deepEqual(out.vector,[1,0,0]);
  assert.deepEqual(JSON.parse(String(seen.at(-1)!["x-llm-allowed-routes"])),[route.route]);
  assert.equal(seen.at(-1)!["x-llm-registry-revision"],"a".repeat(64));
});
test("received and completed cached responses are validated without another dispatch",async()=>{
  for(const status of ["received","completed"]) for(const field of ["provider_id","selected_route_id","actual_model","missing"]) {
    const subject=`semantic:${tag()}`,identity={case:tag()};
    const out=await encode("reuse",subject,identity,pin),before=hits;
    if(field==="missing") await sql`UPDATE receipts SET status=${status},response=response-'llm_gateway' WHERE id=${out.receiptId}`;
    else await sql`UPDATE receipts SET status=${status},response=jsonb_set(response,${['llm_gateway',field]}::text[],'"wrong"'::jsonb) WHERE id=${out.receiptId}`;
    await assert.rejects(encode("reuse",subject,identity,{...pin,registryRevision:"b".repeat(64)}));
    assert.equal(hits,before,"registry-only edits and invalid cached responses never authorize a second payment");
    const [saved]=await sql`SELECT status,response FROM receipts WHERE id=${out.receiptId}`;
    assert.equal(saved!.status,"unknown");assert.ok(saved!.response);
  }
});
test("the submitted job freezes route identity and the worker sends that exact binding",async()=>{
  const owner="c".repeat(64);
  process.env.RESEARCH_TOKEN_SHA256=owner;process.env.RESEARCH_SEMANTIC_TOKEN_SHA256=owner;
  const out=await submitSemanticQuery(owner,{requestId:randomUUID(),createdAt:new Date().toISOString(),query:{q:"worker binding"}});
  assert.deepEqual(out.job.embedding.gateway,{route:route.route,actualModel:route.actualModel});
  const before=hits;
  process.env.RESEARCH_SEMANTIC_ROUTE="changed/route/stream";
  try {assert.deepEqual(await executeSemanticQuery(out.id,out.job),{status:"failed",reason:"embedding_profile_changed",receiptId:null});}
  finally {process.env.RESEARCH_SEMANTIC_ROUTE=route.route;}
  assert.equal(hits,before);
  const first=await executeSemanticQuery(out.id,out.job);assert.equal(first.status,"ready");
  process.env.RESEARCH_SEMANTIC_REGISTRY_REVISION="b".repeat(64);
  assert.deepEqual(await executeSemanticQuery(out.id,out.job),first);assert.equal(hits,before+1);
});
