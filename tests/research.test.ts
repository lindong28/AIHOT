import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,readFile,writeFile,stat,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { documentId } from "@aihot/backend/research/read";
import { buildResearchBatch } from "@aihot/backend/research/index";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { materialHash } from "@aihot/backend/backfill/manifest";
import { importHistory,storePreparation } from "@aihot/backend/backfill/history-input";
import { buildApp } from "../apps/api/src/app.ts";

const token = `research-fixture-${tag()}`, digest = createHash("sha256").update(token).digest("hex");
const source = `research-${tag()}`, author = `研究账号-${tag()}`, run = `research-run-${tag()}`;
const app = await buildApp();
let base: string;
before(async()=>{
  await sql`INSERT INTO sources(id,name,kind) VALUES(${source},${author},'mp_account')`;
  for (const id of ["archive-radar-wx-mp2rss","archive-radar-wx-wechat2rss"]) await sql`INSERT INTO sources(id,name,kind) VALUES(${id},${id},'rss') ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,scope) VALUES(${run},'Research fixture',${run},'2026-01-01','2026-01-31','history')`;
  base = await app.listen({port:0,host:"127.0.0.1"});
  process.env.RESEARCH_TOKEN_SHA256 = digest;
});
after(async()=>{await app.close();await closeDb();delete process.env.RESEARCH_TOKEN_SHA256;});
async function get(path:string, auth:string|null=token) {
  const response = await fetch(`${base}/api/private/v1${path}`,{headers:auth?{Authorization:`Bearer ${auth}`}:{}});
  assert.equal(response.headers.get("cache-control"),"no-store");
  return {status:response.status,data:await response.json() as any};
}
async function article(opts:{source?:string;author?:string;body?:string|null;url?:string;date?:string;title?:string}={}) {
  const id = tag(),url=opts.url??`https://mp.weixin.qq.com/s?__biz=fixture&mid=${id}&idx=1&sn=fixture`,key=identityKeyForUrl(url)!;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,author,published_at,discovered_at,timeline_at,body_text,content_hash)
    VALUES(${id},${opts.source??source},${key},${url},${opts.title??"研究标题"},${opts.author??author},${opts.date??"2026-01-03T00:00:00.123456Z"},now(),now(),${opts.body===undefined?"研究原文":opts.body},${id})`;
  return {id,key,doc:documentId(key),url};
}
async function material(opts:{url?:string;body?:string;reason?:string;source?:string}={}) {
  const url=opts.url??`https://mp.weixin.qq.com/s?__biz=fixture&mid=${tag()}&idx=1&sn=fixture`;
  const m={sourceId:opts.source??"archive-radar-wx-wechat2rss",url,title:"历史资料",author,publishedAt:"2026-01-02T00:00:00Z",bodyText:opts.body??"仅材料保留正文"};
  const key=identityKeyForUrl(url)!;
  await sql`INSERT INTO backfill_items(run_id,identity_key,material,content_hash,evidence,state,reason)
    VALUES(${run},${key},${sql.json(m)},${materialHash(m)},'No completeness assessment','filtered',${opts.reason??"prefilter_block"})`;
  return {key,doc:documentId(key),url,m};
}
test("auth precedes validation, disabled/revoked/admin token cannot read, and builder is resumable",async()=>{
  assert.equal((await get("/articles?limit=bad",null)).status,401);
  assert.equal((await get("/articles","wrong-token")).status,401);
  assert.equal((await get("/articles",process.env.SESSION_SECRET!)).status,401);
  delete process.env.RESEARCH_TOKEN_SHA256;
  assert.equal((await get("/articles")).status,404);
  process.env.RESEARCH_TOKEN_SHA256 = "malformed";
  assert.equal((await get("/articles")).status,404);
  process.env.RESEARCH_TOKEN_SHA256 = digest;
  await sql`UPDATE research_index_state SET articles_complete=false,materials_complete=false,article_cursor=NULL,material_cursor=NULL`;
  assert.equal((await get("/articles")).data.error,"index_not_ready");
  const a=await article();
  await sql`DELETE FROM research_documents WHERE identity_key=${a.key}`;
  for(let i=0;i<1000;i++) {if((await buildResearchBatch(1)).done) break;if(i===999) assert.fail("builder failed to finish");}
  assert.equal((await get(`/articles/${a.doc}`)).status,200);
  const rotated=`new-${token}`;
  process.env.RESEARCH_TOKEN_SHA256=createHash("sha256").update(rotated).digest("hex");
  assert.equal((await get(`/articles/${a.doc}`)).status,401);
  assert.equal((await get(`/articles/${a.doc}`,rotated)).status,200);
  process.env.RESEARCH_TOKEN_SHA256=digest;
});
test("HTTP source → pages → full body covers native, both archives and raw-only without duplicates",async()=>{
  const native=await article(), mp=await article({source:"archive-radar-wx-mp2rss"}),wx=await article({source:"archive-radar-wx-wechat2rss"});
  const raw=await material();
  const unknown=await article({source:"archive-radar-wx-mp2rss",author:"unresolved-account"});
  const src=await get(`/sources?q=${encodeURIComponent(author)}`);
  assert.deepEqual(src.data.items.map((s:any)=>s.id),[source]);
  const expected = (await sql`SELECT id FROM research_documents WHERE source_id=${source}
    OR (source_id IN ('archive-radar-wx-mp2rss','archive-radar-wx-wechat2rss') AND author=${author})`).map(r=>r.id).sort();
  const ids:string[]=[];let cursor:string|null=null;
  do {
    const page=await get(`/articles?source=${source}&limit=2${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
    assert.equal(page.status,200);ids.push(...page.data.items.map((i:any)=>i.id));cursor=page.data.nextCursor;
  } while(cursor);
  assert.deepEqual(ids.sort(),expected);assert.equal(new Set(ids).size,ids.length);
  assert.ok([native.doc,mp.doc,wx.doc,raw.doc].every(id=>ids.includes(id)));assert.ok(!ids.includes(unknown.doc));
  const body=await get(`/articles/${raw.doc}`);
  assert.equal(body.data.origin,"material");assert.equal(body.data.body.text,raw.m.bodyText);assert.equal(body.data.completeness.state,"unverified");
  const resolved=await get(`/articles/resolve?url=${encodeURIComponent(raw.url+"&utm_source=agent")}`);
  assert.equal(resolved.data.id,raw.doc);
});
test("full tail search, literal terms, date boundaries, invalid filters and no silent truncation",async()=>{
  const body="正文".repeat(8000)+"独有尾部关键词 %_",a=await article({body,date:"2026-01-10T00:00:00Z"});
  const found=await get(`/articles?source=${source}&q=${encodeURIComponent("独有尾部关键词 %_")}&from=2026-01-10T00:00:00Z&to=2026-01-11T00:00:00Z`);
  assert.deepEqual(found.data.items.map((i:any)=>i.id),[a.doc]);assert.equal(found.data.items[0].matches[0].field,"body");
  const detail=await get(`/articles/${a.doc}`);assert.equal(detail.data.body.text,body);assert.equal(detail.data.body.truncated,false);
  assert.equal(detail.data.completeness.state,"unverified");
  assert.deepEqual((await get(`/articles?source=${source}&q=独有尾部关键词&to=2026-01-10T00:00:00Z`)).data.items,[]);
  for(const q of ["limit=101","limit=0","q=a+b+c+d+e+f+g","from=bad","from=2026-01-11T00:00:00Z&to=2026-01-10T00:00:00Z","unexpected=yes"])
    assert.equal((await get(`/articles?${q}`)).status,400);
  const md=await fetch(`${base}/api/private/v1/articles/${a.doc}?format=markdown`,{headers:{Authorization:`Bearer ${token}`}});
  assert.ok((await md.text()).includes(body));
});
test("withdrawal and summary-only deny body keyword, snippets, detail, URL and older material copies",async()=>{
  const a=await article({body:"绝不能外泄的正文"}),raw=await material({url:a.url,body:"旧副本秘密"});
  await sql`UPDATE backfill_items SET article_id=${a.id} WHERE run_id=${run} AND identity_key=${raw.key}`;
  await sql`INSERT INTO editorial_overrides(article_id,visibility,reason,updated_by) VALUES(${a.id},'summary-only','fixture','fixture')`;
  const restricted=await get(`/articles/${a.doc}`);
  assert.equal(restricted.data.bodyStatus,"restricted");assert.equal(restricted.data.body,null);assert.equal(restricted.data.contentHash,null);
  assert.deepEqual(restricted.data.translations,[]);
  for(const term of ["绝不能外泄的正文","旧副本秘密"]) assert.deepEqual((await get(`/articles?source=${source}&q=${term}`)).data.items,[]);
  assert.equal((await get(`/articles/resolve?url=${encodeURIComponent(a.url)}`)).data.body,null);
  await sql`UPDATE editorial_overrides SET visibility='withdrawn',updated_at=clock_timestamp() WHERE article_id=${a.id}`;
  for(const id of [a.doc,a.id]) assert.equal((await get(`/articles/${id}`)).status,404);
  assert.equal((await get(`/articles/resolve?url=${encodeURIComponent(a.url)}`)).status,404);
  assert.equal((await get(`/articles/${documentId("absent")}`)).data.error,"not_found");
  assert.ok(!(await get(`/articles?source=${source}`)).data.items.some((i:any)=>i.id===a.doc));
  const control=await article({body:"正常对照可读"});assert.equal((await get(`/articles/${control.doc}`)).data.body.text,"正常对照可读");
});
test("cursor binds filters, excludes new identities, reports revision and keeps raw promotion identity",async()=>{
  const raw=await material(),first=await get(`/articles?source=${source}&limit=1`),cursor=first.data.nextCursor;
  assert.ok(cursor);
  assert.equal((await get(`/articles?source=${source}&q=changed&cursor=${encodeURIComponent(cursor)}`)).status,400);
  assert.equal((await get(`/articles?source=${source}&cursor=${encodeURIComponent(cursor+"x")}`)).status,400);
  const later=await article({date:"2025-01-01T00:00:00Z"});
  const promoted=await article({url:raw.url,date:"2026-01-25T00:00:00Z",body:"提升后的当前原文"});
  const ids=first.data.items.map((i:any)=>i.id);let next=cursor;
  do {const page=await get(`/articles?source=${source}&limit=1&cursor=${encodeURIComponent(next)}`);
    assert.equal(page.data.changedSinceStart,true);ids.push(...page.data.items.map((i:any)=>i.id));next=page.data.nextCursor;}while(next);
  assert.ok(!ids.includes(later.doc));assert.equal(ids.filter((id:string)=>id===raw.doc).length,1);
  const after=await get(`/articles/${raw.doc}`);assert.equal(after.data.articleId,promoted.id);assert.equal(after.data.body.text,"提升后的当前原文");
  await sql`UPDATE articles SET body_text='修订原文',revision=revision+1,content_hash='changed' WHERE id=${promoted.id}`;
  assert.equal((await get(`/articles/${raw.doc}`)).data.revision,2);
  await sql`UPDATE articles SET body_text=NULL,body_html=NULL,content_discarded_at=now() WHERE id=${promoted.id}`;
  assert.equal((await get(`/articles/${raw.doc}`)).data.bodyStatus,"discarded");
  assert.deepEqual((await get(`/articles?source=${source}&q=提升后的当前原文`)).data.items,[]);
});

test("live restrictions cover linked material identities, mid-page withdrawal and explicit completeness",async()=>{
  const a=await article({body:"链接限制秘密"});
  const alias=await material({body:"别名限制秘密"});
  await sql`UPDATE backfill_items SET article_id=${a.id} WHERE run_id=${run} AND identity_key=${alias.key}`;
  const first=await get(`/articles?source=${source}&limit=1`);
  await sql`INSERT INTO editorial_overrides(article_id,visibility,reason,updated_by) VALUES(${a.id},'withdrawn','fixture','fixture')`;
  assert.equal((await get(`/articles/${alias.doc}`)).status,404);
  assert.deepEqual((await get(`/articles?source=${source}&q=别名限制秘密`)).data.items,[]);
  const next=await get(`/articles?source=${source}&cursor=${encodeURIComponent(first.data.nextCursor)}`);
  assert.equal(next.data.changedSinceStart,true);assert.ok(!next.data.items.some((r:any)=>r.id===a.doc||r.id===alias.doc));
  const m=await material();
  await sql`UPDATE backfill_items SET preparation=${sql.json(storePreparation({versions:[{approved:{state:"complete",contentHash:materialHash(m.m),evidence:"fixture approval"}}],results:{},dayBasis:"earliest_version_utc"} as any))} WHERE run_id=${run} AND identity_key=${m.key}`;
  assert.equal((await get(`/articles/${m.doc}`)).data.completeness.state,"complete");
  await sql`UPDATE backfill_items SET preparation=${sql.json(storePreparation({versions:[],results:{},dayBasis:"earliest_version_utc",selected:{key:"fixture",hash:materialHash(m.m),evidence:"not assessed"}}))} WHERE run_id=${run} AND identity_key=${m.key}`;
  assert.equal((await get(`/articles/${m.doc}`)).data.completeness.state,"unverified");
  const missing=await article({body:null});assert.equal((await get(`/articles/${missing.doc}`)).data.bodyStatus,"missing");
});

test("real history import retains filtered dataJson originals including NUL and lone surrogate; clearing leaves tombstone",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"research-history-"));
  try {
    const body="历史封装原文\u0000保留\ud800尾部特殊词",url=`https://mp.weixin.qq.com/s?__biz=fixture&mid=${tag()}&idx=1&sn=fixture`;
    const m={sourceId:"archive-radar-wx-mp2rss",url,title:"封装标题",author,publishedAt:"2026-01-02T00:00:00Z",bodyText:body,bodyHtml:"<p>完整\u0000HTML</p>"};
    const key=identityKeyForUrl(url)!,file=join(directory,"history.jsonl");
    await writeFile(file,JSON.stringify({identityKey:key,day:"2026-01-02",dayBasis:"earliest_version_utc",error:null,versions:[{key:"raw-version",day:"2026-01-02",provenance:{},prefilter:null,material:m,targetUrls:[url],context:{}}]})+"\n");
    const imported=await importHistory({file,label:"private fixture",startDay:"2026-01-01",endDay:"2026-01-31"});
    const [original]=await sql`SELECT preparation->>'dataJson' AS original FROM backfill_items WHERE run_id=${imported.id}`;
    await sql`UPDATE backfill_items SET preparation=preparation-'research' WHERE run_id=${imported.id}`;
    await sql`UPDATE research_index_state SET material_cursor=NULL,materials_complete=false`;
    for(let i=0;i<100;i++){if((await buildResearchBatch(10)).done)break;if(i===99)assert.fail("old envelope rebuild did not finish");}
    const [rebuilt]=await sql`SELECT preparation->>'dataJson' AS original FROM backfill_items WHERE run_id=${imported.id}`;
    assert.equal(rebuilt!.original,original!.original);
    await sql`UPDATE backfill_items SET state='filtered',reason='all_versions_prefilter_block',updated_at=now() WHERE run_id=${imported.id}`;
    const doc=documentId(key),detail=await get(`/articles/${doc}`);
    assert.equal(detail.status,200);assert.equal(detail.data.origin,"material");assert.equal(detail.data.body.text,body);assert.equal(detail.data.body.html,m.bodyHtml);
    assert.equal(detail.data.completeness.state,"unverified");
    assert.deepEqual((await get(`/articles?source=${source}&q=尾部特殊词`)).data.items.map((i:any)=>i.id),[doc]);
    if (process.env.AIHOT_RESEARCH_CLI) {
      const destination=join(directory,"saved.json"),env={...process.env,AIHOT_RESEARCH_URL:base,AIHOT_RESEARCH_TOKEN:token};
      await promisify(execFile)("python3",[process.env.AIHOT_RESEARCH_CLI,"--allow-localhost","read","--id",doc,"--output",destination],{env,timeout:30000});
      assert.equal(JSON.parse(await readFile(destination,"utf8")).body.text,body);
    }
    await sql`UPDATE backfill_items SET material='{}',preparation=NULL,content_discarded_at=now(),updated_at=now() WHERE run_id=${imported.id}`;
    assert.equal((await get(`/articles/${doc}`)).data.bodyStatus,"discarded");
    assert.deepEqual((await get(`/articles?source=${source}&q=尾部特殊词`)).data.items,[]);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("search verifies decoded originals and can advance through empty candidate pages",async()=>{
  const isolated=`search-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES(${isolated},${isolated},'rss')`;
  const control=await material({source:isolated,body:"真实 n 命中"});
  for(let i=0;i<3;i++) {
    const m=await material({source:isolated,body:"甲\n乙"});
    await sql`UPDATE research_documents SET sort_at='2026-01-03' WHERE identity_key=${m.key}`;
  }
  const ids:string[]=[];let cursor:string|null=null,pages=0;
  do {
    const result=await get(`/articles?source=${isolated}&q=n&limit=1${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
    assert.equal(result.status,200);
    assert.ok(result.data.items.every((i:any)=>i.matches.length>0));
    ids.push(...result.data.items.map((i:any)=>i.id));cursor=result.data.nextCursor;
    assert.ok(++pages<10,"cursor must advance even if a candidate is rejected");
  }while(cursor);
  assert.deepEqual(ids,[control.doc]);
  assert.deepEqual((await get(`/articles?source=${isolated}&q=n+不存在`)).data.items,[]);
});

test("fragment identity resolves its original section and cannot fall through withdrawn section to parent",async()=>{
  for(const fragment of ["section","功能更新"]) {
  const url=`https://example.test/changelog/${tag()}#${fragment}`,section=await article({url,body:"章节原文"});
  // web-list's Docusaurus producer stores the original URL verbatim, including Chinese fragments.
  const key=`url:${url}`;
  await sql`UPDATE articles SET identity_key=${key} WHERE id=${section.id}`;
  await article({url:url.split("#")[0],body:"父页原文"});
  const resolve=`/articles/resolve?url=${encodeURIComponent(url)}`;
  assert.equal((await get(resolve)).data.id,documentId(key));
  await sql`INSERT INTO editorial_overrides(article_id,visibility,reason,updated_by) VALUES(${section.id},'withdrawn','fixture','fixture')`;
  assert.equal((await get(resolve)).status,404);
  }
});

test("shared Python CLI uses real HTTP source → all pages → read → atomic private file",{skip:!process.env.AIHOT_RESEARCH_CLI},async()=>{
  const cli=process.env.AIHOT_RESEARCH_CLI!,dir=await mkdtemp(join(tmpdir(),"research-cli-"));
  const runCli=promisify(execFile);
  const env={...process.env,AIHOT_RESEARCH_URL:base,AIHOT_RESEARCH_TOKEN:token};
  try {
    const src=await runCli("python3",[cli,"--allow-localhost","sources","--q",author],{env,timeout:30000});
    assert.deepEqual(JSON.parse(src.stdout).items.map((r:any)=>r.id),[source]);
    const list=await runCli("python3",[cli,"--allow-localhost","search","--source",source,"--limit","2","--all"],{env,timeout:30000});
    const page=JSON.parse(list.stdout);assert.equal(page.traversalComplete,true);assert.equal(page.nextCursor,null);
    const id=page.items.find((r:any)=>r.bodyStatus==="available").id;
    const json=join(dir,"article.json"),md=join(dir,"article.md");
    await runCli("python3",[cli,"--allow-localhost","read","--id",id,"--output",json],{env,timeout:30000});
    const saved=JSON.parse(await readFile(json,"utf8"));assert.equal(saved.id,id);assert.ok(saved.body.text);
    assert.equal((await stat(json)).mode&0o777,0o600);
    await runCli("python3",[cli,"--allow-localhost","read","--url",saved.url,"--format","markdown","--output",md],{env,timeout:30000});
    assert.ok((await readFile(md,"utf8")).includes(saved.body.text));
    await assert.rejects(runCli("python3",[cli,"--allow-localhost","read","--id",id,"--output",json],{env:{...env,AIHOT_RESEARCH_TOKEN:"wrong"},timeout:30000}));
    assert.equal(JSON.parse(await readFile(json,"utf8")).id,id);
  } finally {await rm(dir,{recursive:true,force:true});}
});
