import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { paidRequest, logicalKeyFor } from '@aihot/backend/providers/receipts';
import { GatewayResponseError } from '@aihot/backend/providers/gateway-error';
import { withReconsideration, reconsiderationBatchStopped } from '@aihot/backend/providers/reconsideration';
import { createReceiptRecoveryBatch, advanceReceiptRecoveryBatch, settleReceiptRecoveryBatch, receiptRecoveryStatus } from '@aihot/backend/admin/receipt-batch-recovery';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { settleReceiptReviews } from '@aihot/backend/admin/receipt-reviews';

after(async () => { await stopBoss(); await closeDb(); });
const failure = (id: string, policy = false) => new GatewayResponseError(400,id,{version:1,httpStatus:400,category:policy?'content_policy_rejected':'invalid_request',providerCode:null,retryable:false});
async function fixture(purpose='prefilter_article', subject?: string) {
  if (!subject) {
    const id=tag(), source=tag();
    await sql`INSERT INTO sources(id,name,kind,enabled) VALUES(${source},'test','rss',false)`;
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,processing_state,body_status,discovered_at,timeline_at)
      VALUES(${id},${source},${id},${`https://example.test/${id}`},'test','failed','ok',now(),now())`;
    subject=`article:${id}@1`;
  }
  const req={service:'reconsider-test',purpose,subject,model:'fixture',identity:{id:tag()},gatewayRequestId:randomUUID(),gatewayRecovery:true,outputMaxAttempts:3,
    requestSummary:{gateway:{baseUrl:'http://127.0.0.1:1',project:'fixture',mode:'personal',model:'fixture',routes:[{provider:'fixture'}],registryRevision:'fixture',retry:{maxAttempts:1}}}};
  await assert.rejects(paidRequest(req,async()=>{throw failure(req.gatewayRequestId);}));
  const [r]=await sql`SELECT * FROM receipts WHERE logical_key=${logicalKeyFor(req)}`;
  const snapshot={id:Number(r!.id),attempt:1,requestId:req.gatewayRequestId,logicalKey:logicalKeyFor(req)};
  const ref={receiptId:snapshot.id,attempt:1};
  return {req,snapshot,ref,batch:tag()};
}
async function authorize(f: Awaited<ReturnType<typeof fixture>>) {
  await createReceiptRecoveryBatch(f.batch,'fixture explicit one generation',undefined,{receipts:[f.snapshot],acceptDuplicateCharge:true});
  await advanceReceiptRecoveryBatch(f.batch,6);
}
const ok=async()=>({response:{ok:true}});

for(const changedKey of [false,true]) test(`one authorized generation, changed input=${changedKey}, original bill preserved`,async()=>{
  const f=await fixture();
  const before=await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${f.snapshot.id}`;
  let calls=0;
  await assert.rejects(paidRequest(f.req,async()=>{calls++;return ok();}));
  assert.equal(calls,0);
  await authorize(f);
  const req={...f.req,gatewayRequestId:randomUUID(),...(changedKey?{identity:{id:tag()}}:{})};
  const result=await withReconsideration(f.ref,()=>paidRequest(req,async()=>{calls++;return ok();}));
  assert.equal(calls,1);
  assert.equal((await withReconsideration(f.ref,()=>paidRequest(req,async()=>{calls++;return ok();}))).reused,true);
  assert.equal(calls,1);
  assert.deepEqual(await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${f.snapshot.id} AND attempt=1`,before);
  assert.equal((await createReceiptRecoveryBatch(f.batch,'repeat',undefined,{receipts:[f.snapshot],acceptDuplicateCharge:true})).reused,true);
  await assert.rejects(withReconsideration(f.ref,()=>paidRequest({...req,identity:{id:tag()}},ok)),/consumed/);
  assert.ok(result.receiptId);
  // A genuinely later, different logical request outside this recovery execution remains normal.
  await paidRequest({...req,identity:{id:tag()}},ok);
});

test('concurrent same and different keys share one atomic generation',async()=>{
  for(const different of [false,true]) {
    const f=await fixture();await authorize(f);let calls=0;
    const outcomes=await Promise.allSettled([0,1].map(i=>withReconsideration(f.ref,()=>paidRequest({...f.req,gatewayRequestId:randomUUID(),...(different?{identity:{id:`${tag()}-${i}`}}:{})},async()=>{calls++;await new Promise(r=>setTimeout(r,30));return ok();}))));
    assert.equal(calls,1);assert.ok(outcomes.some(r=>r.status==='fulfilled'));
  }
});

test('new rejection stops cohort; a consumed failed generation cannot escape through ordinary retries',async()=>{
  const f=await fixture();await authorize(f);
  const req={...f.req,identity:{id:tag()},gatewayRequestId:randomUUID()};
  await assert.rejects(withReconsideration(f.ref,()=>paidRequest(req,async()=>{throw failure(req.gatewayRequestId);}))); 
  assert.equal(await reconsiderationBatchStopped(sql,f.batch),true);
  await assert.rejects(withReconsideration(f.ref,()=>paidRequest({...req,identity:{id:tag()}},ok)),/consumed/);
  const [consumed]=await sql`SELECT id FROM receipts WHERE logical_key=${logicalKeyFor(req)}`;
  // Model-output or transport failure does not renew the one-generation authority.
  await sql`UPDATE receipts SET status='failed' WHERE id=${consumed!.id}`;
  await sql`UPDATE receipt_attempts SET error_details=NULL,error=NULL WHERE receipt_id=${consumed!.id}`;
  await assert.rejects(paidRequest(req,ok),/consumed/);
});

for(const change of ['uuid','key','attempt','stop','policy','consent']) test(`authorization rejects ${change}`,async()=>{
  const f=await fixture();const s={...f.snapshot};
  if(change==='uuid')s.requestId=randomUUID();
  if(change==='key')s.logicalKey+='changed';
  if(change==='attempt')s.attempt++;
  if(change==='stop')await sql`UPDATE receipt_reviews SET disposition='stopped' WHERE receipt_id=${s.id}`;
  if(change==='policy')await sql`UPDATE receipt_attempts SET error_details='{"version":1,"httpStatus":400,"category":"content_policy_rejected"}' WHERE receipt_id=${s.id}`;
  await assert.rejects(createReceiptRecoveryBatch(f.batch,'fixture',undefined,{receipts:[s],acceptDuplicateCharge:change!=='consent'}));
  assert.equal((await sql`SELECT count(*)::int n FROM receipt_recoveries WHERE batch=${f.batch}`)[0]!.n,0);
});

test('worker rechecks changed revision, model, subject and stopped disposition',async()=>{
  for(const change of ['revision','model','subject','stop']) {
    const f=await fixture();await authorize(f);
    if(change==='revision')await sql`UPDATE articles SET revision=2 WHERE id=${f.req.subject.split(':')[1]!.split('@')[0]!}`;
    if(change==='stop')await sql`UPDATE receipt_reviews SET disposition='stopped' WHERE receipt_id=${f.snapshot.id}`;
    await assert.rejects(withReconsideration(f.ref,()=>paidRequest({...f.req,...(change==='model'?{model:'different'}:{}),...(change==='subject'?{subject:f.req.subject+'changed'}:{})},ok)));
  }
});

test('report pilots precede article admission and require persisted report business results',async()=>{
  const a=await fixture(),d=await fixture('report_lead','report:daily:2026-10-26'),w=await fixture('report_weekly','report:weekly:2026-W43');
  const batch=tag();await createReceiptRecoveryBatch(batch,'pilot',undefined,{receipts:[a.snapshot,d.snapshot,w.snapshot],acceptDuplicateCharge:true});
  await advanceReceiptRecoveryBatch(batch,6);
  const rows=await sql`SELECT receipt_id,state,evidence FROM receipt_recoveries WHERE batch=${batch}`;
  assert.equal(rows.find(r=>r.receipt_id===a.snapshot.id)!.state,'planned');
  for(const f of [d,w]) {
    const r=rows.find(r=>r.receipt_id===f.snapshot.id)!;assert.equal(r.state,'queued');
    const [job]=await sql`SELECT data FROM pgboss.job WHERE id=${r.evidence.jobId}`;assert.deepEqual(job!.data.reconsideration,f.ref);
  }
  await settleReceiptRecoveryBatch(batch);
  assert.equal((await receiptRecoveryStatus(batch)).counts.recovered,undefined);
});

test('Gateway changes are rejected before a new call, while fresh UUID and key remain allowed',async()=>{
  const f=await fixture();await authorize(f);let calls=0;
  for(const change of [{baseUrl:'http://127.0.0.1:2'},{project:'different'},{mode:'company'},{routes:[{provider:'other'}]},{registryRevision:'other'},{retry:{maxAttempts:2}}]) {
    await assert.rejects(withReconsideration(f.ref,()=>paidRequest({...f.req,identity:{id:tag()},gatewayRequestId:randomUUID(),requestSummary:{gateway:{...f.req.requestSummary.gateway,...change}}},async()=>{calls++;return ok();})),/Gateway/);
  }
  assert.equal(calls,0);
  await withReconsideration(f.ref,()=>paidRequest({...f.req,identity:{id:tag()},gatewayRequestId:randomUUID(),requestSummary:{gateway:{...f.req.requestSummary.gateway,logicalRequestId:randomUUID()}}},async()=>{calls++;return ok();}));
  assert.equal(calls,1);
});

test('score votes are outside the explicit reconsideration scope',async()=>{
  const f=await fixture('score_article');
  await assert.rejects(authorize(f),/不符合授权/);
  assert.equal((await sql`SELECT count(*)::int n FROM receipt_recoveries WHERE batch=${f.batch}`)[0]!.n,0);
});

test('empty report without a successful pilot call never releases the remaining cohort',async()=>{
  const d=await fixture('report_lead','report:daily:2098-01-01'),a=await fixture();
  await createReceiptRecoveryBatch(d.batch,'pilot',undefined,{receipts:[d.snapshot,a.snapshot],acceptDuplicateCharge:true});
  await advanceReceiptRecoveryBatch(d.batch,6);
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('daily','2098-01-01',now(),now(),'{}',now())
    ON CONFLICT(kind,key) DO UPDATE SET generated_at=now()`;
  const [r]=await sql`SELECT evidence FROM receipt_recoveries WHERE receipt_id=${d.snapshot.id}`;
  await sql`UPDATE pgboss.job SET state='completed' WHERE id=${r!.evidence.jobId}`;
  const result=await advanceReceiptRecoveryBatch(d.batch,6);
  assert.equal(result.results[0]?.result,'report_pilot_failed');
  assert.equal(result.counts.blocked,1);assert.equal(result.counts.planned,1);
});

test('successful pilot call and persisted report release the next target',async()=>{
  const d=await fixture('report_lead','report:daily:2098-01-02'),a=await fixture();
  await createReceiptRecoveryBatch(d.batch,'pilot',undefined,{receipts:[d.snapshot,a.snapshot],acceptDuplicateCharge:true});
  await advanceReceiptRecoveryBatch(d.batch,6);
  await withReconsideration(d.ref,()=>paidRequest({...d.req,gatewayRequestId:randomUUID()},ok));
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('daily','2098-01-02',now(),now(),'{"lead":"fixture"}',now())
    ON CONFLICT(kind,key) DO UPDATE SET generated_at=now()`;
  const result=await advanceReceiptRecoveryBatch(d.batch,6);
  assert.equal(result.counts.recovered,1);assert.equal(result.counts.queued,1);
});

test('terminal report and monitor jobs without business proof become blocked',async()=>{
  for(const state of ['failed','cancelled','completed']) for(const monitor of [false,true]) {
    const f=monitor?await fixture('monitor.recognize',`x:${tag()}`):await fixture('report_lead',`report:daily:2098-02-${state==='failed'?'01':state==='cancelled'?'02':'03'}`);
    await authorize(f);
    const [r]=await sql`SELECT evidence FROM receipt_recoveries WHERE receipt_id=${f.snapshot.id}`;
    await sql`UPDATE pgboss.job SET state=${state}::pgboss.job_state WHERE id=${r!.evidence.jobId}`;
    await settleReceiptRecoveryBatch(f.batch);
    assert.equal((await receiptRecoveryStatus(f.batch)).counts.blocked,1);
  }
});

test('business supersession retains consumed authorization and the batch rejection stop',async()=>{
  const [story]=await sql`INSERT INTO stories(public_id,title,digest,version) VALUES(${randomUUID()},'fixture','这是一份完整而有效的事件综述。',1) RETURNING id`;
  const f=await fixture('story_digest',`story:${story!.id}@1`);await authorize(f);
  const req={...f.req,identity:{id:tag()},gatewayRequestId:randomUUID()};
  await assert.rejects(withReconsideration(f.ref,()=>paidRequest(req,async()=>{throw failure(req.gatewayRequestId);}))); 
  const success=await paidRequest({...req,identity:{id:tag()},purpose:'fixture'},ok);
  await sql`UPDATE receipts SET status='completed' WHERE id=${success.receiptId}`;
  await sql`INSERT INTO story_digests(story_id,version,digest,receipt_id) VALUES(${story!.id},1,'这是一份完整而有效的事件综述。',${success.receiptId})`;
  await settleReceiptReviews();
  const [v]=await sql`SELECT disposition,evidence FROM receipt_reviews WHERE receipt_id=${f.snapshot.id} AND attempt=1`;
  assert.equal(v!.disposition,'superseded');assert.ok(v!.evidence.reconsideration.consumed);
  assert.equal(await reconsiderationBatchStopped(sql,f.batch),true);
});
