import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { publishArticle } from '@aihot/backend/publication/publish';
import { loadItemDetail, exportMarkdown } from '@aihot/backend/publication/detail';
import { createSource } from '@aihot/backend/admin/sources';
import { parseRss } from '@aihot/backend/sources/rss';
import type { SourceRow } from '@aihot/backend/sources/types';
const T = tag();
after(async () => { await stopBoss(); await closeDb(); });
test('full-text text-only archive is readable and safely escaped, licence remains enforced', async () => {
  const source = `wx-text-${T}`;
  await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${source},'Archive','external',true)`;
  const a = await upsertMaterial({sourceId:source,url:`https://mp.weixin.qq.com/s/${T}`,title:'Title',language:'zh',bodyText:'完整正文 <script>bad</script>',bodyStatus:'ok',via:'import'});
  await publishArticle(a.articleId);
  let r = await loadItemDetail(a.articleId);
  assert.equal(r.kind,'found');
  if(r.kind !== 'found') return;
  assert.match(r.detail.body?.zh ?? '', /&lt;script&gt;/);
  assert.ok(r.detail.markdownAvailable);
  assert.match((await exportMarkdown(a.articleId))?.body ?? '', /完整正文/);
  await sql`UPDATE sources SET site_fulltext=false WHERE id=${source}`;
  await publishArticle(a.articleId);
  r = await loadItemDetail(a.articleId);
  assert.equal(r.kind==='found' && r.detail.body,null);
});
test('new mp defaults to site fulltext but explicit false and non-mp defaults survive', async () => {
  for (const [suffix,kind,setting,expected] of [['mp','mp_account',undefined,true],['off','mp_account',false,false],['rss','rss',undefined,false]] as const) {
    const r = await createSource({id:`wx-create-${suffix}-${T}`,name:suffix,kind,config:{},...(setting===undefined?{}:{site_fulltext:setting})},'test');
    assert.ok(r.created);
    if(r.created) { assert.equal(r.source!.site_fulltext,expected); assert.equal(r.source!.syndicate_fulltext,false); }
  }
});
test('wechat feed rejects observed UI shells but preserves short text and image posts', () => {
  const source = {kind:'mp_account',participation_mode:'editorial',config:{}} as SourceRow;
  const parse=(html:string)=>parseRss(`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>T</title><link>https://mp.weixin.qq.com/s/test</link><content:encoded><![CDATA[${html}]]></content:encoded></item></channel></rss>`,source,'https://example.com')[0]!;
  for(const shell of ['不喜欢','跳转微信打开']) assert.notEqual(parse(`<p>${shell}</p>`).bodyStatus,'ok');
  assert.equal(parse('<p>今天发布。</p>').bodyStatus,'ok');
  assert.equal(parse('<p><img src="https://mmbiz.qpic.cn/a"></p>').bodyStatus,'ok');
});


test('repair preserves frozen imports, fences edits, and replays without another revision', async () => {
  const { repairHash, repairWechatBody } = await import('@aihot/backend/content/wechat-repair');
  const source=`wx-repair-${T}`;
  await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${source},'Repair','mp_account',true)`;
  const a=await upsertMaterial({sourceId:source,url:`https://mp.weixin.qq.com/s/repair-${T}`,title:'标题',bodyText:'不喜欢',bodyHtml:'<p>不喜欢</p>',bodyStatus:'ok',via:'import',publishedAt:new Date('2026-04-01')});
  const oldRun=`old-${T}`;
  await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,state,models) VALUES(${oldRun},'Original',${oldRun},'2026-04-01','2026-04-01','complete','{}')`;
  await sql`UPDATE articles SET managed_backfill_id=${oldRun} WHERE id=${a.articleId}`;
  await sql`INSERT INTO backfill_items(run_id,identity_key,day,material,content_hash,evidence,state,article_id)
    SELECT ${oldRun},identity_key,'2026-04-01','{}','frozen','original','filtered',id FROM articles WHERE id=${a.articleId}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,selected,summary_zh) VALUES(${a.articleId},1,'rule','pass',true,'旧摘要')`;
  const [before]=await sql`SELECT * FROM articles WHERE id=${a.articleId}`;
  const repair={articleId:a.articleId,expectedHash:repairHash(before!),bodyText:'恢复的正文',bodyHtml:'<p>恢复的正文</p>',evidence:'frozen version test'};
  await assert.rejects(repairWechatBody({...repair,expectedHash:'0'.repeat(64)}),/changed/);
  await sql`INSERT INTO editorial_overrides(article_id,fields) VALUES(${a.articleId},'{}')`;
  await assert.rejects(repairWechatBody(repair),/overrides/);
  await sql`DELETE FROM editorial_overrides WHERE article_id=${a.articleId}`;
  const result=await repairWechatBody(repair);
  assert.equal(result.revision,2); assert.ok(result.runId); assert.equal(result.reused,false);
  assert.equal((await repairWechatBody(repair)).reused,true);
  const [after]=await sql`SELECT * FROM articles WHERE id=${a.articleId}`;
  assert.equal(after!.revision,2); assert.equal(after!.processing_state,'new');
  const [item]=await sql`SELECT * FROM backfill_items WHERE run_id=${oldRun}`;
  assert.equal(item!.evidence,'original'); assert.equal(item!.state,'filtered');
  const [pub]=await sql`SELECT eligible,selected,summary FROM publications WHERE article_id=${a.articleId}`;
  assert.equal(pub!.eligible,false); assert.equal(pub!.selected,false); assert.equal(pub!.summary,null);
  const [next]=await sql`SELECT i.article_revision,i.article_hash,r.state,r.models FROM backfill_items i JOIN backfill_runs r ON r.id=i.run_id WHERE i.run_id=${result.runId}`;
  assert.equal(next!.article_revision,2); assert.equal(next!.article_hash,after!.content_hash); assert.equal(next!.state,'paused');
  assert.deepEqual(next!.models,{});
  const html=await repairWechatBody({articleId:a.articleId,expectedHash:repairHash(after!),bodyText:'恢复的正文',bodyHtml:'<h2>恢复的正文</h2><script>alert(1)</script>',evidence:'HTML only'});
  assert.equal(html.revision,2); assert.equal(html.textChanged,false); assert.equal(html.runId,null);
  const [safe]=await sql`SELECT body_html FROM articles WHERE id=${a.articleId}`;
  assert.ok(!safe!.body_html.includes('script'));
});


test('incomplete Wechat2RSS bodies survive for repair without entering analysis',async()=>{
  const { queueProcessing }=await import('@aihot/backend/jobs/content');
  const source=`wx-pending-${T}`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${source},'Pending','mp_account','{"provider":"wechat2rss"}')`;
  const a=await upsertMaterial({sourceId:source,url:`https://mp.weixin.qq.com/s/pending-${T}`,title:'T',bodyText:'跳转微信打开',bodyStatus:'unconfirmed',via:'fetch'});
  assert.equal(await queueProcessing(a.articleId),null);
  const fixed=await upsertMaterial({sourceId:source,url:`https://mp.weixin.qq.com/s/pending-${T}`,title:'T',bodyText:'完整文章正文。',bodyStatus:'ok',via:'fetch'});
  assert.ok(fixed.revised); assert.ok(await queueProcessing(a.articleId));
  const html=await upsertMaterial({sourceId:source,url:`https://mp.weixin.qq.com/s/pending-${T}`,title:'T',bodyText:'完整文章正文。',bodyHtml:'<p>完整文章正文。</p>',bodyStatus:'ok',via:'fetch'});
  assert.equal(html.revised,false);
  const [stored]=await sql`SELECT body_html,revision FROM articles WHERE id=${a.articleId}`;
  assert.equal(stored!.revision,2);assert.equal(stored!.body_html,'<p>完整文章正文。</p>');
});


test('a missing media-only body can recover with unchanged text',async()=>{
 const {queueProcessing}=await import('@aihot/backend/jobs/content');
 const source=`wx-image-${T}`;
 await sql`INSERT INTO sources(id,name,kind,config,site_fulltext) VALUES(${source},'Image','mp_account','{"provider":"wechat2rss"}',true)`;
 const input={sourceId:source,url:`https://mp.weixin.qq.com/s/image-${T}`,title:'Image',bodyText:'',via:'fetch' as const};
 const a=await upsertMaterial({...input,bodyStatus:'unconfirmed'});
 assert.equal(await queueProcessing(a.articleId),null);
 const recovered=await upsertMaterial({...input,bodyHtml:'<img src="https://mmbiz.qpic.cn/a">',bodyStatus:'ok'});
 assert.equal(recovered.revised,true);
 assert.ok(await queueProcessing(a.articleId));
 await publishArticle(a.articleId);
 const detail=await loadItemDetail(a.articleId);
 assert.ok(detail.kind==='found' && (detail.detail.body?.original??'').includes('<img'));
 assert.equal((await upsertMaterial({...input,bodyHtml:'<img src="https://mmbiz.qpic.cn/a">',bodyStatus:'ok'})).revised,false);
});


test('managed WeChat repairs accept a verified image-only body',async()=>{
 const {repairHash,repairWechatBody}=await import('@aihot/backend/content/wechat-repair');
 const source=`wx-managed-image-${T}`,run=`wx-old-image-${T}`;
 await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${source},'Managed image','mp_account',true)`;
 await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,state,models) VALUES(${run},'Old',${run},'2026-04-01','2026-04-01','complete','{}')`;
 const a=await upsertMaterial({sourceId:source,url:`https://mp.weixin.qq.com/s/managed-image-${T}`,title:'Image',bodyText:'不喜欢',bodyStatus:'ok',via:'import',publishedAt:new Date('2026-04-01')});
 await sql`UPDATE articles SET managed_backfill_id=${run} WHERE id=${a.articleId}`;
 const [before]=await sql`SELECT * FROM articles WHERE id=${a.articleId}`;
 const r=await repairWechatBody({articleId:a.articleId,expectedHash:repairHash(before!),bodyText:'',bodyHtml:'<img src="https://mmbiz.qpic.cn/a">',evidence:'verified media body'});
 assert.equal(r.revision,2);assert.ok(r.runId);
 const [item]=await sql`SELECT material FROM backfill_items WHERE run_id=${r.runId}`;
 assert.equal(item!.material.bodyText,'');assert.ok(item!.material.bodyHtml.includes('<img'));
});


test('fulltext rebuild reports all concurrent sources and is repeatable',async()=>{
 const {enableWechatFulltext}=await import('@aihot/backend/content/wechat-repair');
 const {WECHAT_ARCHIVE_SOURCES}=await import('@aihot/backend/content/wechat');
 for(let i=0;i<3;i++) {
  const source=`wx-count-${i}-${T}`;
  await sql`INSERT INTO sources(id,name,kind,site_fulltext) VALUES(${source},'Count','mp_account',false)`;
  const a=await upsertMaterial({sourceId:source,url:`https://mp.weixin.qq.com/s/count-${i}-${T}`,title:'Title',bodyText:'正文',bodyStatus:'ok',via:'import'});
  await publishArticle(a.articleId);
 }
 const [before]=await sql`SELECT count(*) AS total,count(*) FILTER(WHERE NOT site_fulltext) AS changed FROM sources WHERE kind='mp_account' OR id IN ${sql(WECHAT_ARCHIVE_SOURCES)}`;
 const [articles]=await sql`SELECT count(*) AS total FROM publications p JOIN sources s ON s.id=p.source_id WHERE s.kind='mp_account' OR s.id IN ${sql(WECHAT_ARCHIVE_SOURCES)}`;
 assert.deepEqual(await enableWechatFulltext(),{sources:before!.total,changed:before!.changed,rebuilt:articles!.total});
 assert.deepEqual(await enableWechatFulltext(),{sources:before!.total,changed:0,rebuilt:articles!.total});
});
