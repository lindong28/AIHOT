import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { paidRequest, logicalKeyFor } from '@aihot/backend/providers/receipts';
import { GatewayResponseError } from '@aihot/backend/providers/gateway-error';
import { withReconsideration } from '@aihot/backend/providers/reconsideration';
import { createReceiptRecoveryBatch, advanceReceiptRecoveryBatch, settleReceiptRecoveryBatch } from '@aihot/backend/admin/receipt-batch-recovery';
import { previewWebReceiptRecovery, createWebReceiptRecovery, resumeWebReceiptRecovery, webReceiptRecovery, advanceWebReceiptRecoveries } from '@aihot/backend/admin/receipt-recovery-web';
import { getBoss, stopBoss, enqueue } from '@aihot/backend/jobs/queue';
import { buildApp } from '../apps/api/src/app.ts';
import { config } from '@aihot/backend/config';

const batches: string[] = [];
const fixtureIds: number[] = [];
await getBoss();
afterEach(async () => {
  await sql`UPDATE pgboss.job SET state='cancelled' WHERE data->'reconsideration'->>'receiptId'=ANY(${fixtureIds.map(String)}::text[]) AND state IN ('created','retry','active')`;
  await sql`DELETE FROM receipt_recoveries WHERE batch=ANY(${batches}::text[])`;
  await sql`DELETE FROM receipt_recovery_batches WHERE batch=ANY(${batches}::text[])`;
});
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
  fixtureIds.push(snapshot.id);
  const ref={receiptId:snapshot.id,attempt:1};
  return {req,snapshot,ref,batch:tag()};
}

function body(fs: Awaited<ReturnType<typeof fixture>>[], batch = tag()) {
  batches.push(batch);
  return { batch, receipts: fs.map(f => f.snapshot), acceptDuplicateCharge: true, note: 'fixture explicit consent' };
}
const ok = async () => ({response:{ok:true}});

test('preview is read only and explains supported, stopped, policy, score, missing and duplicate targets', async () => {
  const good = await fixture(), stopped = await fixture(), policy = await fixture(), score = await fixture('score_article');
  const duplicate = await fixture('structure_article',good.req.subject);
  await sql`UPDATE receipt_reviews SET disposition='stopped' WHERE receipt_id=${stopped.snapshot.id}`;
  await sql`UPDATE receipt_attempts SET error_details='{"version":1,"category":"content_policy_rejected"}' WHERE receipt_id=${policy.snapshot.id}`;
  const before = await sql`SELECT * FROM receipts ORDER BY id`;
  const result = await previewWebReceiptRecovery([good.snapshot.id,stopped.snapshot.id,policy.snapshot.id,score.snapshot.id,duplicate.snapshot.id,99999999]);
  assert.deepEqual(result.rows.map(r=>r.eligible),[true,false,false,false,false,false]);
  assert.ok(result.rows.slice(1).every(r=>r.reason));
  assert.deepEqual(await sql`SELECT * FROM receipts ORDER BY id`,before);
  assert.equal((await sql`SELECT count(*)::int n FROM receipt_recoveries WHERE receipt_id=ANY(${fixtureIds}::bigint[])`)[0]!.n,0);
});

test('atomic create, identical replay, competing batches and stale UUID/key/attempt/disposition', async () => {
  const f = await fixture(), b = body([f]);
  const results = await Promise.all([createWebReceiptRecovery(b,'operator'),createWebReceiptRecovery(b,'operator')]);
  assert.equal(results.filter(r=>r.reused).length,1);
  assert.equal((await sql`SELECT actor FROM receipt_recovery_batches WHERE batch=${b.batch}`)[0]!.actor,'operator');
  assert.equal((await sql`SELECT count(*)::int n FROM receipt_recoveries WHERE receipt_id=${f.snapshot.id}`)[0]!.n,1);
  await assert.rejects(createWebReceiptRecovery(body([f]),'operator'));
  for (const change of ['uuid','key','attempt','stop','consent']) {
    const g = await fixture(), input = body([g]);
    if(change==='uuid') input.receipts[0]!.requestId=randomUUID();
    if(change==='key') input.receipts[0]!.logicalKey+='different';
    if(change==='attempt') input.receipts[0]!.attempt++;
    if(change==='stop') await sql`UPDATE receipt_reviews SET disposition='stopped' WHERE receipt_id=${g.snapshot.id}`;
    if(change==='consent') input.acceptDuplicateCharge=false;
    await assert.rejects(createWebReceiptRecovery(input,'operator'));
    assert.equal((await sql`SELECT count(*)::int n FROM receipt_recovery_batches WHERE batch=${input.batch}`)[0]!.n,0);
    assert.equal((await sql`SELECT count(*)::int n FROM receipt_recoveries WHERE batch=${input.batch}`)[0]!.n,0);
  }
  const g=await fixture();
  const race=await Promise.allSettled([createWebReceiptRecovery(body([g]),'a'),createWebReceiptRecovery(body([g]),'b')]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
});

test('all web cohorts share four in-flight targets, repeated ticks and concurrent admission do not flood',async()=>{
  const fs=[];for(let i=0;i<6;i++) fs.push(await fixture());
  const left=body(fs.slice(0,3)),right=body(fs.slice(3));
  await createWebReceiptRecovery(left,'a');await createWebReceiptRecovery(right,'a');
  await Promise.all([advanceReceiptRecoveryBatch(left.batch,4),advanceReceiptRecoveryBatch(right.batch,4)]);
  for(let i=0;i<2;i++) await advanceWebReceiptRecoveries();
  const rows=await sql`SELECT state,count(*)::int n FROM receipt_recoveries WHERE batch=ANY(${[left.batch,right.batch]}::text[]) GROUP BY state`;
  assert.equal(rows.find(r=>r.state==='queued')!.n,4);assert.equal(rows.find(r=>r.state==='planned')!.n,2);
  assert.equal((await sql`SELECT count(*)::int n FROM pgboss.job WHERE data->'reconsideration'->>'receiptId'=ANY(${fs.map(f=>String(f.snapshot.id))}::text[])`)[0]!.n,4);
});

test('unconsumed interrupted job resumes original authorization once; active job and changed identity block it',async()=>{
  const f=await fixture(), input=body([f]);await createWebReceiptRecovery(input,'operator');await advanceWebReceiptRecoveries();
  const [queued]=await sql`SELECT evidence FROM receipt_recoveries WHERE receipt_id=${f.snapshot.id}`;
  await sql`UPDATE receipt_recoveries SET state='blocked',evidence=evidence || '{"reason":"replay_failed"}'::jsonb WHERE receipt_id=${f.snapshot.id}`;
  await sql`UPDATE articles SET processing_state='failed' WHERE id=${f.req.subject.split(':')[1]!.split('@')[0]!}`;
  await assert.rejects(resumeWebReceiptRecovery(input.batch,{receiptIds:[f.snapshot.id],note:'resume'},'operator'),/仍在/);
  await sql`UPDATE pgboss.job SET state='failed' WHERE id=${queued!.evidence.jobId}`;
  await sql`UPDATE articles SET processing_state='failed' WHERE id=${f.req.subject.split(':')[1]!.split('@')[0]!}`;
  assert.equal((await webReceiptRecovery(input.batch))!.items[0]!.canResume,true);
  await sql`UPDATE receipts SET request_id=${randomUUID()} WHERE id=${f.snapshot.id}`;
  await assert.rejects(resumeWebReceiptRecovery(input.batch,{receiptIds:[f.snapshot.id],note:'resume'},'operator'),/身份/);
  await sql`UPDATE receipts SET request_id=${f.snapshot.requestId} WHERE id=${f.snapshot.id}`;
  await Promise.all([0,1].map(()=>resumeWebReceiptRecovery(input.batch,{receiptIds:[f.snapshot.id],note:'resume'},'operator')));
  const [resumed]=await sql`SELECT evidence FROM receipt_recoveries WHERE receipt_id=${f.snapshot.id}`;
  assert.equal(resumed!.evidence.jobId,queued!.evidence.jobId);assert.equal(resumed!.evidence.reason,'replay_failed');
  await advanceWebReceiptRecoveries();let calls=0;
  await withReconsideration(f.ref,()=>paidRequest({...f.req,gatewayRequestId:randomUUID()},async()=>{calls++;return ok();}));
  assert.equal(calls,1);
  await assert.rejects(resumeWebReceiptRecovery(input.batch,{receiptIds:[f.snapshot.id],note:'resume'},'operator'));
});

for(const changedKey of [false,true]) test(`consumed rejection cannot renew quota through a fresh web cohort; changed key ${changedKey}`,async()=>{
  const f=await fixture(), input=body([f]);await createWebReceiptRecovery(input,'operator');await advanceWebReceiptRecoveries();
  const before=await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${f.snapshot.id} AND attempt=1`;
  const req={...f.req,gatewayRequestId:randomUUID(),...(changedKey?{identity:{id:tag()}}:{})};
  await assert.rejects(withReconsideration(f.ref,()=>paidRequest(req,async()=>{throw failure(req.gatewayRequestId);}))); 
  await settleReceiptRecoveryBatch(input.batch);
  const [actual]=await sql`SELECT * FROM receipts WHERE logical_key=${logicalKeyFor(req)}`;
  const preview=await previewWebReceiptRecovery([actual!.id]);assert.equal(preview.rows[0]!.eligible,false);
  assert.match(preview.rows[0]!.reason!,/额度/);
  const second={...body([]),receipts:[{id:actual!.id,attempt:actual!.attempts,requestId:actual!.request_id,logicalKey:actual!.logical_key}]};
  await assert.rejects(createWebReceiptRecovery(second,'operator'));
  await assert.rejects(resumeWebReceiptRecovery(input.batch,{receiptIds:[f.snapshot.id],note:'resume'},'operator'),/消费/);
  assert.deepEqual(await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${f.snapshot.id} AND attempt=1`,before);
  const detail=await webReceiptRecovery(input.batch);assert.equal(detail!.stopped,true);assert.equal(detail!.items[0]!.consumed,true);
});

test('a new rejection prevents the remaining cohort from dispatching; CLI batches stay read-only',async()=>{
  const fs=[];for(let i=0;i<5;i++) fs.push(await fixture());
  const input=body(fs);await createWebReceiptRecovery(input,'operator');await advanceWebReceiptRecoveries();
  const [row]=await sql`SELECT receipt_id FROM receipt_recoveries WHERE batch=${input.batch} AND state='queued' ORDER BY receipt_id LIMIT 1`;
  const f=fs.find(f=>f.snapshot.id===row!.receipt_id)!;
  await assert.rejects(withReconsideration(f.ref,()=>paidRequest({...f.req,gatewayRequestId:randomUUID()},async()=>{throw failure(randomUUID());})));
  await advanceWebReceiptRecoveries();
  assert.equal((await sql`SELECT count(*)::int n FROM receipt_recoveries WHERE batch=${input.batch} AND state='planned'`)[0]!.n,1);
  const cli=await fixture();batches.push(cli.batch);
  await createReceiptRecoveryBatch(cli.batch,'cli',undefined,{receipts:[cli.snapshot],acceptDuplicateCharge:true});
  await advanceWebReceiptRecoveries();
  assert.equal((await webReceiptRecovery(cli.batch))!.web,false);
  assert.equal((await webReceiptRecovery(cli.batch))!.items[0]!.state,'planned');
  await assert.rejects(resumeWebReceiptRecovery(cli.batch,{receiptIds:[cli.snapshot.id],note:'resume'},'operator'),/脚本/);
});

test('admin API requires session and CSRF and validates stale submissions',async()=>{
  const app=await buildApp();
  const old=config.adminPassword;config.adminPassword='fixture-password-123456';
  try {
    assert.equal((await app.inject({method:'GET',url:'/api/admin/receipt-recovery'})).statusCode,401);
    const login=await app.inject({method:'POST',url:'/api/auth/password',payload:{password:config.adminPassword}});
    const cookie=String(login.headers['set-cookie']).split(';')[0]!;
    const me=await app.inject({method:'GET',url:'/api/admin/me',headers:{cookie}});assert.equal(me.statusCode,200);
    const f=await fixture();const input=body([f]);
    assert.equal((await app.inject({method:'POST',url:'/api/admin/receipt-recovery',headers:{cookie},payload:input})).statusCode,403);
    const headers={cookie,'x-csrf-token':me.json().csrf};
    assert.equal((await app.inject({method:'POST',url:'/api/admin/receipt-recovery/preview',headers,payload:{receiptIds:[f.snapshot.id]}})).statusCode,200);
    const created=await app.inject({method:'POST',url:'/api/admin/receipt-recovery',headers,payload:input});assert.equal(created.statusCode,200,created.body);
    const conflict=await app.inject({method:'POST',url:'/api/admin/receipt-recovery',headers,payload:body([f])});assert.equal(conflict.statusCode,409,conflict.body);
    assert.equal((await app.inject({method:'POST',url:'/api/admin/receipt-recovery/preview',headers,payload:{receiptIds:[]}})).statusCode,400);
  } finally {config.adminPassword=old;await app.close();}
});

test('worker exits before model call: terminal linked job is resumable even while article remains new',async()=>{
  const f=await fixture(),input=body([f]);await createWebReceiptRecovery(input,'operator');await advanceWebReceiptRecoveries();
  const [x]=await sql`SELECT evidence FROM receipt_recoveries WHERE receipt_id=${f.snapshot.id}`;
  const articleId=f.req.subject.split(':')[1]!.split('@')[0]!;
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${articleId}`)[0]!.processing_state,'new');
  await sql`UPDATE pgboss.job SET state='cancelled' WHERE id=${x!.evidence.jobId}`;
  await settleReceiptRecoveryBatch(input.batch);
  const detail=await webReceiptRecovery(input.batch);
  assert.equal(detail!.items[0]!.state,'blocked');
  assert.equal(detail!.items[0]!.canResume,true);
  await resumeWebReceiptRecovery(input.batch,{receiptIds:[f.snapshot.id],note:'worker interruption'},'operator');
  await advanceWebReceiptRecoveries();
  const [next]=await sql`SELECT state,evidence FROM receipt_recoveries WHERE receipt_id=${f.snapshot.id}`;
  assert.equal(next!.state,'queued');assert.notEqual(next!.evidence.jobId,x!.evidence.jobId);
});

test('legacy batch names are readable but cannot be adopted for web execution',async()=>{
  const f=await fixture(),batch='历史:批次/'+tag();batches.push(batch);
  await createReceiptRecoveryBatch(batch,'legacy',undefined,{receipts:[f.snapshot],acceptDuplicateCharge:true});
  assert.equal((await webReceiptRecovery(batch))!.items[0]!.receiptId,f.snapshot.id);
  assert.equal((await webReceiptRecovery(batch))!.web,false);
  await assert.rejects(createWebReceiptRecovery({...body([f]),batch},'operator'));
});

test('runner retains queue contention cause in audit even after a later successful tick',async()=>{
  const f=await fixture(),input=body([f]);await createWebReceiptRecovery(input,'operator');
  const articleId=f.req.subject.split(':')[1]!.split('@')[0]!;
  const job=await enqueue('content.analyze',{articleId,revision:1},{singletonKey:articleId});
  assert.ok(job);
  await assert.rejects(advanceWebReceiptRecoveries(),/queue is busy/);
  assert.match((await webReceiptRecovery(input.batch))!.runnerError!,/queue is busy/);
  const [audit]=await sql`SELECT after FROM audit_log WHERE subject=${input.batch} AND action='receipt.batch_runner_failed'`;
  assert.equal(audit!.after.category,'queue_busy');
  await sql`UPDATE pgboss.job SET state='cancelled' WHERE id=${job}`;
  await advanceWebReceiptRecoveries();
  assert.equal((await webReceiptRecovery(input.batch))!.runnerError,null);
  assert.equal((await sql`SELECT count(*)::int n FROM audit_log WHERE subject=${input.batch} AND action='receipt.batch_runner_failed'`)[0]!.n,1);
});
