import { tag,stub,Reply } from "./setup.ts";
import assert from "node:assert/strict";
import { after,before,test } from "node:test";
import { randomUUID,createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

process.env.COLLECT_ENABLED="false";
process.env.MODEL_CALLS_ENABLED="true"; // The only provider is the loopback stub below.
process.env.EMBEDDING_API_KEY="local-test-only";
process.env.EMBEDDING_MODEL="semantic-test-model";
process.env.EMBEDDING_DIMS="3";
process.env.RESEARCH_SEMANTIC_MODEL="semantic-test-model";
process.env.RESEARCH_SEMANTIC_DIMS="3";
process.env.RESEARCH_SEMANTIC_PROFILE="title-summary-v1";
process.env.RESEARCH_SEMANTIC_PROVIDER="local-test-stub";
delete process.env.LLM_GATEWAY_URL;
const provider=await stub(async(_hit,req)=>{
  const body=JSON.parse(req.body);
  if (body.input[0]==="timeout") await new Promise(resolve=>setTimeout(resolve,150));
  if (body.input[0]==="invalid-vector") return {data:[{index:0,embedding:[0,0,0]}]};
  if (body.input[0]==="rejected") return new Reply(400,{error:{message:"fixture rejection"}});
  return {data:[{index:0,embedding:[1,0,0]}],usage:{prompt_tokens:5,total_tokens:5}};
});
process.env.EMBEDDING_BASE_URL=provider.url;
const {sql,closeDb}=await import("@aihot/backend/db");
const {config}=await import("@aihot/backend/config");
const {documentId}=await import("@aihot/backend/research/read");
const {submitSemanticQuery,getSemanticJob,QUERY_TTL_MS}=await import("@aihot/backend/research/semantic");
const {executeSemanticQuery,registerSemanticJobs}=await import("@aihot/backend/jobs/semantic");
const {getBoss,stopBoss,QUEUES}=await import("@aihot/backend/jobs/queue");
const {buildApp}=await import("../apps/api/src/app.ts");
const app=await buildApp();
const token=`semantic-${tag()}`,other=`other-${tag()}`;
const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
const owner=digest(token),otherOwner=digest(other),source=`semantic-${tag()}`;
let base:string;
const envelope=(q="find article")=>({requestId:randomUUID(),createdAt:new Date().toISOString(),query:{q,source:[source],limit:10}});
async function request(method:string,path:string,body?:unknown,auth=token) {
  const response=await fetch(`${base}/api/private/v3${path}`,{method,headers:{authorization:`Bearer ${auth}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal(response.headers.get("cache-control"),"no-store");
  return {status:response.status,data:await response.json() as any};
}
async function done(input:unknown=envelope()) {
  const out=await submitSemanticQuery(owner,input);
  const result=await executeSemanticQuery(out.id,out.job);
  await (await getBoss()).complete(QUEUES.semanticQuery,out.id,result,{includeQueued:true});
  return {...out,result};
}
async function article(title:string,vector:number[]|null,opts:{summary?:string;hash?:string;model?:string;revision?:number;publicationRevision?:number;published?:string}={}) {
  const id=tag(),key=`url:https://semantic.test/${id}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,content_hash,published_at,discovered_at,timeline_at,revision)
    VALUES(${id},${source},${key},${`https://semantic.test/${id}`},${title},'full body retained',${id},${opts.published??'2026-01-05T00:00:00Z'},now(),now(),${opts.revision??1})`;
  if (opts.summary!==undefined) {
    const [analysis]=await sql`INSERT INTO analyses(article_id,input_revision,origin,title_zh,summary_zh) VALUES(${id},${opts.publicationRevision??opts.revision??1},'rule',${title},${opts.summary}) RETURNING id`;
    await sql`INSERT INTO publications(article_id,analysis_id,revision,title,summary,source_id,channel,url,discovered_at,timeline_at,sort_at,selected)
      VALUES(${id},${analysis!.id},${opts.publicationRevision??opts.revision??1},${title},${opts.summary},${source},'news',${`https://semantic.test/${id}`},now(),now(),now(),true)`;
  }
  if (vector) await sql`INSERT INTO embeddings(kind,ref_id,model,text_hash,vector) VALUES('article',${id},${opts.model??process.env.EMBEDDING_MODEL!},${opts.hash??digest(`${title}。${(opts.summary??'').slice(0,300)}`)},${vector})`;
  return {id,doc:documentId(key)};
}
before(async()=>{
  process.env.RESEARCH_TOKEN_SHA256=`${owner},${otherOwner}`;
  process.env.RESEARCH_SEMANTIC_TOKEN_SHA256=`${owner},${otherOwner}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES(${source},${source},'rss')`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('embedding',1000,1000,1000) ON CONFLICT(service) DO UPDATE SET per_minute=1000,per_hour=1000,per_day=1000`;
  await sql`UPDATE research_index_state SET articles_complete=true,materials_complete=true`;
  base=await app.listen({port:0,host:"127.0.0.1"});
});
after(async()=>{await app.close();await stopBoss();await closeDb();await provider.close();});

test("POST requires both capabilities; ownership, sync/concurrent replay and payload conflict",async()=>{
  delete process.env.RESEARCH_SEMANTIC_TOKEN_SHA256;
  assert.equal((await request("POST","/semantic-queries",envelope())).status,403);
  process.env.RESEARCH_SEMANTIC_TOKEN_SHA256=`${owner},${otherOwner}`;
  const input=envelope(),beforeHits=provider.hits();
  const responses=await Promise.all(Array.from({length:6},()=>request("POST","/semantic-queries",input)));
  assert.ok(responses.every(r=>[200,202].includes(r.status)),JSON.stringify(responses));
  assert.equal(new Set(responses.map(r=>r.data.id)).size,1);
  assert.equal(provider.hits(),beforeHits,"HTTP never calls embeddings");
  const id=responses[0]!.data.id;
  assert.equal((await request("GET",`/semantic-queries/${id}`,undefined,other)).status,404);
  assert.equal((await request("POST","/semantic-queries",{...input,query:{...input.query,q:"different"}})).status,409);
  assert.equal((await request("POST","/semantic-queries",input)).data.id,id);
  assert.equal((await request("POST","/semantic-queries",envelope(),"wrong")).status,401);
});

test("expired identity cannot recreate after cleanup; future skew and invalid filters reject",async()=>{
  const input=envelope();input.createdAt=new Date(Date.now()-QUERY_TTL_MS-1).toISOString();
  assert.equal((await request("POST","/semantic-queries",input)).status,410);
  const out=await submitSemanticQuery(owner,envelope());
  await sql`UPDATE pgboss.job SET data=jsonb_set(data,'{expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=${out.id}::uuid AND name=${QUEUES.semanticQuery}`;
  assert.equal((await request("GET",`/semantic-queries/${out.id}`)).data.status,"expired");
  await sql`DELETE FROM pgboss.job WHERE id=${out.id}::uuid AND name=${QUEUES.semanticQuery}`;
  assert.equal((await request("POST","/semantic-queries",{...input,requestId:out.job.requestId})).status,410);
  assert.notEqual((await submitSemanticQuery(owner,{...envelope(),requestId:out.job.requestId})).job.createdAt,input.createdAt);
  assert.equal((await request("POST","/semantic-queries",{...envelope(),createdAt:new Date(Date.now()+120000).toISOString()})).status,400);
  assert.equal((await request("POST","/semantic-queries",{...envelope(),query:{q:"x",source:["unknown-source"]}})).status,400);
});

test("live ranking partitions coverage, excludes hidden inputs, preserves v2 summaries and full reads",async()=>{
  const good=await article("current",[1,0,0]),low=await article("other",[0,1,0]);
  await article("missing",null);await article("stale",[1,0,0],{hash:"wrong"});
  await article("dimensions",[1,0]);await article("different-model",[1,0,0],{model:"other-model"});
  await article("zero",[0,0,0]);
  const restricted=await article("restricted secret",[1,0,0]),discarded=await article("discarded secret",[1,0,0]),withdrawn=await article("withdrawn",[1,0,0]);
  await sql`INSERT INTO editorial_overrides(article_id,visibility,reason,updated_by) VALUES(${restricted.id},'summary-only','fixture','fixture'),(${withdrawn.id},'withdrawn','fixture','fixture')`;
  await sql`UPDATE articles SET content_discarded_at=now() WHERE id=${discarded.id}`;
  const out=await done(),res=await request("GET",`/semantic-queries/${out.id}`);
  assert.equal(res.status,200,JSON.stringify(res.data));assert.equal(res.data.status,"ready");
  assert.deepEqual(res.data.result.items.map((r:any)=>r.id),[good.doc,low.doc]);
  assert.deepEqual(res.data.result.coverage,{total:9,eligible:2,missing:1,stale:1,incompatible:3,policyExcluded:2});
  assert.equal(res.data.receipt.usage.total_tokens,5);assert.equal(res.data.receipt.cost,null);
  assert.equal(res.data.result.items[0].score,1);assert.deepEqual(res.data.result.items[0].matches,[]);
  assert.equal(res.data.embedding.profile,"title-summary-v1");
  const serialized=JSON.stringify(res.data);assert.ok(!serialized.includes(owner));assert.ok(!serialized.includes('"vector"'));assert.ok(!serialized.includes("full body retained"));
  const body=await request("GET",`/articles/${good.doc}`);assert.equal(body.data.body.text,"full body retained");
  await sql`UPDATE articles SET title='changed revision',revision=2 WHERE id=${good.id}`;
  const changed=await request("GET",`/semantic-queries/${out.id}`);assert.ok(!changed.data.result.items.some((r:any)=>r.id===good.doc));assert.equal(changed.data.result.coverage.stale,2);
});

test("current analysis/revision and UTF16 profile hash; source/group/time/selected scopes",async()=>{
  const emoji="🦉".repeat(155),a=await article("unicode",[1,0,0],{summary:emoji});
  const b=await article("raw revision",[1,0,0],{revision:2,publicationRevision:1,summary:"old generated"});
  await sql`INSERT INTO analyses(article_id,input_revision,origin,title_zh,summary_zh) VALUES(${b.id},1,'rule','old','old'),(${b.id},2,'rule','current analysis','current summary')`;
  await sql`UPDATE embeddings SET text_hash=${digest('current analysis。current summary')} WHERE ref_id=${b.id}`;
  const input=envelope();input.query.q="scope";
  const out=await done(input),r=await request("GET",`/semantic-queries/${out.id}`);
  assert.ok([a.doc,b.doc].every(id=>r.data.result.items.some((x:any)=>x.id===id)));
  const group=`empty-${tag()}`;await sql`INSERT INTO research_groups(id,name) VALUES(${group},${group})`;
  const empty=await done({...envelope(),query:{q:"empty",source:[],group:[group],limit:10}} as any).catch(e=>e);
  // Empty selector arrays are invalid, while a real empty group is a valid empty scope.
  assert.ok(empty instanceof Error);
  const e=await done({...envelope(),query:{q:"empty",group:[group],limit:10}} as any);
  assert.equal((await request("GET",`/semantic-queries/${e.id}`)).data.result.coverage.total,0);
  const filtered=await done({...envelope(),query:{q:"selected",source:[source],selected:true,timeField:"published",from:"2026-01-05T00:00:00Z",to:"2026-01-06T00:00:00Z",limit:10}} as any);
  const selected=await request("GET",`/semantic-queries/${filtered.id}`);assert.deepEqual(selected.data.result.items.map((r:any)=>r.id),[a.doc]);
});

test("received/completed receipt survives lost job output without another paid dispatch",async()=>{
  const out=await submitSemanticQuery(owner,envelope("restart-query")),beforeHits=provider.hits();
  const child=await promisify(execFile)(process.execPath,["--input-type=module","-e",`
    const { getSemanticJob } = await import('@aihot/backend/research/semantic');
    const { executeSemanticQuery } = await import('@aihot/backend/jobs/semantic');
    const { stopBoss } = await import('@aihot/backend/jobs/queue');
    const { closeDb } = await import('@aihot/backend/db');
    const job=await getSemanticJob(process.env.TEST_OWNER,process.env.TEST_JOB);
    console.log(JSON.stringify(await executeSemanticQuery(job.id,job.data)));
    await stopBoss();await closeDb();
  `],{env:{...process.env,TEST_OWNER:owner,TEST_JOB:out.id},timeout:30000});
  const first=JSON.parse(child.stdout);
  const second=await executeSemanticQuery(out.id,out.job);
  assert.deepEqual(second,first);assert.equal(provider.hits()-beforeHits,1);
  await (await getBoss()).complete(QUEUES.semanticQuery,out.id,second,{includeQueued:true});
  assert.equal((await getSemanticJob(owner,out.id)).id,out.id);
});

test("publication counter is not article input revision; current analysis remains readable and selected",async()=>{
  const a=await article("current input",[1,0,0],{summary:"current generated summary"});
  await sql`UPDATE publications SET revision=3 WHERE article_id=${a.id}`;
  const detail=await request("GET",`/articles/${a.doc}`);
  assert.equal(detail.data.summary,"current generated summary");assert.equal(detail.data.selected,true);
  const out=await done({...envelope(),query:{q:"publication revision",source:[source],selected:true,limit:100}});
  const r=await request("GET",`/semantic-queries/${out.id}`);
  assert.ok(r.data.result.items.some((x:any)=>x.id===a.doc));
  await sql`UPDATE articles SET revision=2,title='new raw title' WHERE id=${a.id}`;
  await sql`UPDATE publications SET revision=2 WHERE article_id=${a.id}`;
  const stale=await request("GET",`/semantic-queries/${out.id}`);
  assert.ok(!stale.data.result.items.some((x:any)=>x.id===a.doc));
  assert.equal((await request("GET",`/articles/${a.doc}`)).data.summary,null);
});

test("raw/manual publications without analysis retain summaries and selected, independent of counters",async()=>{
  const manual=await article("manual title",[1,0,0],{summary:"manual summary"});
  await sql`UPDATE publications SET analysis_id=NULL,revision=77 WHERE article_id=${manual.id}`;
  await sql`INSERT INTO editorial_overrides(article_id,visibility,fields,reason,updated_by)
    VALUES(${manual.id},'public',${sql.json({title:"manual title",summary:"manual summary",selected:true})},'fixture','fixture')`;
  const detail=await request("GET",`/articles/${manual.doc}`);assert.equal(detail.data.summary,"manual summary");assert.equal(detail.data.selected,true);
  const raw=await article("raw publication",[1,0,0]);
  await sql`INSERT INTO publications(article_id,revision,title,source_id,channel,url,discovered_at,timeline_at,sort_at)
    VALUES(${raw.id},88,'raw publication',${source},'news',${`https://semantic.test/${raw.id}`},now(),now(),now())`;
  const out=await done({...envelope(),query:{q:"manual raw",source:[source],limit:100}});
  const res=await request("GET",`/semantic-queries/${out.id}`);
  assert.ok([manual.doc,raw.doc].every(id=>res.data.result.items.some((r:any)=>r.id===id)));
  await sql`UPDATE articles SET title='changed raw title',revision=2 WHERE id=${raw.id}`;
  const changed=await request("GET",`/semantic-queries/${out.id}`);assert.ok(!changed.data.result.items.some((r:any)=>r.id===raw.doc));
  assert.ok(changed.data.result.items.some((r:any)=>r.id===manual.doc));
});

test("revocation before work, after result, and profile/provider changes are live",async()=>{
  const out=await done(envelope("access-check"));
  process.env.RESEARCH_SEMANTIC_TOKEN_SHA256=otherOwner;
  assert.equal((await request("GET",`/semantic-queries/${out.id}`)).status,403);
  const beforeHits=provider.hits();assert.equal((await executeSemanticQuery(out.id,out.job) as any).reason,"semantic_forbidden");assert.equal(provider.hits(),beforeHits);
  process.env.RESEARCH_SEMANTIC_TOKEN_SHA256=`${owner},${otherOwner}`;
  process.env.RESEARCH_TOKEN_SHA256=otherOwner;assert.equal((await request("GET",`/semantic-queries/${out.id}`)).status,401);process.env.RESEARCH_TOKEN_SHA256=`${owner},${otherOwner}`;
  process.env.RESEARCH_SEMANTIC_PROVIDER="changed";assert.equal((await request("GET",`/semantic-queries/${out.id}`)).status,409);process.env.RESEARCH_SEMANTIC_PROVIDER="local-test-stub";
  process.env.EMBEDDING_BASE_URL="http://127.0.0.1:1";assert.equal((await request("GET",`/semantic-queries/${out.id}`)).status,409);process.env.EMBEDDING_BASE_URL=provider.url;
  delete process.env.RESEARCH_SEMANTIC_PROFILE;assert.equal((await request("POST","/semantic-queries",envelope())).data.error,"embedding_profile_unverified");process.env.RESEARCH_SEMANTIC_PROFILE="title-summary-v1";
});

test("models off, missing/exhausted budget, invalid provider vectors and unknown are explicit failures",async(t)=>{
  let out=await submitSemanticQuery(owner,envelope("off"));config.modelCallsEnabled=false;
  assert.equal((await executeSemanticQuery(out.id,out.job) as any).reason,"model_calls_unavailable");config.modelCallsEnabled=true;
  await sql`UPDATE budgets SET per_day=0 WHERE service='embedding'`;
  out=await submitSemanticQuery(owner,envelope("budget"));assert.equal((await executeSemanticQuery(out.id,out.job) as any).reason,"embedding_budget_unconfigured");
  await sql`UPDATE budgets SET per_day=1000,per_minute=1 WHERE service='embedding'`;
  out=await submitSemanticQuery(owner,envelope("budget-exhausted"));assert.equal((await executeSemanticQuery(out.id,out.job) as any).reason,"embedding_budget_exhausted");
  await sql`UPDATE budgets SET per_minute=1000 WHERE service='embedding'`;
  const invalid=await done(envelope("invalid-vector"));assert.equal((invalid.result as any).reason,"receipt_unknown");
  const hits=provider.hits(),again=await executeSemanticQuery(invalid.id,invalid.job);assert.equal((again as any).reason,"receipt_unknown");assert.equal(provider.hits(),hits);
  const rejected=await done(envelope("rejected"));assert.equal((rejected.result as any).reason,"embedding_provider_rejected");
  const originalTimeout=AbortSignal.timeout.bind(AbortSignal);
  const timer=t.mock.method(AbortSignal,"timeout",(ms:number)=>{assert.equal(ms,60000);return originalTimeout(10);});
  const timed=await done(envelope("timeout"));timer.mock.restore();
  assert.equal((timed.result as any).reason,"receipt_unknown");
  const timedStatus=await request("GET",`/semantic-queries/${timed.id}`);assert.equal(timedStatus.data.status,"failed");assert.equal(timedStatus.data.receipt.status,"unknown");
  const r=await request("GET",`/semantic-queries/${invalid.id}`);assert.equal(r.data.status,"failed");assert.equal(r.data.reason,"receipt_unknown");assert.ok(r.data.receipt.id);assert.equal(r.data.receipt.cost,null);
});

test("native retry preserves ID and pending receipts never cause duplicate dispatch",async()=>{
  await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.semanticQuery} AND state IN ('created','retry')`;
  const out=await submitSemanticQuery(owner,envelope("pending-retry")),boss=await getBoss();
  const first=await executeSemanticQuery(out.id,out.job);
  assert.equal(first.status,"ready");if (first.status!=="ready") return;
  const hits=provider.hits();
  await sql`UPDATE receipts SET status='pending',updated_at=now() WHERE id=${first.receiptId}`;
  const [claimed]=await boss.fetch(QUEUES.semanticQuery);assert.equal(claimed!.id,out.id);
  await assert.rejects(executeSemanticQuery(out.id,out.job),/semantic_receipt_pending/);
  await boss.fail(QUEUES.semanticQuery,out.id,{reason:"semantic_receipt_pending"});
  assert.equal((await getSemanticJob(owner,out.id)).state,"retry");
  await sql`UPDATE receipts SET status='received' WHERE id=${first.receiptId}`;
  await sql`UPDATE pgboss.job SET start_after=now() WHERE id=${out.id}::uuid AND name=${QUEUES.semanticQuery}`;
  const [retried]=await boss.fetch(QUEUES.semanticQuery);assert.equal(retried!.id,out.id);
  const result=await executeSemanticQuery(out.id,out.job);assert.equal(result.status,"ready");assert.equal(provider.hits(),hits);
  await boss.complete(QUEUES.semanticQuery,out.id,result);
  assert.equal((await getSemanticJob(owner,out.id)).retryCount,1);
});

test("admission capacity is atomic and retained failures never become an empty successful result",async()=>{
  await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.semanticQuery} AND state IN ('created','retry')`;
  const entries=await Promise.all(Array.from({length:66},()=>submitSemanticQuery(owner,envelope("capacity")).then(value=>({value,error:null})).catch(error=>({value:null,error}))));
  assert.equal(entries.filter(r=>r.value).length,64);assert.equal(entries.filter(r=>r.error?.code==="semantic_capacity_exhausted").length,2);
  const job=entries.find(r=>r.value)!.value!;
  await sql`UPDATE pgboss.job SET state='failed' WHERE name=${QUEUES.semanticQuery} AND id=${job.id}::uuid`;
  const failed=await request("GET",`/semantic-queries/${job.id}`);assert.equal(failed.data.status,"failed");assert.equal(failed.data.result,undefined);
  await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.semanticQuery} AND state IN ('created','retry')`;
});

test("post-completion withdrawal and restriction change live coverage without re-encoding",async()=>{
  const a=await article("live permission",[1,0,0]),out=await done({...envelope(),query:{q:"live policy",source:[source],limit:100}});
  const before=await request("GET",`/semantic-queries/${out.id}`),hits=provider.hits();
  assert.ok(before.data.result.items.some((r:any)=>r.id===a.doc));
  await sql`INSERT INTO editorial_overrides(article_id,visibility,reason,updated_by) VALUES(${a.id},'summary-only','fixture','fixture')`;
  const restricted=await request("GET",`/semantic-queries/${out.id}`);
  assert.ok(!restricted.data.result.items.some((r:any)=>r.id===a.doc));assert.equal(restricted.data.result.coverage.policyExcluded,before.data.result.coverage.policyExcluded+1);
  await sql`UPDATE editorial_overrides SET visibility='withdrawn' WHERE article_id=${a.id}`;
  const withdrawn=await request("GET",`/semantic-queries/${out.id}`);assert.equal(withdrawn.data.result.coverage.total,before.data.result.coverage.total-1);assert.equal(provider.hits(),hits);
});

test("native worker completes the submitted job identity and v1/v2 endpoints stay frozen",async()=>{
  // Remove unprocessed fixtures before starting the real queue consumer.
  await sql`DELETE FROM pgboss.job WHERE name=${QUEUES.semanticQuery} AND state IN ('created','retry')`;
  await registerSemanticJobs(await getBoss());
  const out=await request("POST","/semantic-queries",envelope("worker-integration"));
  assert.equal(out.status,202);const deadline=Date.now()+15000;
  let response:any;
  do {response=await request("GET",`/semantic-queries/${out.data.id}`);if (response.data.status==="ready") break;await new Promise(r=>setTimeout(r,100));} while(Date.now()<deadline);
  assert.equal(response.data.status,"ready",JSON.stringify(response));assert.equal(response.data.id,out.data.id);
  assert.equal((await fetch(`${base}/api/private/v2/semantic-queries`,{method:"POST",headers:{authorization:`Bearer ${token}`}})).status,404);
  const v1=await fetch(`${base}/api/private/v1/openapi.json`,{headers:{authorization:`Bearer ${token}`}});const contract=await v1.json() as any;
  const {researchOpenApi}=await import('@aihot/contracts/research');assert.deepEqual(contract,researchOpenApi);assert.ok(!('/semantic-queries' in contract.paths));
});
