import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { sql, closeDb } from '@aihot/backend/db';
import { config } from '@aihot/backend/config';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { sha256, stableJson } from '@aihot/backend/lib/ids';
import { backfillContext, type BackfillBindings } from '@aihot/backend/backfill/context';
import { importHistory, loadPreparation, storePreparation, validateCandidate, type HistoryCandidate, type HistoryVersion } from '@aihot/backend/backfill/history-input';
import { materialHash } from '@aihot/backend/backfill/manifest';
import { backfillOverview, configureBackfill, controlBackfill, runBackfill } from '@aihot/backend/backfill/runs';
import { preflightBackfill } from '@aihot/backend/backfill/gateway';
import { cachedPrefilter, historyMaterial, prepareHistoryItem, originalPageContext } from '@aihot/backend/backfill/preparation';
import { PROMPT_VERSIONS, prefilterRequest, runPrefilter } from '@aihot/backend/editorial/analyze';
import { preparationArticle } from '@aihot/backend/backfill/preparation-prefilter';
import { completeReceipt } from '@aihot/backend/providers/receipts';

const T = tag(), source = `history-${T}`, root = await mkdtemp(join(tmpdir(),'aihot-history-'));
const qwen = { model: 'qwen3.8-flash', routes: [{ route: 'personal_self_hosted/qwen3.8-flash-next/stream', actualModel: 'self_hosted/qwen3.8-flash-next', provider: 'self-hosted', credentialProfile: 'personal_self_hosted' }] };
const deep = { model: 'deepseek-v4.1-flash', routes: [{ route: 'company_tencent_vod/deepseek-v4.1-flash/stream', actualModel: 'openai/deepseek-v4.1-flash', provider: 'tencent-vod', credentialProfile: 'company_tencent_vod' }] };
const models: BackfillBindings = { prefilter:qwen,structure:qwen,score:deep,understand:deep,summarize:deep };
let calls = 0, qualityCalls = 0, prefilterMode: 'complete'|'unknown'|'undispatched' = 'complete';
let forcePrefilterPass = false;
const server = createServer(async (req,res) => {
  if (req.url === "/api/capabilities") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ retry_policy_versions: [1] })); return; }
  if (req.headers["x-llm-retry-policy"]) res.setHeader("X-LLM-Retry-Policy", String(req.headers["x-llm-retry-policy"]));
  res.setHeader('content-type','application/json');
  if (req.url === '/health') { res.end(JSON.stringify({status:'ok',loaded_registry_revision:'history-test',file_registry_revision:'history-test'})); return; }
  if (req.url?.startsWith('/v1/discovery?')) {
    const model = new URL(req.url,'http://localhost').searchParams.get('model'), binding = model === qwen.model ? qwen : deep;
    res.end(JSON.stringify({projection_version:2,view_scope:'logical_model',requested_logical_model:model,status:'ready',
      project:{id:'history-test',billing_scope:['personal','company']},project_allowed_logical_model_ids:[model],loaded_registry_revision:'history-test',file_registry_revision:'history-test',
      routes:binding.routes.map(r=>({id:r.route,actual_model:r.actualModel,provider_id:r.provider,credential_profile_id:r.credentialProfile,
        funding_source:r.provider==='self-hosted'?'personal_paid':'company_paid',project_allowed:true,policy_allowed:true,effectively_eligible:true}))})); return;
  }
  calls++;
  const chunks:Buffer[]=[];for await (const c of req) chunks.push(Buffer.from(c));
  const body=JSON.parse(Buffer.concat(chunks).toString()), user=JSON.parse(body.messages.at(-1).content), binding=body.model===qwen.model?qwen:deep, r=binding.routes[0]!;
  let response:unknown;
  if (typeof user === 'object' && user.materialHash) {
    qualityCalls++;
    res.statusCode=500;res.end(JSON.stringify({error:'Unexpected per-item material judgement'}));return;
  } else response={label:forcePrefilterPass || String(user).includes('【来源】Archived fixture') && !String(user).includes('【标题】Fixture BLOCK_FIXTURE') && !String(user).includes('【标题】Fixture invalid-BLOCK_FIXTURE')?'PASS':'BLOCK',reason:'Synthetic prefilter decision'};
  if (prefilterMode==='unknown') {res.statusCode=502;res.end(JSON.stringify({error:{code:'provider_stream_error'}}));return;}
  if (prefilterMode==='undispatched') {res.statusCode=422;res.end(JSON.stringify({error:{code:'route_cooldown',logical_request_id:req.headers['x-llm-request-id']}}));return;}
  res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(response)}}],usage:{prompt_tokens:10,completion_tokens:10},
    llm_gateway:{projection_version:1, retry_policy: JSON.parse(String(req.headers["x-llm-retry-policy"])),logical_request_id:req.headers['x-llm-request-id'],provider_id:r.provider,selected_route_id:r.route,actual_model:r.actualModel,credential_profile_id:r.credentialProfile}}));
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
Object.assign(process.env,{LLM_GATEWAY_URL:base,LLM_GATEWAY_PROJECT:'history-test',LLM_GATEWAY_MODE:'stream',BACKFILL_ORIGINAL_CACHE:root});
delete process.env.LLM_GATEWAY_CLI;
config.modelCallsEnabled=true; // Only the loopback Gateway stub is configured.
before(async()=>{await sql`INSERT INTO sources(id,name,kind,tier,enabled) VALUES(${source},'Native fixture','rss','T1',false)`;await mkdir(join(root,'responses'));});
beforeEach(async()=>{prefilterMode='complete';forcePrefilterPass=false;delete process.env.BACKFILL_PREFILTER_CACHE;delete process.env.BACKFILL_NOT_DISPATCHED_AUDIT;await sql`UPDATE backfill_runs SET state='paused' WHERE state<>'complete'`;});
after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await stopBoss();await closeDb();});

function version(suffix:string, day='2026-05-01'):HistoryVersion {
  const key=T+suffix, material={sourceId:source,url:`https://history.example/${key}`,title:`Fixture ${suffix}`,publishedAt:day+'T12:00:00Z',bodyText:'Archived excerpt of the original report.'};
  const row={key,article:{id:key,revision:1,title:material.title,url:material.url,author:null,publishedAt:material.publishedAt,bodyText:material.bodyText,excerpt:null,xPost:null,media:[],source:{name:'Archived fixture',kind:'feed',tier:'',firstParty:false}},provenance:{fixture:key}};
  return {key,day,provenance:{fixture:key,url:material.url},prefilter:{row,inputHash:sha256(JSON.stringify(row))},material,targetUrls:[material.url],context:{kind:'article'}};
}
function candidate(...versions:HistoryVersion[]):HistoryCandidate {
  return {identityKey:'url:'+versions[0]!.material!.url,day:versions.map(v=>v.day!).sort()[0]!,dayBasis:'earliest_version_utc',error:null,versions};
}
async function original(v:HistoryVersion,status=200) {
  v.material!.bodyText = v.material!.title; // No archived body, so this fixture must fetch.
  const html='<html><head><script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":true}</script></head><body><article><h1>Fixture</h1><p>A complete short release. Version two fixes the stated bug.</p></article></body></html>';
  const stem=sha256(v.targetUrls[0]!),rawPath=`responses/${stem}.response.gz`;
  await writeFile(join(root,rawPath),gzipSync(html));
  await writeFile(join(root,'responses',stem+'.json'),JSON.stringify({sourceUrl:v.targetUrls[0],finalUrl:v.targetUrls[0],quality:'unconfirmed',status,contentType:'text/html',rawPath,rawSha256:sha256(html)}));
}
async function batch(candidates:HistoryCandidate[],startDay='2026-05-01',endDay='2026-05-02') {
  const file=join(root,tag()+'.jsonl');await writeFile(file,candidates.map(c=>JSON.stringify(c)).join('\n')+'\n');
  const imported=await importHistory({file,label:T,startDay,endDay});
  await configureBackfill(imported.id,models);await controlBackfill(imported.id,'resume','test');return {...imported,file};
}
async function item(id:string,key?:string) {const rows=await sql`SELECT * FROM backfill_items WHERE run_id=${id}`;const row=key?rows.find(r=>r.identity_key===key)!:rows[0]!;return {...row,preparation:row.preparation?loadPreparation(row.preparation):null} as any;}
async function oldCache() {
  const dir=join(root,tag());await mkdir(join(dir,'results'),{recursive:true});process.env.BACKFILL_PREFILTER_CACHE=dir;
  const manifest={format:1,promptVersion:PROMPT_VERSIONS.prefilter,models,environment:{database:sha256(config.databaseUrl),gateway:base,project:'history-test',mode:'stream'}};
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  return async(v:HistoryVersion,result:Record<string,unknown>)=>{
    await writeFile(join(dir,'results',sha256(v.key)+'.json'),JSON.stringify({key:v.key,inputHash:v.prefilter!.inputHash,manifestHash:sha256(stableJson(manifest)),provenance:v.provenance,...result}));
  };
}

test('fixed identity/day denominator retains every version and import is idempotent',async()=>{
  const a=version('day-a'),b=version('day-b','2026-05-02');b.material!.url=a.material!.url;b.prefilter!.row.article.url=a.material!.url;
  const c=candidate(b,a),bad={...c,day:'2026-05-02'};assert.throws(()=>validateCandidate(bad,'2026-05-01','2026-05-02'),/earliest/);
  const r=await batch([c]);assert.equal((await item(r.id)).day.toISOString().slice(0,10),'2026-05-01');
  assert.equal((await item(r.id)).preparation.versions.length,2);
  assert.equal((await importHistory({file:r.file,label:'again',startDay:'2026-05-01',endDay:'2026-05-02'})).id,r.id);
  const overview=await backfillOverview(),run=overview.runs.find(x=>x.id===r.id)!;
  assert.deepEqual(run.totals,{total:1,done:0,published:0,filtered:0,existing:0,pending:1,running:0,failed:0});
});
test('two drains automatically prepare, analyze and finish new items with short originals',async()=>{
  const a=version('auto-a'),b=version('auto-b');await original(a);await original(b);const r=await batch([candidate(a),candidate(b)]);
  const first=await runBackfill(r.id,{concurrency:1,maxItems:1});assert.equal(first.state,'ready');assert.equal(first.processed,1);
  const second=await runBackfill(r.id,{concurrency:1,maxItems:1});assert.equal(second.state,'complete');assert.equal(second.processed,1);
  const rows=await sql`SELECT i.state,i.preparation,a.managed_backfill_id FROM backfill_items i JOIN articles a ON a.id=i.article_id WHERE run_id=${r.id}`;
  assert.equal(rows.length,2);assert.ok(rows.every(x=>x.state==='filtered'&&x.managed_backfill_id===r.id&&loadPreparation(x.preparation).selected));
  for(const row of rows) for(const result of Object.values(loadPreparation(row.preparation).results) as any[]) {
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${result.prefilter.receiptId}`)[0]!.status,'completed');
    assert.equal(result.quality,undefined);
  }
  assert.equal(qualityCalls,0);
});
test('queued recovery is claimed before ordinary history within the same drain capacity',async()=>{
  const early=candidate(version('BLOCK_FIXTURE-early','2026-05-01'));
  const late=candidate(version('BLOCK_FIXTURE-late','2026-05-02'));
  const r=await batch([early,late]);
  const [receipt]=await sql`INSERT INTO receipts(logical_key,service,purpose,status,attempts) VALUES(${tag()},'backfill','prefilter_article','failed',1) RETURNING id`;
  const target={kind:'backfill',items:[{runId:r.id,key:late.identityKey}]};
  await sql`INSERT INTO receipt_recoveries(receipt_id,original_attempt,batch,target_key,target,state,note,original_status)
    VALUES(${receipt!.id},1,${tag()},${JSON.stringify(target)},${sql.json(target)},'queued','test recovery','unknown')`;
  const first=await runBackfill(r.id,{concurrency:2,maxItems:1});
  assert.equal(first.claimed,1);
  assert.equal((await item(r.id,late.identityKey)).state,'filtered');
  assert.equal((await item(r.id,early.identityKey)).state,'pending');
  const second=await runBackfill(r.id,{concurrency:2,maxItems:1});
  assert.equal(second.claimed,1);
  assert.equal((await item(r.id,early.identityKey)).state,'filtered');
});
test('archived HTML with NUL round-trips unchanged through import and settled preparation',async()=>{
  // Actual bodyHtml from raw key 981a370d34f9904b:834acd92d6aa0b7b (x:2064154387879186760).
  const html='<p>昨晚苹果 WWDC 唯一的亮点就是这个灵动岛的新 Siri AI 了。<br />\n<br />\n而且本地端侧模型居然只支持 17Pro 这一款设备，当然欧洲和中国还是不可用。'+'\u0000'.repeat(24)+'</p>\n<a href="https://nitter.net/op7418/status/2064154387879186760#m">\n<br />Video<br />\n  <img src="https://nitter.net/pic/amplify_video_thumb%2F2064057253259554816%2Fimg%2FI7rNWKarBNZ7A1Nt.jpg" />\n</a>';
  const v=version('BLOCK_FIXTURE');v.material!.bodyHtml=html;
  const r=await batch([candidate(v)]);assert.equal((await item(r.id)).preparation.versions[0].material.bodyHtml,html);
  await runBackfill(r.id,{concurrency:1,maxItems:1});const saved=await item(r.id);
  assert.equal(saved.state,'filtered');assert.equal(saved.article_id,null);assert.equal(saved.preparation.versions[0].material.bodyHtml,html);
});
test('archived original bypasses both fetching and the removed completeness model',async()=>{
  const v=version('archived');v.material!.bodyText='A complete short release. Version two fixes the stated bug.';
  const r=await batch([candidate(v)]);await runBackfill(r.id,{concurrency:1,maxItems:1});const saved=await item(r.id);
  assert.ok(saved.article_id);assert.equal(saved.material.bodyText,v.material!.bodyText);
  assert.equal(saved.preparation.results[v.key].fetched,undefined);assert.equal(saved.preparation.results[v.key].quality,undefined);
  assert.equal(qualityCalls,0);
});
test('archived body takes priority over old empty or removed-page extraction',async()=>{
  for (const text of ['', 'This content is no longer available.']) {
    const v=version('old-fetch-'+tag()),r=await batch([candidate(v)]),p=(await item(r.id)).preparation;
    p.results[v.key]={fetched:{status:200,extracted:{text}}};
    await sql`UPDATE backfill_items SET preparation=${sql.json(storePreparation(p))} WHERE run_id=${r.id}`;
    await runBackfill(r.id,{concurrency:1,maxItems:1});
    const saved=await item(r.id);assert.equal(saved.material.bodyText,v.material!.bodyText);assert.equal(saved.state,'filtered');
    assert.equal(saved.preparation.results[v.key].fetched.extracted.text,text);assert.equal(qualityCalls,0);
  }
});
test('HTTP failure stays exceptional while other pending items continue across drains',async()=>{
  const bad=version('00-http'),good=version('99-good');await original(bad,403);await original(good);const r=await batch([candidate(bad),candidate(good)]);
  const before=qualityCalls;assert.equal((await runBackfill(r.id,{concurrency:1,maxItems:1})).state,'ready');assert.equal(qualityCalls,before);
  assert.equal((await item(r.id,candidate(bad).identityKey)).state,'failed');
  assert.equal((await runBackfill(r.id,{concurrency:1,maxItems:1})).state,'needs_attention');
  const totals=(await backfillOverview()).runs.find(x=>x.id===r.id)!.totals;assert.equal(totals.total,2);assert.equal(totals.done,1);assert.equal(totals.failed,1);
});
test('unknown paid result is not automatically redispatched, even on explicit retry',async()=>{
  prefilterMode='unknown';const v=version('unknown');await original(v);const r=await batch([candidate(v)]),before=calls;
  await runBackfill(r.id,{concurrency:1,maxItems:1});const failed=await item(r.id);assert.equal(failed.state,'failed');assert.match(failed.preparation.results[v.key].error,/receipt_unknown/);
  await controlBackfill(r.id,'retry','test');await runBackfill(r.id,{concurrency:1,maxItems:1});assert.equal(calls,before+1);assert.equal((await item(r.id)).article_id,null);
});
test('approved exact material bypasses preparation calls and existing identity is not overwritten',async()=>{
  const v=version('approved');v.approved={state:'complete',evidence:'Exact synthetic fixture approval',contentHash:materialHash(v.material!)};
  const r=await batch([candidate(v)]),before=qualityCalls;await runBackfill(r.id,{concurrency:1,maxItems:1});assert.equal(qualityCalls,before);
  const originalRow=await item(r.id),a=(await sql`SELECT body_text FROM articles WHERE id=${originalRow.article_id}`)[0]!;
  const newer=version('approved-new');newer.material!.url=v.material!.url;const next=await batch([candidate(newer)]),callsBefore=calls;
  await runBackfill(next.id,{concurrency:1,maxItems:1});assert.equal((await item(next.id)).state,'existing');assert.equal(calls,callsBefore);
  assert.equal((await sql`SELECT body_text FROM articles WHERE id=${originalRow.article_id}`)[0]!.body_text,a.body_text);
});
test('confirmed no-dispatch waits without repeatedly reclaiming the same item in one drain',async()=>{
  prefilterMode='undispatched';const v=version('undispatched');await original(v);const r=await batch([candidate(v)]),before=calls;
  const result=await runBackfill(r.id,{concurrency:1,maxItems:10});assert.equal(result.claimed,1);assert.equal(result.state,'ready');assert.equal(calls,before+1);
  const waiting=await item(r.id);assert.equal(waiting.state,'pending');assert.ok(waiting.retry_after.getTime()>Date.now());
  prefilterMode='complete';await sql`UPDATE backfill_items SET retry_after=now() WHERE run_id=${r.id}`;
  assert.equal((await runBackfill(r.id,{concurrency:1,maxItems:1})).state,'complete');
});
test('BLOCK on one version does not exclude another version; invalid URL can only terminate by settled BLOCK',async()=>{
  const a=version('BLOCK_FIXTURE'),b=version('alternate');b.material!.url=a.material!.url;b.prefilter!.row.article.url=a.material!.url;b.targetUrls=a.targetUrls;await original(b);
  const r=await batch([candidate(a,b)]);await runBackfill(r.id,{concurrency:1,maxItems:1});assert.equal((await item(r.id)).preparation.selected.key,b.key);
  const inv=version('invalid-BLOCK_FIXTURE');inv.material=null;inv.prefilter!.row.article.url='about:blank';
  const c:HistoryCandidate={identityKey:'invalid:'+inv.key,day:inv.day,dayBasis:'earliest_version_utc',error:'invalid_original_url',versions:[inv]};
  const invalid=await batch([c]);await runBackfill(invalid.id,{concurrency:1,maxItems:1});assert.equal((await item(invalid.id)).state,'filtered');assert.equal((await item(invalid.id)).article_id,null);
});
test('received prefilter survives crash before preparation save without a second paid call',async()=>{
  const v=version('crash');await original(v);const r=await batch([candidate(v)]),ready=await preflightBackfill(models);
  const ctx={runId:r.id,models:ready.models,beforeCall:async()=>{}};
  const judged=await backfillContext.run(ctx,()=>runPrefilter(preparationArticle(v.prefilter!.row),{}));
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${judged.receiptId}`)[0]!.status,'received');const before=calls;
  await backfillContext.run(ctx,()=>prepareHistoryItem(r.id,candidate(v).identityKey,models));
  assert.equal(calls,before);assert.ok((await item(r.id)).preparation.selected.hash);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${judged.receiptId}`)[0]!.status,'completed');
});
test('old cache rejects wrong input identity and model errors lacking zero-attempt proof',async()=>{
  const v=version('cache'),dir=join(root,'old-cache');await mkdir(join(dir,'results'),{recursive:true});process.env.BACKFILL_PREFILTER_CACHE=dir;
  const manifest={format:1,promptVersion:PROMPT_VERSIONS.prefilter,models,environment:{database:sha256(config.databaseUrl),gateway:base,project:'history-test',mode:'stream'}};
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));const file=join(dir,'results',sha256(v.key)+'.json');
  const result={key:v.key,inputHash:'wrong',manifestHash:sha256(stableJson(manifest)),state:'error',errorKind:'model_error',receiptId:null};
  await writeFile(file,JSON.stringify(result));await assert.rejects(()=>cachedPrefilter(v,models),/input identity/);
  await writeFile(file,JSON.stringify({...result,inputHash:v.prefilter!.inputHash}));await assert.rejects(()=>cachedPrefilter(v,models),/no-dispatch evidence/);
});
test('fetched material retains its source response and short text',()=>{
  const html='<html><head><meta property="og:title" content="Report"><script type="application/ld+json">{"isAccessibleForFree":false}</script></head><body><p>A short self-contained lead.</p></body></html>';
  const context=originalPageContext(html);assert.match(context.structuredData.join(''),/isAccessibleForFree/);
  const v=version('paywall'),input=historyMaterial(v,{status:200,sourceUrl:v.targetUrls[0],finalUrl:v.targetUrls[0],extracted:{text:'Lead.',html:'<p>Lead.</p>',via:'readability',images:[]},...context});
  assert.equal(input.material.bodyText,'Lead.');assert.equal((input.context as any).status,200);assert.match(JSON.stringify(input.context),/isAccessibleForFree/);
});
test('different raw keys share a settled prefilter receipt only for the identical actual request',async()=>{
  const a=version('shared'),b=structuredClone(a);b.key+='-other';b.prefilter!.row.key=b.key;b.prefilter!.row.article.id=b.key;b.prefilter!.inputHash=sha256(JSON.stringify(b.prefilter!.row));
  assert.equal(prefilterRequest(preparationArticle(a.prefilter!.row)).user,prefilterRequest(preparationArticle(b.prefilter!.row)).user);
  const ready=await preflightBackfill(models),ctx={runId:'cache-shared',models:ready.models,beforeCall:async()=>{}};
  const response=await backfillContext.run(ctx,()=>runPrefilter(preparationArticle(a.prefilter!.row),{}));await completeReceipt(sql,response.receiptId);
  const save=await oldCache(),result={...response,state:'needs_original',receiptCompleted:true};await save(a,result);await save(b,result);
  const before=calls;assert.equal((await cachedPrefilter(a,models))!.receiptId,response.receiptId);assert.equal((await cachedPrefilter(b,models))!.receiptId,response.receiptId);
  b.prefilter!.row.article.title='Different paid request payload';b.prefilter!.inputHash=sha256(JSON.stringify(b.prefilter!.row));await save(b,result);
  await assert.rejects(()=>cachedPrefilter(b,models),/request identity mismatch/);assert.equal(calls,before);
});
test('old unknown cache resumes only after its exact receipt is reconciled, with zero dispatch',async()=>{
  const v=version('reconciled'),ready=await preflightBackfill(models),ctx={runId:'cache-reconciled',models:ready.models,beforeCall:async()=>{}};
  const response=await backfillContext.run(ctx,()=>runPrefilter(preparationArticle(v.prefilter!.row),{}));
  const [original]=await sql`SELECT response FROM receipts WHERE id=${response.receiptId}`;
  await sql`UPDATE receipts SET status='unknown',response=NULL WHERE id=${response.receiptId}`;
  const save=await oldCache();await save(v,{state:'error',label:null,errorKind:'receipt_unknown',receiptId:response.receiptId,receiptCompleted:null});
  const before=calls;await assert.rejects(()=>cachedPrefilter(v,models),/requires reconciliation/);
  await sql`UPDATE receipts SET status='received',response=${sql.json(original!.response)} WHERE id=${response.receiptId}`;
  const received=await cachedPrefilter(v,models);assert.equal(received!.label,response.label);assert.equal(received!.reused,true);assert.equal(received!.receiptCompleted,false);
  await completeReceipt(sql,response.receiptId);assert.equal((await cachedPrefilter(v,models))!.receiptCompleted,true);assert.equal(calls,before);
});
test('explicit paid replay authorization bypasses an old error cache only for its captured attempt',async()=>{
  const v=version('authorized-replay'),ready=await preflightBackfill(models),ctx={runId:'cache-replay',models:ready.models,beforeCall:async()=>{}};
  const response=await backfillContext.run(ctx,()=>runPrefilter(preparationArticle(v.prefilter!.row),{}));
  const save=await oldCache();await save(v,{state:'error',label:null,errorKind:'receipt_unknown',receiptId:response.receiptId,receiptCompleted:null});
  await sql`UPDATE receipts SET status='failed',response=NULL WHERE id=${response.receiptId}`;
  await assert.rejects(()=>cachedPrefilter(v,models),/no-dispatch evidence/);
  await sql`INSERT INTO receipt_recoveries(receipt_id,original_attempt,batch,target_key,target,state,note,original_status)
    VALUES (${response.receiptId},1,${tag()},'fixture','{"kind":"backfill","items":[]}','queued','authorized possible paid replay','unknown')`;
  const before=calls;assert.equal(await cachedPrefilter(v,models),null);assert.equal(calls,before);
  await sql`UPDATE receipts SET attempts=2 WHERE id=${response.receiptId}`;
  await assert.rejects(()=>cachedPrefilter(v,models),/no-dispatch evidence/);
});
test('six real X NUL samples reach material_ready and article without a completeness call',async()=>{
  const samples=JSON.parse(await readFile(new URL('./fixtures/backfill-nul-material.json',import.meta.url),'utf8'));
  const ready=await preflightBackfill(models);
  for(const [index,sample] of samples.entries()) {
    const v=version('nul-native-'+index,sample.material.publishedAt.slice(0,10));
    // Keep the real content, quote, media and archive evidence; use isolated test source/post identity.
    const tweetId=String(Date.now())+index,url=`https://x.com/${sample.material.xPost.handle}/status/${tweetId}`;
    v.material={...sample.material,sourceId:source,url,xPost:{...sample.material.xPost,tweetId}};v.context=sample.context;
    v.provenance={rawKey:sample.key};v.targetUrls=[];
    Object.assign(v.prefilter!.row.article,{...v.material,id:v.key,source:{name:'Archived fixture',kind:'x',tier:'',firstParty:false}});
    v.prefilter!.inputHash=sha256(JSON.stringify(v.prefilter!.row));
    const c={...candidate(v),identityKey:'x:'+tweetId},r=await batch([c],'2026-06-09','2026-06-10');
    forcePrefilterPass=true;
    const input=historyMaterial(v);assert.equal(input.material.bodyHtml,undefined);assert.deepEqual(input.material.xPost,v.material!.xPost);assert.equal(input.material.bodyText,sample.material.bodyText);
    await backfillContext.run({runId:r.id,models:ready.models,beforeCall:async()=>{}},()=>prepareHistoryItem(r.id,c.identityKey,models));
    forcePrefilterPass=false;
    const prepared=await item(r.id);assert.equal(prepared.stage,'material_ready');assert.equal(prepared.content_hash,materialHash(input.material));assert.deepEqual(prepared.material,input.material);
    assert.equal(prepared.preparation.results[v.key].quality,undefined);assert.equal(qualityCalls,0);
    assert.equal(prepared.preparation.versions[0].material.bodyHtml,sample.material.bodyHtml);
    await runBackfill(r.id,{concurrency:1,maxItems:1});const saved=await item(r.id);assert.ok(saved.article_id);assert.equal(saved.content_hash,prepared.content_hash);
    const [article]=await sql`SELECT body_text,body_html,x_post FROM articles WHERE id=${saved.article_id}`;
    assert.equal(article!.body_html,null);assert.equal(article!.body_text,input.material.bodyText);assert.deepEqual(article!.x_post,input.material.xPost);
  }
});
