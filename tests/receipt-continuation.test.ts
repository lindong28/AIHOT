import { tag, stub } from './setup.ts';
import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { z } from 'zod';
import { sql,closeDb } from '@aihot/backend/db';
import { stopBoss,ensureQueue,QUEUES } from '@aihot/backend/jobs/queue';
import { loadAnalyzeInput,prefilterRequest,scoreRequest,structureRequest,understandRequest,runAnalysis } from '@aihot/backend/editorial/analyze';
import { firstImagePart } from '@aihot/backend/editorial/input';
import { config } from '@aihot/backend/config';
import { describeChatRequest } from '@aihot/backend/providers/llm';
import { modelFor } from '@aihot/backend/editorial/models';
import { logicalKeyFor,paidRequest,ReceiptRecoveryStoppedError } from '@aihot/backend/providers/receipts';
import { previewArticleContinuation,continueCorrectedArticle,stopPolicyBlockedArticle } from '@aihot/backend/admin/receipt-continuation';
import { GatewayResponseError,imageRequestRejected } from '@aihot/backend/providers/gateway-error';
after(async()=>{await stopBoss();await closeDb()});
async function fixture(changed=true,category='invalid_request') {
 const id=tag(),source=tag();
 await sql`INSERT INTO sources(id,name,kind,enabled) VALUES(${source},'fixture','rss',false)`;
 await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,body_status,processing_state,discovered_at,timeline_at) VALUES(${id},${source},${id},${'https://example.test/'+id},'A model release','Model description repeated for fixture','ok','failed',now(),now())`;
 const a=(await loadAnalyzeInput(id))!;
 const opts={...prefilterRequest(a),model:await modelFor('prefilter')};
 const req=describeChatRequest(changed?{...opts,user:opts.user+' old serialized input'}:opts);
 const requestId=randomUUID();
 await assert.rejects(paidRequest({...req,gatewayRequestId:requestId},async()=>{throw new GatewayResponseError(400,requestId,{version:1,httpStatus:400,providerCode:category==='content_policy_rejected'?'1301':null,category:category as any,retryable:false})}));
 const [r]=await sql`SELECT id FROM receipts WHERE logical_key=${logicalKeyFor(req)}`;
 return {id:Number(r!.id),article:id,req,current:describeChatRequest(opts)};
}
test('preview rejects unchanged/unknown/policy requests; corrected input preserves old attempt and cached stages',async()=>{
 await ensureQueue(QUEUES.analyze);
 const same=await fixture(false);assert.equal((await previewArticleContinuation(same.id)).eligible,false);
 const unknown=await fixture(true,'unknown');assert.equal((await previewArticleContinuation(unknown.id)).eligible,false);
 const policy=await fixture(true,'content_policy_rejected');assert.equal((await previewArticleContinuation(policy.id)).eligible,false);
 const f=await fixture();const plan=await previewArticleContinuation(f.id);assert.equal(plan.eligible,true);
 const before=await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${f.id}`;
 await assert.rejects(continueCorrectedArticle(f.id,{snapshotHash:plan.snapshotHash,note:'corrected input',acceptDuplicateCharge:false},'fixture'),/确认/);
 await assert.rejects(continueCorrectedArticle(f.id,{snapshotHash:'stale',note:'corrected input',acceptDuplicateCharge:true},'fixture'),/预览已变化/);
 const result=await continueCorrectedArticle(f.id,{snapshotHash:plan.snapshotHash,note:'remove old serialization suffix',acceptDuplicateCharge:true},'fixture');
 assert.equal(result.requeued,true);
 assert.deepEqual(await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${f.id}`,before);
 await assert.rejects(paidRequest({...f.current,identity:{drift:true}},async()=>{assert.fail('changed settings must stop')}),ReceiptRecoveryStoppedError);
 let calls=0;const received=await paidRequest({...f.current,outputMaxAttempts:3},async()=>{calls++;return {response:{ok:true}}});
 await paidRequest({...f.current,outputMaxAttempts:3},async()=>{assert.fail('received must be reused')});assert.equal(calls,1);
 assert.notEqual(received.receiptId,f.id);
 const later={...f.current,attemptTag:'new-review',identity:{later:true}};
 await paidRequest(later,async()=>({response:{ok:true}}));
 await sql`UPDATE receipts SET status='failed' WHERE id=${received.receiptId}`;
 await paidRequest({...f.current,outputMaxAttempts:3},async()=>({response:{ok:true}}));
 await sql`UPDATE receipts SET status='failed' WHERE id=${received.receiptId}`;
 await assert.rejects(paidRequest({...f.current,outputMaxAttempts:3},async()=>{assert.fail('old attempt consumes generation allowance')}),ReceiptRecoveryStoppedError);
 assert.deepEqual(await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${f.id}`,before);
});
test('correction allowance applies to only the target vote and current open anchor',async()=>{
 const f=await fixture();const plan=await previewArticleContinuation(f.id);
 await continueCorrectedArticle(f.id,{snapshotHash:plan.snapshotHash,note:'corrected input',acceptDuplicateCharge:true},'fixture');
 const other={...f.current,purpose:'score_article',attemptTag:'score-1',outputMaxAttempts:3};
 await sql`UPDATE receipt_reviews SET evidence=jsonb_set(evidence,'{plannedRequests}',${sql.json([{stage:'prefilter',logicalKey:logicalKeyFor(f.current)},{stage:'score-1',logicalKey:logicalKeyFor(other)}])}) WHERE receipt_id=${f.id}`;
 for(let i=0;i<3;i++) {
  const result=await paidRequest(other,async()=>({response:{ok:true}}));
  await sql`UPDATE receipts SET status='failed' WHERE id=${result.receiptId}`;
 }
 await sql`UPDATE receipt_reviews SET disposition='superseded' WHERE receipt_id=${f.id}`;
 await paidRequest({...f.current,identity:{afterClose:true}},async()=>({response:{ok:true}}));
});
test('policy dependency stops the same revision without calling or rewriting receipt facts',async()=>{
 const f=await fixture();
 const [r]=await sql`SELECT * FROM receipts WHERE id=${f.id}`;
 const blockId=randomUUID();const req={...f.req,purpose:'score_article',attemptTag:'score-1',gatewayRequestId:blockId};
 await assert.rejects(paidRequest(req,async()=>{throw new GatewayResponseError(400,blockId,{version:1,httpStatus:400,providerCode:'1301',category:'content_policy_rejected',retryable:false})}));
 assert.equal((await previewArticleContinuation(f.id)).eligible,false);
 const before=await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${f.id}`;
 const stopped=await stopPolicyBlockedArticle(f.id,1,'fixture');assert.equal(stopped.state,'blocked');
 assert.equal((await sql`SELECT billed,disposition FROM receipt_reviews WHERE receipt_id=${f.id}`)[0]!.billed,null);
 assert.deepEqual(await sql`SELECT * FROM receipt_attempts WHERE receipt_id=${f.id}`,before);
 assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${f.article}`)[0]!.processing_state,'blocked');
});
test('policy refusal in a successful HTTP response also blocks correction preview',async()=>{
 const f=await fixture();
 await paidRequest({...f.req,purpose:'score_article',attemptTag:'score-2'},async()=>({response:{choices:[{finish_reason:'content_filter',message:{content:''}}]}}));
 assert.equal((await previewArticleContinuation(f.id)).eligible,false);
});
test('image downgrade excludes generic invalid parameters, policy and unknown',()=>{
 for(const [code,category,expected] of [['invalid_image','invalid_request',true],['1214','invalid_request',false],['1261','invalid_request',false],['image_content_policy_violation','invalid_request',false],['invalid_image','unknown',false],[null,'invalid_request',false]] as const) assert.equal(imageRequestRejected({version:1,httpStatus:400,providerCode:code,category}),expected);
});

test('real analysis keeps image fallback behind stop state and shares corrected generation allowance',async()=>{
 const answer=(data:unknown)=>({choices:[{message:{content:JSON.stringify(data)},finish_reason:'stop'}]});
 let sent=0,invalidOutput=false;
 const provider=await stub(()=>{sent++;return answer(invalidOutput?{}:{itemType:'model_release',titleZh:'模型发布',summaryZh:'新模型的发布内容。'})});
 process.env.ZHIPU_BASE_URL=provider.url+'/v1';process.env.ZHIPU_API_KEY='fixture';
 process.env.DASHSCOPE_BASE_URL=provider.url+'/v1';process.env.DASHSCOPE_API_KEY='fixture';
 const files:string[]=[];
 try {
  for(const state of ['open','stopped','superseded','recovered','corrected'] as const) {
   const id=tag(),url='https://example.invalid/'+id+'.jpg';
   const key=createHash('sha256').update('thumb|'+url).digest('hex');
   const file=path.join(config.dataDir,'imgcache',key.slice(0,2),key);
   await mkdir(path.dirname(file),{recursive:true});
   await writeFile(file,await sharp({create:{width:8,height:8,channels:3,background:'#226699'}}).jpeg().toBuffer());
   await writeFile(file+'.type','image/jpeg');files.push(file,file+'.type');
   const source=tag();
   await sql`INSERT INTO sources(id,name,kind,tier,enabled) VALUES(${source},'fixture','rss','T1',false)`;
   await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,body_status,media,processing_state,discovered_at,timeline_at)
     VALUES(${id},${source},${id},${url},'A model release','A model with new features and benchmarks.','ok',${sql.json([{kind:'image',url}])},'failed',now(),now())`;
   const a=(await loadAnalyzeInput(id))!;
   for(const [opts,data] of [
    [{...prefilterRequest(a),model:await modelFor('prefilter')},{label:'PASS',reason:'fixture'}],
    [scoreRequest(a,await modelFor('score'),1),{attentionScore:80}],
    [scoreRequest(a,await modelFor('score'),2),{attentionScore:80}],
    [structureRequest(a,await modelFor('structure')),{category:'ai-models',tags:[],subjects:[],fact:null}],
   ] as const) await paidRequest(describeChatRequest<z.ZodType>(opts),async()=>({response:answer(data)}));
   const image=await firstImagePart(a,{cacheOnly:true});
   const opts=understandRequest(a,await modelFor('understand'),image);
   const reject=async(req:ReturnType<typeof describeChatRequest>)=>{
    const uuid=randomUUID();
    await assert.rejects(paidRequest({...req,gatewayRequestId:uuid},async()=>{throw new GatewayResponseError(400,uuid,{version:1,httpStatus:400,providerCode:'invalid_image',category:'invalid_request',retryable:false})}));
    return Number((await sql`SELECT id FROM receipts WHERE logical_key=${logicalKeyFor(req)}`)[0]!.id);
   };
   if(state==='corrected') {
    const original=await reject(describeChatRequest({...opts,user:'old image serialization '+id}));
    const plan=await previewArticleContinuation(original);
    await continueCorrectedArticle(original,{snapshotHash:plan.snapshotHash,note:'static first frame',acceptDuplicateCharge:true},'fixture');
   }
   const imageId=await reject(describeChatRequest(opts));
   if(state==='stopped'||state==='superseded') await sql`UPDATE receipt_reviews SET disposition=${state} WHERE receipt_id=${imageId}`;
   if(state==='recovered') await sql`INSERT INTO receipt_recoveries(receipt_id,original_attempt,batch,target_key,target,state,note,original_status)
     VALUES(${imageId},1,'fixture',${id},'{}','recovered','fixture','unknown')`;
   const before=sent;
   if(state==='open'||state==='corrected') {
    invalidOutput=state==='corrected';
    if(invalidOutput) await assert.rejects(runAnalysis(a),ReceiptRecoveryStoppedError);
    else assert.equal((await runAnalysis(a)).writing?.kind,'understand');
    assert.equal(sent-before,1,'only one text generation: compatible stages reused and corrected total capped');
    const [parent]=await sql`SELECT status,attempts FROM receipts WHERE id=${imageId}`;
    assert.equal(parent!.status,'unknown');assert.equal(parent!.attempts,1);
   } else {
    await assert.rejects(runAnalysis(a),ReceiptRecoveryStoppedError);
    assert.equal(sent,before,'closed image branch cannot dispatch text');
   }
  }
 } finally {await provider.close();for(const file of files) await unlink(file)}
});
