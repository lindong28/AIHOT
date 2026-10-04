import { tag, stub } from './setup.ts';
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { config } from '@aihot/backend/config';
import { contentHash, upsertMaterial } from '@aihot/backend/content/materials';
import { discardFilteredContent, discardBackfillContent, discardExpiredSignals, wechatOrigin } from '@aihot/backend/content/retention';
import { processArticle, queueProcessing, settleNonEditorial } from '@aihot/backend/jobs/content';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { publishArticle } from '@aihot/backend/publication/publish';
import { loadItemDetail, exportMarkdown } from '@aihot/backend/publication/detail';
import { loadAnalyzeInput } from '@aihot/backend/editorial/input';
import { extractArticleBody } from '@aihot/backend/content/extract';
import { storePreparation, loadPreparation, type PreparationState } from '@aihot/backend/backfill/history-input';
import { prepareHistoryItem } from '@aihot/backend/backfill/preparation';
import { groupArticle } from '@aihot/backend/events/group';
import { ensureEmbeddings } from '@aihot/backend/providers/embeddings';

const prefix=tag(), sources:Record<string,string>={};
before(async()=>{
  for (const kind of ['rss','web_list','json_list','x_search','external','mp_account']) {
    sources[kind]=prefix+kind;
    await sql`INSERT INTO sources(id,name,kind,tier,enabled,next_fetch_at) VALUES(${sources[kind]!},${kind},${kind},'T2',false,'2100-01-01')`;
  }
  for (const mode of ['hot_signal','isolated']) {
    sources[mode]=prefix+mode;
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,enabled) VALUES(${sources[mode]!},${mode},'x_search','T2',${mode},false)`;
  }
});
after(async()=>{await stopBoss();await closeDb();});
async function material(kind='rss',url=`https://retention.example/${tag()}`) {
  const input={sourceId:sources[kind]!,url,title:'新闻原始标题',bodyText:'Original full body '.repeat(30),bodyHtml:'<p>full body</p>',excerpt:'original excerpt',raw:{original:'payload'},via:'fetch' as const,language:'zh',bodyStatus:'ok' as const};
  return {input,id:(await upsertMaterial(input)).articleId};
}
async function judge(id:string,relevance='block') {
  const [a]=await sql`SELECT revision FROM articles WHERE id=${id}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,selected,output)
    VALUES(${id},${a!.revision},'rule',${relevance},'中文标题',${relevance==='pass'?'可用摘要':null},false,'{"prefilter":{"label":"BLOCK","reason":"test"}}')`;
  await sql`UPDATE articles SET processing_state=${relevance==='block'?'blocked':'analyzed'} WHERE id=${id}`;
  await publishArticle(id);
}
async function row(id:string){return (await sql`SELECT * FROM articles WHERE id=${id}`)[0]!;}
async function assertCleared(id:string) {
  const a=await row(id);assert.ok(a.content_discarded_at);assert.equal(a.title,'');
  for (const key of ['excerpt','body_text','body_html','raw','x_post','x_article']) assert.equal(a[key],null,key);
  assert.deepEqual(a.media,[]);
  assert.equal((await sql`SELECT 1 FROM article_revisions WHERE article_id=${id} AND (title<>'' OR body_text IS NOT NULL)`).length,0);
  assert.equal((await sql`SELECT 1 FROM translations WHERE article_id=${id}`).length,0);
  assert.equal((await sql`SELECT 1 FROM pool_search WHERE article_id=${id}`).length,0);
  assert.equal((await loadItemDetail(id)).kind,'not_found');assert.equal(await exportMarkdown(id),null);
}

test('real-time processing clears non-WeChat BLOCK and preserves a WeChat BLOCK with settled receipts',async()=>{
  const provider=await stub(()=>({choices:[{message:{content:JSON.stringify({label:'BLOCK',reason:'not relevant'})}}],usage:{prompt_tokens:3,completion_tokens:3}}));
  process.env.DASHSCOPE_BASE_URL=provider.url;process.env.DASHSCOPE_API_KEY='test-key';
  config.modelCallsEnabled=true;
  try {
    for(const kind of ['rss','mp_account']) {
      const a=await material(kind);assert.equal((await processArticle(a.id)).state,'block');
      if(kind==='rss') await assertCleared(a.id);else assert.equal((await row(a.id)).body_text,a.input.bodyText);
      const [r]=await sql`SELECT status,response FROM receipts WHERE subject=${'article:'+a.id+'@1'}`;
      assert.equal(r!.status,'completed');assert.ok(r!.response);
    }
  } finally {config.modelCallsEnabled=false;await provider.close();}
});

test('all non-WeChat source kinds discard complete filtered payload and keep hashes/audit decisions',async()=>{
  for(const kind of ['rss','web_list','json_list','x_search','external']) {
    const a=await material(kind);await judge(a.id);
    await sql`INSERT INTO translations(article_id,revision,body_text,body_html) VALUES(${a.id},1,'translated','<p>translated</p>')`;
    await sql`UPDATE articles SET x_post='{"text":"post"}',x_article='{"text":"long post"}',media='[{"kind":"image","url":"https://example.com/image"}]' WHERE id=${a.id}`;
    assert.equal(await discardFilteredContent(a.id),true);await assertCleared(a.id);
    const [n]=await sql`SELECT relevance,output,receipt_ids FROM analyses WHERE article_id=${a.id}`;assert.equal(n!.relevance,'block');assert.deepEqual(n!.output,{});
    assert.equal((await row(a.id)).content_hash,contentHash(a.input));
  }
});

test('WeChat URL, native source, and discovered source preserve body; lookalike domains do not',async()=>{
  assert.equal(wechatOrigin(undefined,undefined,'https://mp.weixin.qq.com.evil.example/x'),false);
  for(const [kind,url] of [['mp_account',`https://example.com/${tag()}`],['external',`https://mp.weixin.qq.com/s/${tag()}`]]) {
    const a=await material(kind,url);await judge(a.id);assert.equal(await discardFilteredContent(a.id),false);assert.equal((await row(a.id)).body_text,a.input.bodyText);
  }
  const a=await material();await judge(a.id);await upsertMaterial({...a.input,sourceId:sources.mp_account!});
  assert.equal(await discardFilteredContent(a.id),false);
});

test('pool-eligible nonselected, unprocessed, failed, stale analysis and unknown billing remain intact',async()=>{
  for(const state of ['eligible','new','failed','stale','billing','review-billing','received']) {
    const a=await material();
    if(state!=='new') await judge(a.id,state==='eligible'?'pass':'block');
    if(state==='failed') await sql`UPDATE articles SET processing_state='failed' WHERE id=${a.id}`;
    if(state==='stale') await sql`UPDATE articles SET revision=revision+1 WHERE id=${a.id}`;
    if(state==='billing') await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status) VALUES(${tag()},'test','analyze',${'article:'+a.id+'@1'},'unknown')`;
    if(state==='review-billing') await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status) VALUES(${tag()},'test','group_review',${'article:'+a.id+':fact:42'},'unknown')`;
    if(state==='received') await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status) VALUES(${tag()},'test','embedding',${'article:'+a.id},'received')`;
    assert.equal(await discardFilteredContent(a.id),false,state);assert.equal((await row(a.id)).body_text,a.input.bodyText);
  }
  const a=await material();await judge(a.id,'unknown');assert.equal(await discardFilteredContent(a.id),true);await assertCleared(a.id);
});

test('same collected input stays discarded after extraction; new content restores one revision, not a duplicate',async()=>{
  const input={sourceId:sources.rss!,url:`https://retention.example/${tag()}`,title:'title',excerpt:'feed excerpt',via:'fetch' as const};
  const a=await upsertMaterial(input);
  await sql`UPDATE articles SET body_text='extracted body',revision=2,content_hash=${contentHash({...input,bodyText:'extracted body'})},body_status='ok' WHERE id=${a.articleId}`;
  await judge(a.articleId);await discardFilteredContent(a.articleId);
  assert.equal((await upsertMaterial(input)).revised,false);await assertCleared(a.articleId);
  const results=await Promise.all([upsertMaterial({...input,title:'changed news'}),upsertMaterial({...input,title:'changed news'})]);
  assert.equal(results.filter(r=>r.revised).length,1);assert.ok(results.every(r=>r.articleId===a.articleId));
  assert.equal((await row(a.articleId)).processing_state,'new');assert.equal((await row(a.articleId)).revision,3);
});

test('new WeChat evidence can restore discarded content and obsolete jobs cannot repopulate it',async()=>{
  const a=await material();await judge(a.id);await discardFilteredContent(a.id);
  assert.equal(await queueProcessing(a.id),null);assert.equal(await publishArticle(a.id),null);assert.equal(await loadAnalyzeInput(a.id),null);
  assert.equal(await extractArticleBody(a.id),'skipped');assert.equal((await groupArticle(a.id)).verdict,'skipped');
  assert.equal((await processArticle(a.id)).state,'discarded');await assertCleared(a.id);
  assert.equal((await upsertMaterial({...a.input,sourceId:sources.mp_account!})).revised,true);
  await judge(a.id);assert.equal(await discardFilteredContent(a.id),false);assert.equal((await row(a.id)).body_text,a.input.bodyText);
});

test('unmatched signals keep their wait window, expire via the scheduled path; isolated content clears immediately',async()=>{
  const a=await material('hot_signal');await settleNonEditorial(a.id);
  assert.equal(await discardFilteredContent(a.id),false);assert.equal((await row(a.id)).content_discard_after,null);
  await sql`UPDATE articles SET discovered_at=now()-interval '3 days' WHERE id=${a.id}`;
  await discardExpiredSignals();assert.equal((await row(a.id)).body_text,a.input.bodyText,'no completed grouping means no expiry');
  await sql`UPDATE articles SET discovered_at=now() WHERE id=${a.id}`;
  assert.equal((await groupArticle(a.id,{signalOnly:true})).verdict,'signal-unmatched');
  assert.ok((await row(a.id)).content_discard_after);
  await sql`UPDATE articles SET content_discard_after=now()-interval '1 minute' WHERE id=${a.id}`;
  await discardExpiredSignals();await assertCleared(a.id);
  const isolated=await material('isolated');await settleNonEditorial(isolated.id);await assertCleared(isolated.id);
  const old=await material('hot_signal');await sql`UPDATE articles SET processing_state='skipped' WHERE id=${old.id}`;await publishArticle(old.id);
  await discardExpiredSignals();assert.equal((await row(old.id)).body_text,old.input.bodyText,'old cohort is not swept');
});

test('successful embedding and both body-fetch outcomes settle receipts before filtered content is discarded',async()=>{
  const provider=await stub((_hit,req)=>{
    if(req.url==='/embeddings') return {data:JSON.parse(req.body).input.map((_:unknown,index:number)=>({index,embedding:[1,0]}))};
    if(req.url.includes('/twitter/article/')) return req.url.endsWith('/empty')?{}:{article:{title:'Long article',content_state:{blocks:[{type:'unstyled',text:'long text '.repeat(40)}]}}};
    if(req.url.startsWith('/http')) return req.url.endsWith('/empty')?'short':'rendered body '.repeat(40);
    return {};
  });
  process.env.DASHSCOPE_API_KEY='test-key';process.env.DASHSCOPE_BASE_URL=provider.url;
  process.env.SOCIALDATA_API_KEY='test-key';process.env.SOCIALDATA_BASE_URL=provider.url;
  process.env.JINA_API_KEY='test-key';process.env.JINA_BASE_URL=provider.url;
  config.modelCallsEnabled=true;config.allowPrivateNetworkFetch=true;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=10000,per_day=100000 WHERE service IN ('socialdata','jina','dashscope')`;
  try {
    const a=await material();await ensureEmbeddings('article',[{id:a.id,text:'embedding input'}]);
    assert.equal((await sql`SELECT status FROM receipts WHERE subject=${'article:'+a.id}`)[0]!.status,'completed');
    await judge(a.id);assert.equal(await discardFilteredContent(a.id),true);
    for(const service of ['jina','socialdata']) for(const outcome of ['full','empty']) {
      const b=await material('rss',`${provider.url}/${tag()}/${outcome}`);
      await sql`UPDATE articles SET body_status='none',x_post=${service==='socialdata'?sql.json({tweetId:outcome}):null} WHERE id=${b.id}`;
      assert.equal(await extractArticleBody(b.id),outcome==='full'?'ok':'unconfirmed');
      assert.equal((await sql`SELECT status FROM receipts WHERE subject=${'article:'+b.id}`)[0]!.status,'completed');
      await judge(b.id);assert.equal(await discardFilteredContent(b.id),true);await assertCleared(b.id);
    }
  } finally {config.modelCallsEnabled=false;await provider.close();}
});

async function backfill(kind='rss',withArticle=false) {
  const a=await material(kind);await judge(a.id);const run=tag(),key=(await row(a.id)).identity_key;
  await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day) VALUES(${run},'fixture',${tag()},'2026-01-01','2026-01-01')`;
  const p:PreparationState={dayBasis:'earliest_version_utc',versions:[{key,day:'2026-01-01',provenance:{url:a.input.url,sourceId:a.input.sourceId,rawHash:'hash'},prefilter:{row:{key,article:{bodyText:'prefilter original'},provenance:{}},inputHash:'hash'},material:{...a.input,publishedAt:'2026-01-01T00:00:00Z'},context:{body:'context copy'},targetUrls:[a.input.url]}],results:{[key]:{prefilter:{label:'BLOCK',receiptId:null},fetched:{text:'fetched copy'}}}};
  await sql`INSERT INTO backfill_items(run_id,identity_key,day,material,content_hash,evidence,state,article_id,preparation)
    VALUES(${run},${key},'2026-01-01',${sql.json(a.input)},'hash','fixture','filtered',${withArticle?a.id:null},${sql.json(storePreparation(p))})`;
  return {...a,run,key};
}
test('backfill both pre-article and post-analysis compact all payload while retaining terminal progress and provenance',async()=>{
  for(const withArticle of [false,true]) {
    const a=await backfill('rss',withArticle);assert.equal(await discardBackfillContent(a.run,a.key),true);
    const [i]=await sql`SELECT * FROM backfill_items WHERE run_id=${a.run}`;assert.equal(i!.state,'filtered');assert.ok(i!.content_discarded_at);assert.deepEqual(i!.material,{});
    const p=loadPreparation(i!.preparation);assert.equal(p.versions[0]!.material,null);assert.equal(p.versions[0]!.provenance.rawHash,'hash');assert.equal(p.results[a.key]!.fetched,undefined);
    if(withArticle) await assertCleared(a.id);
    assert.equal(await prepareHistoryItem(a.run,a.key,{} as never),'terminal');
    assert.equal(await discardBackfillContent(a.run,a.key),false);
  }
});
test('backfill protects WeChat in either stage and failed work; archive WeChat evidence protects an RSS article too',async()=>{
  for(const withArticle of [false,true]) {const a=await backfill('mp_account',withArticle);assert.equal(await discardBackfillContent(a.run,a.key),false);assert.equal((await row(a.id)).body_text,a.input.bodyText);}
  const a=await backfill('rss',true);const [i]=await sql`SELECT preparation FROM backfill_items WHERE run_id=${a.run}`;const p=loadPreparation(i!.preparation);
  p.versions[0]!.provenance.url='https://mp.weixin.qq.com/s/original';
  await sql`UPDATE backfill_items SET preparation=${sql.json(storePreparation(p))} WHERE run_id=${a.run}`;
  assert.equal(await discardBackfillContent(a.run,a.key),false);assert.equal((await row(a.id)).body_text,a.input.bodyText);
  const failed=await backfill();await sql`UPDATE backfill_items SET state='failed' WHERE run_id=${failed.run}`;
  assert.equal(await discardBackfillContent(failed.run,failed.key),false);
});
