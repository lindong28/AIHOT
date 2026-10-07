import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test, mock } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { logicalKeyFor, paidRequest } from "@aihot/backend/providers/receipts";
import { createReceiptRecoveryBatch, advanceReceiptRecoveryBatch, settleReceiptRecoveryBatch, receiptRecoveryStatus, legacyTransientReceiptIds } from "@aihot/backend/admin/receipt-batch-recovery";
import { stopBoss, enqueue, QUEUES, getBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { runsOverview, autoReleaseUnknownReceipts } from "@aihot/backend/admin/runs";
import { sha256 } from "@aihot/backend/lib/ids";
import { storePreparation, loadPreparation } from "@aihot/backend/backfill/history-input";

before(async () => { await getBoss(); });
after(async () => { await stopBoss(); await closeDb(); });
async function article() {
  const id=tag(), source=tag();
  await sql`INSERT INTO sources(id,name,kind,enabled) VALUES (${source},'test','rss',false)`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,processing_state,body_status)
    VALUES (${id},${source},${id},${`https://example.test/${id}`},'test',now(),now(),'failed','ok')`;
  return id;
}
async function receipt(subject: string, purpose='prefilter_article', service='batch-test') {
  const req = { service, purpose, subject, model: 'fixture', identity: { id: tag() }, gatewayRequestId: randomUUID() };
  await assert.rejects(paidRequest(req, async () => { throw new Error('lost response'); }));
  const [r] = await sql`SELECT id FROM receipts WHERE logical_key=${logicalKeyFor(req)}`;
  return { id: Number(r!.id), req };
}
async function success(id: string, revision = 1) {
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh) VALUES (${id},${revision},'model','pass','恢复标题','恢复后的新闻摘要内容')`;
  await sql`UPDATE articles SET processing_state='analyzed' WHERE id=${id}`;
  await publishArticle(id);
}

test('legacy transient migration excludes fresh, opted, exhausted and permanent failures', async () => {
  const expected: number[] = [], all: number[] = [];
  for (const kind of ['ledger','transport','fresh','opted','exhausted','permanent']) {
    const r = await receipt(`article:${await article()}@1`); all.push(r.id);
    await sql`UPDATE receipts SET updated_at=now()-interval '11 minutes' WHERE id=${r.id}`;
    await sql`UPDATE receipt_attempts SET error=${`Error: Gateway HTTP 503 (ledger_unavailable); reconcile request ${r.req.gatewayRequestId} before retrying`} WHERE receipt_id=${r.id}`;
    if (kind === 'ledger' || kind === 'transport') expected.push(r.id);
    if (kind === 'transport') await sql`UPDATE receipt_attempts SET error_details='{"version":1,"category":"transport_error","retryable":true}' WHERE receipt_id=${r.id}`;
    if (kind === 'fresh') await sql`UPDATE receipts SET updated_at=now() WHERE id=${r.id}`;
    if (kind === 'opted') await sql`UPDATE receipts SET request='{"gateway":{"recoveryVersion":1}}' WHERE id=${r.id}`;
    if (kind === 'exhausted') {
      await sql`UPDATE receipts SET attempts=3 WHERE id=${r.id}`;
      await sql`UPDATE receipt_attempts SET attempt=3 WHERE receipt_id=${r.id}`;
    }
    if (kind === 'permanent') await sql`UPDATE receipt_attempts SET error_details='{"version":1,"category":"content_policy_rejected","retryable":false}' WHERE receipt_id=${r.id}`;
  }
  assert.deepEqual((await legacyTransientReceiptIds(3)).filter(id=>all.includes(id)),expected);
  await createReceiptRecoveryBatch(tag(),'authorized legacy transient replay',expected);
  assert.deepEqual((await legacyTransientReceiptIds(3)).filter(id=>all.includes(id)),[]);
});

test('a completed current revision settles an old blocked incident without rewriting billing or enqueuing', async () => {
  const id=await article(), r=await receipt(`article:${id}@1`), batch=tag();
  await createReceiptRecoveryBatch(batch,'authorized',[r.id]);
  await sql`UPDATE articles SET revision=2 WHERE id=${id}`;
  await advanceReceiptRecoveryBatch(batch);
  assert.equal((await receiptRecoveryStatus(batch)).outstanding[0]!.evidence.reason,'article_not_failed_current_revision');
  assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,0);
  await success(id,2);
  await autoReleaseUnknownReceipts();
  assert.equal((await receiptRecoveryStatus(batch)).counts.recovered,1);
  const [proof]=await sql`SELECT evidence FROM receipt_recoveries WHERE batch=${batch}`;
  assert.equal(proof!.evidence.reason,'superseded_revision');
  assert.equal(proof!.evidence.capturedRevision,1); assert.equal(proof!.evidence.revision,2);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${r.id}`)[0]!.status,'unknown');
  assert.deepEqual((await sql`SELECT status,cost FROM receipt_attempts WHERE receipt_id=${r.id}`).map(a=>[a.status,a.cost]),[['unknown',null]]);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE data->>'articleId'=${id}`).length,0);
  assert.equal((await runsOverview()).receipts.issues.some(a=>a.id===r.id),false);
  assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,0);
});

test('revision growth and an old published analysis are insufficient; a later unknown stays visible',async()=>{
  const id=await article(),r=await receipt(`article:${id}@1`),batch=tag();
  await createReceiptRecoveryBatch(batch,'authorized',[r.id]);
  await success(id);
  await sql`UPDATE articles SET revision=2 WHERE id=${id}`;
  assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,0);
  await success(id,2);
  await sql`UPDATE receipts SET attempts=2,status='unknown' WHERE id=${r.id}`;
  assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,0);
  assert.equal((await runsOverview()).receipts.issues.some(a=>a.id===r.id),true);
});

test('content rejection blocks the entire frozen target without authorization, yet newer success can settle it',async()=>{
  for (const historical of [true,false]) {
    const id=await article(),r=await receipt(`article:${id}@1`),sibling=await receipt(`article:${id}@1`),batch=tag();
    await sql`UPDATE receipt_attempts SET error=${`Error: Gateway HTTP 400 (1301); reconcile request ${r.req.gatewayRequestId} before retrying`},
      error_details=${historical ? null : sql.json({version:1,httpStatus:400,providerCode:'1301',category:'content_policy_rejected',retryable:false})} WHERE receipt_id=${r.id}`;
    await createReceiptRecoveryBatch(batch,'authorized',[r.id,sibling.id]);
    await advanceReceiptRecoveryBatch(batch);
    assert.equal((await receiptRecoveryStatus(batch)).counts.blocked,2);
    assert.equal((await receiptRecoveryStatus(batch)).outstanding[0]!.evidence.reason,'content_policy_rejected');
    assert.equal((await sql`SELECT id FROM audit_log WHERE action='receipt.authorize_replay' AND subject=${`receipt:${r.id}`}`).length,0);
    assert.equal((await sql`SELECT id FROM pgboss.job WHERE data->>'articleId'=${id}`).length,0);
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${sibling.id}`)[0]!.status,'unknown');
    assert.equal((await runsOverview()).receipts.issues.find(a=>a.id===r.id)!.recovery_status,'content_policy_rejected');
    await sql`UPDATE articles SET revision=2 WHERE id=${id}`;
    await success(id,2);
    assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,2);
  }
});

test('one frozen target, one job; business completion closes old incidents without changing paid history', async () => {
  const id=await article(), a=await receipt(`article:${id}@1`), b=await receipt(`article:${id}@1`), batch=tag();
  await sql`UPDATE receipt_attempts SET cost=0.125,currency='USD',cost_basis='estimated' WHERE receipt_id=${a.id}`;
  assert.equal((await createReceiptRecoveryBatch(batch,'operator accepted possible duplicate cost',[a.id,b.id])).created,2);
  const later=await receipt(`article:${id}@1`);
  assert.equal((await createReceiptRecoveryBatch(batch,'resume')).reused,true);
  await advanceReceiptRecoveryBatch(batch,2);
  await advanceReceiptRecoveryBatch(batch,2);
  const jobs=await sql`SELECT id FROM pgboss.job WHERE name='content.analyze' AND data->>'articleId'=${id}`;
  assert.equal(jobs.length,1);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${later.id}`)[0]!.status,'unknown');
  await success(id);
  assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,2);
  assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,0);
  assert.equal((await receiptRecoveryStatus(batch)).outstanding.length,0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM articles WHERE identity_key=${id}`)[0]!.n,1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM publications WHERE article_id=${id}`)[0]!.n,1);
  assert.deepEqual((await sql`SELECT status,cost FROM receipt_attempts WHERE receipt_id=${a.id}`).map(r=>[r.status,r.cost]),[['unknown',0.125]]);
  assert.equal((await runsOverview()).receipts.issues.some(r=>r.id===a.id),false);
  // Same receipt receives a new failed attempt later: it must be visible again.
  await sql`UPDATE receipts SET attempts=2,status='unknown' WHERE id=${a.id}`;
  assert.equal((await runsOverview()).receipts.issues.some(r=>r.id===a.id),true);
});

test('new failed attempt blocks recovery and cannot be released by continuing the same batch', async () => {
  const id=await article(), r=await receipt(`article:${id}@1`), batch=tag();
  await createReceiptRecoveryBatch(batch,'authorized',[r.id]);
  await advanceReceiptRecoveryBatch(batch);
  await assert.rejects(paidRequest(r.req,async()=>{throw new Error('lost again');}));
  await settleReceiptRecoveryBatch(batch);
  assert.equal((await receiptRecoveryStatus(batch)).counts.blocked,1);
  await advanceReceiptRecoveryBatch(batch);
  const [row]=await sql`SELECT status,attempts FROM receipts WHERE id=${r.id}`;
  assert.equal(row!.status,'unknown'); assert.equal(row!.attempts,2);
});

test('existing monitor business success closes an old unknown without redispatch', async () => {
  const id=tag(),r=await receipt(`x:${id}`,'monitor.recognize'),batch=tag();
  await sql`INSERT INTO monitor_posts(id,author,published_at,text,url,processed_at,recognition)
    VALUES (${id},'test',now(),'test','https://example.test',now(),'{}')`;
  await createReceiptRecoveryBatch(batch,'authorized',[r.id]);
  await advanceReceiptRecoveryBatch(batch);
  assert.equal((await receiptRecoveryStatus(batch)).counts.recovered,1);
  assert.equal((await sql`SELECT status,attempts FROM receipts WHERE id=${r.id}`)[0]!.status,'unknown');
});

test('batch lookup retains shared subjects and completed items linked by saved receipt', async () => {
  const run=tag(), key=tag(), shared=tag(), noResult=tag(), batch=tag(), subject=`article:preparation:${sha256(key)}@1`;
  const a=await receipt(subject,'prefilter_article','backfill'),b=await receipt(subject,'score_article','backfill');
  const c=await receipt(`article:preparation:${sha256(noResult)}@1`,'prefilter_article','backfill');
  await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,state) VALUES (${run},'test',${run},'2026-01-01','2026-01-01','complete')`;
  for (const k of [key,shared,noResult]) {
    const p=storePreparation({versions:[{key:k,day:'2026-01-01',provenance:{},prefilter:null,material:null,targetUrls:[],context:{}}],dayBasis:'earliest_version_utc',results:k===noResult?{}:{[k]:{prefilter:{receiptId:a.id}}}});
    await sql`INSERT INTO backfill_items(run_id,identity_key,day,material,content_hash,evidence,state,preparation)
      VALUES (${run},${k},'2026-01-01','{}','hash','test','filtered',${sql.json(p)})`;
  }
  await createReceiptRecoveryBatch(batch,'authorized',[a.id,b.id,c.id]);
  const rows=await sql`SELECT receipt_id,target FROM receipt_recoveries WHERE batch=${batch}`;
  assert.equal(rows.find(r=>r.receipt_id===a.id)!.target.items.length,2);
  assert.equal(rows.find(r=>r.receipt_id===b.id)!.target.items.length,1);
  assert.equal(rows.find(r=>r.receipt_id===c.id)!.target.items.length,1);
  assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,3);
});

test('overlapping backfill targets cannot indirectly replay a refused shared item', async () => {
  const run=tag(),key=tag(),shared=tag(),batch=tag(),subject=`article:preparation:${sha256(key)}@1`;
  const refused=await receipt(subject,'prefilter_article','backfill'),sibling=await receipt(subject,'score_article','backfill');
  await sql`UPDATE receipt_attempts SET error_details=${sql.json({version:1,httpStatus:400,providerCode:'1301',category:'content_policy_rejected',retryable:false})} WHERE receipt_id=${refused.id}`;
  await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,state) VALUES (${run},'test',${run},'2026-01-01','2026-01-01','needs_attention')`;
  for (const k of [key,shared]) {
    const p=storePreparation({versions:[{key:k,day:'2026-01-01',provenance:{},prefilter:null,material:null,targetUrls:[],context:{}}],dayBasis:'earliest_version_utc',results:{[k]:{prefilter:{receiptId:refused.id},error:'blocked fixture'}}});
    await sql`INSERT INTO backfill_items(run_id,identity_key,day,material,content_hash,evidence,state,preparation)
      VALUES (${run},${k},'2026-01-01','{}','hash','test','failed',${sql.json(p)})`;
  }
  await createReceiptRecoveryBatch(batch,'authorized',[refused.id,sibling.id]);
  const frozen=await sql`SELECT receipt_id,target FROM receipt_recoveries WHERE batch=${batch}`;
  assert.equal(frozen.find(x=>x.receipt_id===refused.id)!.target.items.length,2);
  assert.equal(frozen.find(x=>x.receipt_id===sibling.id)!.target.items.length,1);
  await advanceReceiptRecoveryBatch(batch);
  assert.equal((await receiptRecoveryStatus(batch)).counts.blocked,2);
  assert.deepEqual((await sql`SELECT state FROM backfill_items WHERE run_id=${run}`).map(x=>x.state),['failed','failed']);
  assert.equal((await sql`SELECT id FROM audit_log WHERE action='receipt.authorize_replay' AND subject=ANY(${[`receipt:${refused.id}`,`receipt:${sibling.id}`]}::text[])`).length,0);
});

test('batch lookup resolves ordinary backfill articles without preparation payloads', async () => {
  const id=await article(),run=tag(),key=tag(),batch=tag();
  const a=await receipt(`article:${id}@1`,'score_article','backfill'),b=await receipt(`article:${id}@1`,'summarize_article','backfill');
  await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,state) VALUES (${run},'test',${run},'2026-01-01','2026-01-01','complete')`;
  await sql`INSERT INTO backfill_items(run_id,identity_key,day,material,content_hash,evidence,state,article_id)
    VALUES (${run},${key},'2026-01-01','{}','hash','test','filtered',${id})`;
  await createReceiptRecoveryBatch(batch,'authorized',[a.id,b.id]);
  const rows=await sql`SELECT target FROM receipt_recoveries WHERE batch=${batch}`;
  assert.equal(rows.length,2);
  for (const row of rows) assert.deepEqual(row.target,{kind:'backfill',items:[{runId:run,key}]});
  assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,2);
});

test('backfill waits for executor lock, retries only selected item, and uses no live analyze queue', async () => {
  const run=tag(), key=tag(), other=tag(), r=await receipt(`article:preparation:${sha256(key)}@1`,'prefilter_article','backfill'),batch=tag();
  const p=storePreparation({versions:[{key,day:'2026-01-01',provenance:{},prefilter:null,material:null,targetUrls:[],context:{}}],dayBasis:'earliest_version_utc',results:{[key]:{error:`receipt_unknown:${r.id}`}}});
  await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,state) VALUES (${run},'test',${run},'2026-01-01','2026-01-01','needs_attention')`;
  for (const k of [key,other]) await sql`INSERT INTO backfill_items(run_id,identity_key,day,material,content_hash,evidence,state,preparation)
    VALUES (${run},${k},'2026-01-01','{}','hash','test','failed',${k===key?sql.json(p):null})`;
  await createReceiptRecoveryBatch(batch,'authorized',[r.id]);
  const lock=await sql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(hashtext(${'backfill:'+run}))`;
    const result=await advanceReceiptRecoveryBatch(batch);
    assert.equal(result.results[0]!.result,'backfill_executor_busy');
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${r.id}`)[0]!.status,'unknown');
  } finally { await lock`SELECT pg_advisory_unlock(hashtext(${'backfill:'+run}))`;lock.release(); }
  await advanceReceiptRecoveryBatch(batch);
  const items=await sql`SELECT identity_key,state,preparation FROM backfill_items WHERE run_id=${run}`;
  assert.equal(items.find(i=>i.identity_key===other)!.state,'failed');
  const selected=items.find(i=>i.identity_key===key)!;
  assert.equal(selected.state,'pending');
  assert.equal(loadPreparation(selected.preparation).results[key]!.error,undefined);
  assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name='content.analyze' AND data->>'articleId'=${'preparation:'+sha256(key)}`)[0]!.n,0);
  await sql`UPDATE backfill_items SET state='filtered',updated_at=now() WHERE run_id=${run} AND identity_key=${key}`;
  assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,1);
});

test('grouped_at alone is not success; missing or changed article is not released',async()=>{
  const id=await article(),r=await receipt(`article:${id}`,'group_article'),batch=tag();
  await sql`UPDATE articles SET grouped_at=now() WHERE id=${id}`;
  await createReceiptRecoveryBatch(batch,'authorized',[r.id]);
  assert.equal((await settleReceiptRecoveryBatch(batch)).recovered,0);
  const changed=await receipt(`article:${id}@1`),b2=tag();
  await createReceiptRecoveryBatch(b2,'authorized',[changed.id]);
  await sql`UPDATE articles SET revision=2 WHERE id=${id}`;
  await advanceReceiptRecoveryBatch(b2);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${changed.id}`)[0]!.status,'unknown');
});

for (const outcome of ['completed','failed']) test(`an existing group job is linked and its ${outcome} outcome releases the allowance`,async()=>{
  const id=await article(), r=await receipt(`article:${id}`,'group_article'),batch=tag();
  await success(id);
  const job=await enqueue(QUEUES.group,{articleId:id},{singletonKey:id});
  await sql`UPDATE pgboss.job SET created_on=now()-interval '1 hour' WHERE id=${job!}`;
  await createReceiptRecoveryBatch(batch,'authorized',[r.id]);
  await advanceReceiptRecoveryBatch(batch,1);
  const [x]=await sql`SELECT evidence FROM receipt_recoveries WHERE batch=${batch}`;
  assert.equal(x!.evidence.jobId,job);
  await sql`UPDATE pgboss.job SET state=${outcome},completed_on=now() WHERE id=${job!}`;
  await settleReceiptRecoveryBatch(batch);
  assert.equal((await receiptRecoveryStatus(batch)).counts[outcome==='completed'?'recovered':'blocked'],1);
});

test('a permanently changed first target does not starve later eligible work',async()=>{
  const ids=[await article(),await article()].sort();
  const receipts=await Promise.all(ids.map(id=>receipt(`article:${id}@1`))),batch=tag();
  await createReceiptRecoveryBatch(batch,'authorized',receipts.map(r=>r.id));
  await sql`UPDATE articles SET revision=2 WHERE id=${ids[0]!}`;
  await advanceReceiptRecoveryBatch(batch,1);
  const result=await receiptRecoveryStatus(batch);
  assert.equal(result.counts.blocked,1);assert.equal(result.counts.queued,1);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipts[0]!.id}`)[0]!.status,'unknown');
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${receipts[1]!.id}`)[0]!.status,'failed');
});

test('explicit backfill allowance is independent while omitted allowance preserves the global cap',async()=>{
  const batch=tag(),run=tag(), receipts=[];
  await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,state) VALUES (${run},'test',${run},'2026-01-01','2026-01-01','needs_attention')`;
  for (const backfill of [false,false,true,true]) {
    const id=await article();
    receipts.push(await receipt(`article:${id}@1`,'prefilter_article',backfill?'backfill':'batch-test'));
    if (backfill) await sql`INSERT INTO backfill_items(run_id,identity_key,day,material,content_hash,evidence,state,article_id)
      VALUES (${run},${id},'2026-01-01','{}','hash','test','failed',${id})`;
  }
  await createReceiptRecoveryBatch(batch,'authorized',receipts.map(r=>r.id));
  await advanceReceiptRecoveryBatch(batch,1);
  assert.equal((await receiptRecoveryStatus(batch)).counts.queued,1);
  await advanceReceiptRecoveryBatch(batch,1);
  assert.equal((await receiptRecoveryStatus(batch)).counts.queued,1);
  await advanceReceiptRecoveryBatch(batch,1,2);
  const pools=await sql`SELECT target->>'kind' AS kind,count(*)::int AS n FROM receipt_recoveries WHERE batch=${batch} AND state='queued' GROUP BY 1 ORDER BY 1`;
  assert.deepEqual(pools.map(r=>[r.kind,r.n]),[['article',1],['backfill',2]]);
  await advanceReceiptRecoveryBatch(batch,1,2);
  assert.equal((await receiptRecoveryStatus(batch)).counts.queued,3);
  const [ordinary]=await sql`SELECT target FROM receipt_recoveries WHERE batch=${batch} AND state='queued' AND target->>'kind'='article'`;
  await success(ordinary!.target.id);
  await advanceReceiptRecoveryBatch(batch,1,2);
  assert.equal((await receiptRecoveryStatus(batch)).counts.recovered,1);
  assert.equal((await receiptRecoveryStatus(batch)).counts.queued,3);
  await assert.rejects(()=>advanceReceiptRecoveryBatch(batch,1,0),/backfill limit/);
});

test('an empty or unknown batch is an error, never a reusable completed cohort',async()=>{
  const batch=tag();
  await assert.rejects(()=>createReceiptRecoveryBatch(batch,'authorized',[]),/No eligible receipts/);
  await assert.rejects(()=>receiptRecoveryStatus(batch),/not found/);
});

test('missing queue identity rolls back receipt release and leaves the frozen target retryable',async()=>{
  const id=await article(),r=await receipt(`article:${id}`,'group_article'),batch=tag();
  await createReceiptRecoveryBatch(batch,'authorized',[r.id]);
  const send=mock.method(await getBoss(),'send',async()=>null);
  try { await assert.rejects(()=>advanceReceiptRecoveryBatch(batch),/not linked/); }
  finally {send.mock.restore();}
  assert.equal((await receiptRecoveryStatus(batch)).counts.planned,1);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${r.id}`)[0]!.status,'unknown');
  await advanceReceiptRecoveryBatch(batch);
  assert.equal((await receiptRecoveryStatus(batch)).counts.queued,1);
});

test('a missing group target is blocked without rolling back or starving the next group',async()=>{
  const id=await article(),missing=await receipt('article:000-missing','group_article'),next=await receipt(`article:${id}`,'group_article'),batch=tag();
  await createReceiptRecoveryBatch(batch,'authorized',[missing.id,next.id]);
  await advanceReceiptRecoveryBatch(batch,1);
  const result=await receiptRecoveryStatus(batch);
  assert.equal(result.counts.blocked,1);assert.equal(result.counts.queued,1);
  assert.equal(result.outstanding.find(r=>r.receipt_id===missing.id)!.state,'blocked');
});
