import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { checkWechat2Rss, retryWechatBody } from "@aihot/backend/sources/wechat2rss";
import { before, after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { parseWechatPage, attestWechatReadingLink } from "@aihot/backend/content/wechat";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { resolveWechatMaterialIdentity, assertWechatFrozenIdentity } from "@aihot/backend/content/wechat-link-registry";
import { associateWechatReadingEvidence } from "@aihot/backend/content/wechat-reading-ops";
import { publishArticle, publishArticleTx } from "@aihot/backend/publication/publish";
import { selectedSnapshot, selectedChanges } from "@aihot/backend/publication/v1";
import { repairSourceLabel } from "@aihot/backend/publication/repair-source-labels";
import { loadReport, v1Daily } from "@aihot/backend/publication/reports";
import { loadGroupReports } from "@aihot/backend/publication/groups";
import { v1Story } from "@aihot/backend/publication/stories";
import { documentId, readArticle, resolveArticle } from "@aihot/backend/research/read";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag(), source = `reading-${T}`, token = `reading-token-${T}`;
const app = await buildApp();
let base: string, number = 0;
before(async()=>{
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext)
    VALUES(${source},'阅读测试','mp_account','T1','editorial',true,true)`;
  await sql`UPDATE research_index_state SET articles_complete=true,materials_complete=true`;
  process.env.RESEARCH_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
  base = await app.listen({port:0,host:"127.0.0.1"});
});
after(async()=>{await app.close();await stopBoss();await closeDb();delete process.env.RESEARCH_TOKEN_SHA256;});
function fixture() {
  const mid = String(Date.now()*100 + number++), biz = Buffer.from("123456").toString("base64"), sn = "a".repeat(32);
  const short = `https://mp.weixin.qq.com/s/${T}-${number}`;
  const long = `https://mp.weixin.qq.com/s?__biz=${biz}&mid=${mid}&idx=1&sn=${sn}`;
  const identity = {biz,mid,idx:"1",sn};
  const observation = {observedAt:"2026-10-31T04:47:27.109Z",pageUrl:short,hasContent:true as const,identity,msgLink:short,ogUrl:short};
  const script = `var biz = "" || "${biz}"; var mid = "${mid}"; var idx = 1; var sn = "${sn}"; var msg_link = "${short}";`;
  const html = `<meta property="og:url" content="${short}"><script>${script}</script><div id="js_content"><p>已保留的真实正文。</p></div>`;
  return {short,long,identity,observation,html,script,key:identityKeyForUrl(long)!};
}
async function article(f: ReturnType<typeof fixture>, url = f.long, proof = false) {
  return upsertMaterial({sourceId:source,url,title:`阅读-${f.identity.mid}`,language:"zh",bodyText:"已保留的真实正文。",bodyHtml:"<p>已保留的真实正文。</p>",
    bodyStatus:"ok",publishedAt:new Date(),via:"import",...(proof ? {readingProof:attestWechatReadingLink(f.observation,url,"test-fixture")} : {})});
}
const register = (f: ReturnType<typeof fixture>, articleId: string, apply = true) =>
  associateWechatReadingEvidence({articleId,observation:f.observation,operator:"test-fixture",apply});
async function get(path: string, auth: string | null = token) {
  const response = await fetch(base+path,{headers:auth ? {Authorization:`Bearer ${auth}`} : {}});
  return {status:response.status,text:await response.text(),headers:response.headers};
}

test("same-page body metadata is accepted; captcha, missing identity and conflicting declarations are not proofs",()=>{
  const f = fixture();
  const result = parseWechatPage(f.html,f.long,f.short);
  assert.equal(result.readingProof?.readingUrl,f.short);
  assert.equal(result.readingProof?.canonicalIdentity,f.key);
  for (const extra of [
    `var msg_link = "https://mp.weixin.qq.com/s/another";`,
    `var __biz = "OTg3NjU0";`, `var appmsgid = "999999";`, `var mid = "999999";`,
  ]) {
    const bad = f.html.replace("</script>",extra+"</script>");
    const parsed = parseWechatPage(bad,f.long,f.short);
    assert.equal(parsed.readingProof,undefined,extra);
    assert.equal(parsed.bodyText,result.bodyText);
  }
  for (const bad of [f.html.replace(/var sn = [^;]+;/,""),f.html.replace(`content="${f.short}"`,'content="https://mp.weixin.qq.com/s/other"'),
    f.html.replace('var idx = 1;','var idx = 2;')]) assert.equal(parseWechatPage(bad,f.long,f.short).readingProof,undefined);
  assert.throws(()=>parseWechatPage('<h1>验证码</h1>',f.long,f.short),/body unavailable/);
  assert.throws(()=>parseWechatPage(f.html.replace('<p>已保留的真实正文。</p>','跳转微信打开'),f.long,f.short),/no usable body/);
  assert.ok(parseWechatPage(f.html.replace('<p>已保留的真实正文。</p>','<img src="https://mmbiz.qpic.cn/example">'),f.long,f.short).readingProof);
});

test("operator preview does not persist; repeat apply preserves first evidence and every raw article field",async()=>{
  const f = fixture(), a = await article(f);
  const [before] = await sql`SELECT row_to_json(a) AS value FROM articles a WHERE id=${a.articleId}`;
  const preview = await register(f,a.articleId,false);
  assert.equal(preview.mode,"dry-run");
  assert.equal((await sql`SELECT 1 FROM wechat_reading_links WHERE identity_key=${f.key}`).length,0);
  const first = await register(f,a.articleId);
  const again = await associateWechatReadingEvidence({articleId:a.articleId,observation:{...f.observation,observedAt:"2026-10-31T04:48:00.000Z"},operator:"second-attestation",apply:true});
  assert.equal(again.evidenceHash,first.evidenceHash);
  assert.equal(again.observedAt,first.observedAt);
  assert.equal(again.createdAt,first.createdAt);
  const [after] = await sql`SELECT row_to_json(a) AS value FROM articles a WHERE id=${a.articleId}`;
  assert.deepEqual(after!.value,before!.value);
  const other = fixture();
  await assert.rejects(associateWechatReadingEvidence({articleId:a.articleId,observation:other.observation,operator:"wrong",apply:true}),/identity/);
  const alternate = {...f.observation,pageUrl:other.short,msgLink:other.short,ogUrl:other.short};
  await assert.rejects(associateWechatReadingEvidence({articleId:a.articleId,observation:alternate,operator:"replace",apply:true}),/Conflicting/);
  const forged = structuredClone(attestWechatReadingLink(f.observation,f.long,"fixture"));
  await assert.rejects(sql.begin(tx=>resolveWechatMaterialIdentity(tx,f.long,f.key,forged)),/Untrusted/);
});

test("long-first, short-first and concurrent ingestion keep one article and the existing docId",async()=>{
  for (const shortFirst of [false,true]) {
    const f = fixture(), firstUrl = shortFirst ? f.short : f.long;
    const first = await article(f,firstUrl);
    const initialIdentity = identityKeyForUrl(firstUrl)!;
    const initialDoc = await readArticle(sql,documentId(initialIdentity));
    const second = await article(f,shortFirst ? f.long : f.short,true);
    assert.equal(second.articleId,first.articleId); assert.equal(second.created,false);
    const [saved] = await sql`SELECT identity_key,url FROM articles WHERE id=${first.articleId}`;
    assert.equal(saved!.identity_key,initialIdentity); assert.equal(saved!.url,firstUrl);
    for (const url of [f.short,f.long]) assert.equal((await resolveArticle(sql,url))?.id,initialDoc!.id);
  }
  for (const order of [false,true]) {
    const f = fixture();
    const operations = [()=>article(f,f.long),()=>article(f,f.short,true)];
    if (order) operations.reverse();
    const [one,two] = await Promise.all(operations.map(fn=>fn()));
    assert.equal(one!.articleId,two!.articleId);
    assert.equal((await sql`SELECT id FROM articles WHERE identity_key IN ${sql([f.key,identityKeyForUrl(f.short)!])}`).length,1);
  }
});

test("material-only registration and promotion retain the short owner's identity; conflicting prior owners are refused",async()=>{
  const f = fixture(), run = `reading-run-${tag()}`, key = identityKeyForUrl(f.short)!;
  await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,scope) VALUES(${run},'Reading fixture',${run},'2026-01-01','2026-01-02','history')`;
  await sql`INSERT INTO backfill_items(run_id,identity_key,material,content_hash,evidence,state)
    VALUES(${run},${key},${sql.json({sourceId:source,url:f.short,title:"材料",bodyText:"已存材料",publishedAt:"2026-01-01T00:00:00Z"})},'fixture','fixture','filtered')`;
  const before = await readArticle(sql,documentId(key));
  assert.equal(before?.origin,"material");
  await associateWechatReadingEvidence({identityKey:key,observation:f.observation,operator:"material-fixture",apply:true});
  assert.equal((await resolveArticle(sql,f.long))?.id,before!.id);
  const promoted = await article(f,f.long,true);
  const after = await resolveArticle(sql,f.short);
  assert.equal(after?.id,before!.id); assert.equal(after?.articleId,promoted.articleId);
  assert.equal(after?.origin,"article");
  await assert.rejects(sql.begin(tx=>assertWechatFrozenIdentity(tx,f.long,f.key)),/Frozen manifest/);
  const conflict = fixture(), a = await article(conflict), b = await article(conflict,conflict.short);
  await assert.rejects(register(conflict,a.articleId),/different owners/);
  assert.equal((await sql`SELECT 1 FROM wechat_reading_links WHERE canonical_identity=${conflict.key}`).length,0);
  assert.equal((await sql`SELECT 1 FROM articles WHERE id IN ${sql([a.articleId,b.articleId])}`).length,2);
});

test("frozen batch identity checks refuse a contended key instead of waiting",async()=>{
  const f = fixture();
  await sql.begin(async held=>{
    await held`SELECT pg_advisory_xact_lock(hashtextextended(${'wechat-identity:'+f.key},0))`;
    await assert.rejects(sql.begin(tx=>assertWechatFrozenIdentity(tx,f.long,f.key)),/writer is active/);
  });
});

test("v1 retains its JSON shape while v2 resolves both URLs and exposes original plus verified reading URL",async()=>{
  const f = fixture(), a = await article(f);
  const path = `/articles/${a.articleId}`;
  const before = JSON.parse((await get('/api/private/v1'+path)).text);
  const missing = JSON.parse((await get('/api/private/v2'+path)).text);
  assert.equal(missing.readingUrl,null);
  await register(f,a.articleId);
  for (const version of [1,2]) for (const url of [f.long,f.short]) {
    const response = await get(`/api/private/v${version}/articles/resolve?url=${encodeURIComponent(url)}`);
    assert.equal(response.status,200); assert.equal(response.headers.get('cache-control'),'no-store');
    const item = JSON.parse(response.text);
    assert.equal(item.id,before.id); assert.equal(item.url,f.long);
    if (version===1) {assert.deepEqual(Object.keys(item).sort(),Object.keys(before).sort());assert.equal('readingUrl' in item,false);}
    else assert.equal(item.readingUrl,f.short);
  }
  const markdown = await get('/api/private/v2'+path+'?format=markdown');
  assert.ok(markdown.text.includes(`原文: ${f.short}`)); assert.ok(markdown.text.includes(`采集地址: ${f.long}`));
  for (const version of [1,2]) {
    assert.equal((await get(`/api/private/v${version}${path}`,null)).status,401);
    assert.equal((await get(`/api/private/v${version}${path}`,'wrong')).status,401);
    const schema = JSON.parse((await get(`/api/private/v${version}/openapi.json`)).text);
    assert.equal(schema.components.schemas.Summary.required.includes('readingUrl'),version===2);
  }
  await sql`INSERT INTO editorial_overrides(article_id,fields,visibility) VALUES(${a.articleId},'{}','summary-only')`;
  const restricted = JSON.parse((await get('/api/private/v2'+path)).text);
  assert.equal(restricted.body,null); assert.equal(restricted.bodyStatus,'restricted');
  await sql`UPDATE editorial_overrides SET visibility='withdrawn' WHERE article_id=${a.articleId}`;
  for (const version of [1,2]) assert.equal((await get(`/api/private/v${version}/articles/resolve?url=${encodeURIComponent(f.short)}`)).status,404);
});

test("public detail, exports, RSS, groups, stories, reports and new ledger snapshots prefer the verified URL",async()=>{
  const f = fixture(), a = await article(f);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES(${a.articleId},1,'rule','pass','ai-models','阅读链接验收','摘要','理由',90,true)`;
  const [story] = await sql`INSERT INTO stories(public_id,title,first_report_at,latest_at) VALUES(${randomUUID()},'阅读事件',now(),now()) RETURNING id,public_id`;
  const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${'reading-'+tag()},${story!.id},'事实') RETURNING id,public_id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${a.articleId},'report')`;
  await publishArticle(a.articleId,{releasedAt:new Date(Date.now()-60_000)});
  const [old] = await sql`SELECT seq,payload FROM selected_ledger WHERE article_id=${a.articleId} ORDER BY seq DESC LIMIT 1`;
  // Other test files intentionally leave future release gates. Advance only the
  // ledger read clock; do not alter their rows or the production HTTP clock.
  const ledgerNow = new Date("2200-01-01T00:00:00Z");
  const snapshot = await selectedSnapshot({fields:"default",limit:1000,page:null},ledgerNow);
  const reportKey = '2098-12-30';
  const reportContent = {sections:[{label:'测试',items:[{itemId:a.articleId,title:'阅读链接验收',summary:'摘要',sourceName:'原来源',sourceUrl:f.long}]}],flashes:[]};
  await sql`INSERT INTO reports(kind,key,window_start,window_end,generated_at,content)
    VALUES('daily',${reportKey},now()-interval '1 day',now(),now(),${sql.json(reportContent)})
    ON CONFLICT(kind,key) DO UPDATE SET content=EXCLUDED.content`;
  await register(f,a.articleId);
  for (const path of [`/api/site/items/${a.articleId}`,`/items/${a.articleId}/markdown`,'/api/v1/items?mode=selected',
    '/feed.xml','/feed/full.xml','/feed/all.xml']) {
    const response = await get(path);
    assert.equal(response.status,200,path);assert.ok(response.text.includes(f.short),path);
  }
  const group = await loadGroupReports({factPublicId:fact!.public_id,channel:'all',category:null,tag:null,topicTags:null,cursor:null,take:20,revision:null});
  assert.ok(group.kind==='ok' && group.body.reports.some(r=>r.originalUrl===f.short));
  assert.equal((await v1Story(story!.id))!.story.reports.find(r=>r.id===a.articleId)!.links.original,f.short);
  assert.equal((await loadReport('daily',reportKey))!.sections[0]!.items[0]!.sourceUrl,f.short);
  assert.equal((await v1Daily(reportKey))!.report.sections[0]!.items[0]!.links.original,f.short);
  const [frozen] = await sql`SELECT content FROM reports WHERE kind='daily' AND key=${reportKey}`;
  assert.deepEqual(frozen!.content,reportContent);
  const [latest] = await sql`SELECT seq,payload FROM selected_ledger WHERE article_id=${a.articleId} ORDER BY seq DESC LIMIT 1`;
  assert.ok(latest!.seq>old!.seq);assert.equal(latest!.payload.links.original,f.short);
  assert.equal((await sql`SELECT payload FROM selected_ledger WHERE seq=${old!.seq}`)[0]!.payload.links.original,f.long);
  const changesResponse = await get(`/api/v1/selected/changes?cursor=${encodeURIComponent(snapshot.cursor)}&limit=100`);
  assert.equal(changesResponse.status,200);
  const changes = await selectedChanges({cursor:snapshot.cursor,limit:100},ledgerNow);
  assert.ok(changes.changes.some((c:any)=>c.item?.id===a.articleId && c.item.links.original===f.short));
  await publishArticle(a.articleId);
  await sql`UPDATE publications SET source_label='旧来源' WHERE article_id=${a.articleId}`;
  await repairSourceLabel(a.articleId);
  assert.equal((await sql`SELECT payload FROM selected_ledger WHERE article_id=${a.articleId} ORDER BY seq DESC LIMIT 1`)[0]!.payload.links.original,f.short);
  assert.equal((await sql`SELECT url FROM articles WHERE id=${a.articleId}`)[0]!.url,f.long);
  assert.equal((await sql`SELECT url FROM publications WHERE article_id=${a.articleId}`)[0]!.url,f.long);
  await sql`DELETE FROM reports WHERE kind='daily' AND key=${reportKey}`;
});

test("a collected fragment keeps its identity and denied fragment takes precedence over parent alias",async()=>{
  const f = fixture(), parent = await article(f);
  const url = f.short+'#section', key = identityKeyForUrl(url,{keepFragment:true})!;
  const section = {sourceId:source,url,identityKey:key,title:"独立章节",bodyText:"章节原文",bodyStatus:"ok" as const,via:"fetch" as const};
  const first = await upsertMaterial(section), id = first.articleId;
  const [parentBefore] = await sql`SELECT * FROM articles WHERE id=${parent.articleId}`;
  await register(f,parent.articleId);
  const updated = await upsertMaterial({...section,title:"章节修订",bodyText:"章节新正文"});
  assert.equal(updated.articleId,id);
  assert.deepEqual((await sql`SELECT * FROM articles WHERE id=${parent.articleId}`)[0],parentBefore);
  assert.equal((await sql`SELECT body_text FROM articles WHERE id=${id}`)[0]!.body_text,"章节新正文");
  for (const version of [1,2]) {
    const r = await get(`/api/private/v${version}/articles/resolve?url=${encodeURIComponent(url)}`);
    assert.equal(r.status,200);assert.equal(JSON.parse(r.text).id,documentId(key));
  }
  await sql`INSERT INTO editorial_overrides(article_id,fields,visibility) VALUES(${id},'{}','withdrawn')`;
  for (const version of [1,2]) {
    assert.equal((await get(`/api/private/v${version}/articles/resolve?url=${encodeURIComponent(url)}`)).status,404);
    assert.equal((await get(`/api/private/v${version}/articles/resolve?url=${encodeURIComponent(f.short)}`)).status,200);
  }
});

test("publication waiting for link registration cannot restore a stale original URL in the ledger",async()=>{
  const f=fixture(), a=await article(f);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${a.articleId},1,'rule','pass','ai-models','并发发布','摘要',90,true)`;
  await publishArticle(a.articleId,{releasedAt:new Date(Date.now()-60_000)});
  let release!:()=>void, ready!:()=>void;
  const held=new Promise<void>(r=>release=r), registered=new Promise<void>(r=>ready=r);
  const registration=sql.begin(async tx=>{
    await resolveWechatMaterialIdentity(tx as any,f.long,f.key,attestWechatReadingLink(f.observation,f.long,"concurrency-test"));
    ready();await held;
  });
  await registered;
  let publisherPid=0;
  const publishing=sql.begin(async tx=>{
    publisherPid=Number((await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    return publishArticleTx(tx as any,a.articleId);
  });
  try {
    let blocked=false;
    for(let n=0;n<200;n++){
      if(publisherPid) blocked=Boolean((await sql`SELECT 1 FROM pg_stat_activity WHERE pid=${publisherPid} AND wait_event_type='Lock'`)[0]);
      if(blocked)break;
      await new Promise(r=>setTimeout(r,10));
    }
    assert.ok(blocked,"publisher must actually wait for registration's row lock");
  } finally {release();await registration;await publishing;}
  const [latest]=await sql`SELECT payload FROM selected_ledger WHERE article_id=${a.articleId} ORDER BY seq DESC LIMIT 1`;
  assert.equal(latest!.payload.links.original,f.short);
});

test("full RSS and repaired aliases need no additional fetch; necessary body fetch and retry capture links",async()=>{
  const f = fixture(), g = fixture(), h = fixture(), account = `reading-feed-${tag()}`;
  const original = getGlobalDispatcher(), mock = new MockAgent();
  const before = {allow:config.allowPrivateNetworkFetch,proxy:config.egressProxyUrl,base:process.env.WECHAT2RSS_BASE_URL,token:process.env.WECHAT2RSS_RSS_TOKEN};
  let active = f, full = true, url = f.long, upstream = 0;
  const server = http.createServer((_req,res)=>{
    const body = full ? '<p>RSS完整正文。</p>' : '<p>跳转微信打开</p>';
    res.end(`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>阅读-${active.identity.mid}</title><link>${url.replaceAll('&','&amp;')}</link><pubDate>${new Date().toUTCString()}</pubDate><content:encoded><![CDATA[${body}]]></content:encoded></item></channel></rss>`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  mock.disableNetConnect();mock.enableNetConnect(host=>host.startsWith('127.0.0.1:'));setGlobalDispatcher(mock);
  config.allowPrivateNetworkFetch=true;config.egressProxyUrl=null;
  process.env.WECHAT2RSS_BASE_URL=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  process.env.WECHAT2RSS_RSS_TOKEN='reading-feed-fixture';
  for (const page of [g,h]) mock.get('https://mp.weixin.qq.com').intercept({path:new URL(page.long).pathname+new URL(page.long).search})
    .reply(200,()=>{upstream++;return page.html;});
  try {
    await sql`INSERT INTO sources(id,name,kind,config) VALUES(${account},'阅读采集','mp_account',${sql.json({provider:'wechat2rss',bizId:'123456',feedId:'fixture'})})`;
    assert.equal((await checkWechat2Rss(account,'manual')).status,'ok');assert.equal(upstream,0);
    const [stored] = await sql`SELECT id,revision,body_text,body_html FROM articles WHERE identity_key=${f.key}`;
    assert.equal(stored!.body_text,'RSS完整正文。');
    await register(f,stored!.id);
    full=false;url=f.short;
    assert.equal((await checkWechat2Rss(account,'manual')).status,'ok');assert.equal(upstream,0);
    assert.deepEqual((await sql`SELECT id,revision,body_text,body_html FROM articles WHERE identity_key=${f.key}`)[0],stored);
    active=g;url=g.long;
    assert.equal((await checkWechat2Rss(account,'manual')).status,'ok');assert.equal(upstream,1);
    assert.equal((await sql`SELECT reading_url FROM wechat_reading_links WHERE canonical_identity=${g.key}`)[0]!.reading_url,g.short);
    const pending = await upsertMaterial({sourceId:account,url:h.long,title:'等待恢复',bodyText:'跳转微信打开',bodyStatus:'unconfirmed',via:'fetch'});
    assert.equal((await retryWechatBody(account,pending.articleId)).status,'repaired');assert.equal(upstream,2);
    assert.equal((await sql`SELECT reading_url FROM wechat_reading_links WHERE canonical_identity=${h.key}`)[0]!.reading_url,h.short);
    assert.equal((await retryWechatBody(account,pending.articleId)).status,'already_ready');assert.equal(upstream,2);
    mock.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(original);config.allowPrivateNetworkFetch=before.allow;config.egressProxyUrl=before.proxy;
    if(before.base===undefined)delete process.env.WECHAT2RSS_BASE_URL;else process.env.WECHAT2RSS_BASE_URL=before.base;
    if(before.token===undefined)delete process.env.WECHAT2RSS_RSS_TOKEN;else process.env.WECHAT2RSS_RSS_TOKEN=before.token;
    await mock.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test("link-only ledger refresh preserves the selected release gate",async()=>{
  const f = fixture(), a = await article(f), release = new Date(Date.now()+3600_000);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${a.articleId},1,'rule','pass','ai-models','待发布','摘要',90,true)`;
  await publishArticle(a.articleId,{releasedAt:release});
  try {
    await register(f,a.articleId);
    const [latest] = await sql`SELECT visible_at,payload FROM selected_ledger WHERE article_id=${a.articleId} ORDER BY seq DESC LIMIT 1`;
    assert.equal(latest!.visible_at.getTime(),release.getTime());assert.equal(latest!.payload.links.original,f.short);
    const [p] = await sql`SELECT visible_after FROM publications WHERE article_id=${a.articleId}`;
    assert.equal(p!.visible_after.getTime(),release.getTime());
  } finally {
    // This isolated fixture must not hold subsequent files' global selected watermark.
    await sql`UPDATE selected_ledger SET visible_at=now() WHERE article_id=${a.articleId}`;
    await sql`UPDATE publications SET visible_after=now() WHERE article_id=${a.articleId}`;
  }
});
