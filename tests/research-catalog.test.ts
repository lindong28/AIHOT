import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after,before,test } from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql,closeDb } from "@aihot/backend/db";
import { setGroup,setAlias } from "@aihot/backend/research/catalog";
import { documentId } from "@aihot/backend/research/read";
import { buildApp } from "../apps/api/src/app.ts";

const token=`fixture-${tag()}`,prefix=`catalog-${tag()}`,s1=`${prefix}-1`,s2=`${prefix}-2`,name=`账号-${tag()}`,group=`${prefix}-group`,empty=`${prefix}-empty`;
const alias=`唯一别名-${prefix}`,managedAlias=`脚本别名-${prefix}`;
const app=await buildApp();let base:string;
before(async()=>{
  process.env.RESEARCH_TOKEN_SHA256=createHash("sha256").update(token).digest("hex");
  await sql`INSERT INTO sources(id,name,kind) VALUES(${s1},${name},'mp_account'),(${s2},${name},'mp_account')`;
  await sql`UPDATE research_index_state SET articles_complete=true,materials_complete=true`;
  await sql.begin(async db=>{await setGroup(db,group,"测试分组",[s1,s2]);await setGroup(db,empty,"空分组",[]);await setAlias(db,s1,alias);});
  base=await app.listen({host:"127.0.0.1",port:0});
});
after(async()=>{await app.close();await closeDb();delete process.env.RESEARCH_TOKEN_SHA256;});
async function get(path:string,params:Record<string,string|string[]>={}) {
  const q=new URLSearchParams();for(const [k,v] of Object.entries(params))for(const value of Array.isArray(v)?v:[v])q.append(k,value);
  const res=await fetch(`${base}/api/private/v1${path}?${q}`,{headers:{Authorization:`Bearer ${token}`}});
  return {status:res.status,data:await res.json() as any};
}
async function article(source:string,date:string|null) {
  const id=tag(),key=`url:https://example.test/${id}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,author,published_at,discovered_at,timeline_at,body_text,content_hash)
    VALUES(${id},${source},${key},${key.slice(4)},'fixture',${name},${date}::text::timestamptz,'2026-01-05T00:00:00Z',now(),'original secret',${id})`;
  return {id,doc:documentId(key)};
}

test("catalog resolution refuses ambiguity and unknowns, ID wins; empty groups never read all",async()=>{
  assert.equal((await get("/articles",{source:name})).data.error,"ambiguous_source");
  assert.deepEqual((await get("/articles",{source:name})).data.candidates.map((x:any)=>x.id),[s1,s2]);
  assert.equal((await get("/articles",{source:"不存在"})).data.error,"unknown_source");
  assert.equal((await get("/articles",{group:"不存在"})).data.error,"unknown_group");
  assert.deepEqual((await get("/articles",{group:empty})).data.items,[]);
  assert.deepEqual((await get("/articles",{source:alias})).data.query.sourceIds,[s1]);
  await sql.begin(db=>setAlias(db,s2,s1));
  assert.deepEqual((await get("/articles",{source:s1})).data.query.sourceIds,[s1]);
  const groups=(await get("/groups")).data.items;
  assert.deepEqual(groups.find((x:any)=>x.id===group).sourceIds,[s1,s2]);
  assert.deepEqual(groups.find((x:any)=>x.id===empty).sourceIds,[]);
  const response=await fetch(`${base}/api/private/v1/groups`,{method:"POST",headers:{Authorization:`Bearer ${token}`}});
  assert.equal(response.status,404);
});

test("union query pages once, preserves microsecond ordering, binds group membership and time axis",async()=>{
  const a=await article(s1,"2026-01-02T00:00:00.000001Z"),b=await article(s2,"2026-01-02T00:00:00.000002Z"),c=await article(s1,"2026-01-03T00:00:00Z");
  const params={source:[s1,s2,s1],group,timeField:"published",from:"2026-01-02T00:00:00Z",to:"2026-01-03T00:00:00Z",limit:"1"};
  const first=await get("/articles",params);assert.equal(first.status,200);assert.deepEqual(first.data.items.map((x:any)=>x.id),[b.doc]);
  const cursor=first.data.nextCursor;assert.ok(cursor);
  const second=await get("/articles",{...params,cursor});assert.deepEqual(second.data.items.map((x:any)=>x.id),[a.doc]);assert.equal(second.data.nextCursor,null);
  assert.equal((await get("/articles",{...params,timeField:"discovered",cursor})).status,400);
  const groupFirst=await get("/articles",{group,timeField:"published",limit:"1"});
  await sql.begin(db=>setGroup(db,group,"测试分组",[s1]));
  assert.equal((await get("/articles",{group,timeField:"published",limit:"1",cursor:groupFirst.data.nextCursor})).status,400);
  await sql.begin(db=>setGroup(db,group,"测试分组",[s1,s2]));
  assert.equal((await get("/articles",{source:[s1,s2],timeField:"published"})).data.items.filter((x:any)=>x.id===c.doc).length,1);
});

test("explicit time axes handle missing publication, late discovery and updates without changing effective order",async()=>{
  const a=await article(s1,null),b=await article(s2,"2026-01-01T00:00:00Z");
  assert.ok(!(await get("/articles",{source:s1,timeField:"published"})).data.items.some((x:any)=>x.id===a.doc));
  assert.ok((await get("/articles",{source:s1,timeField:"discovered",from:"2026-01-05T00:00:00Z",to:"2026-01-06T00:00:00Z"})).data.items.some((x:any)=>x.id===a.doc));
  const before=(await get(`/articles/${b.doc}`)).data;
  await sql`UPDATE articles SET published_at='2026-02-01T00:00:00Z',body_text='revised original' WHERE id=${b.id}`;
  const changed=(await get(`/articles/${b.doc}`)).data;
  assert.equal(before.sortAt,changed.sortAt);assert.equal(before.indexedAt,changed.indexedAt);assert.ok(Date.parse(changed.updatedAt)>=Date.parse(before.updatedAt));
  const now=new Date();const start=new Date(now.getTime()-60000).toISOString();
  assert.ok((await get("/articles",{source:s2,timeField:"updated",from:start})).data.items.some((x:any)=>x.id===b.doc));
  assert.ok((await get("/articles",{source:s2,timeField:"published",from:"2026-02-01T00:00:00Z"})).data.items.some((x:any)=>x.id===b.doc));
  await sql`INSERT INTO editorial_overrides(article_id,visibility,reason,updated_by) VALUES(${b.id},'summary-only','fixture','fixture')`;
  const restricted=(await get("/articles",{source:s2,timeField:"updated"})).data.items.find((x:any)=>x.id===b.doc);
  assert.equal(restricted.bodyStatus,"restricted");assert.equal(restricted.contentHash,null);
  assert.deepEqual((await get("/articles",{source:s2,timeField:"updated",q:"revised"})).data.items,[]);
  await sql`UPDATE editorial_overrides SET visibility='withdrawn' WHERE article_id=${b.id}`;
  assert.ok(!(await get("/articles",{group,timeField:"updated"})).data.items.some((x:any)=>x.id===b.doc));
});

test("one hundred selected sources can continue through the HTTP cursor contract",async()=>{
  const ids=Array.from({length:100},(_,i)=>`${prefix}-many-${i}`);
  await sql`INSERT INTO sources ${sql(ids.map(id=>({id,name:id,kind:"mp_account"})))}`;
  const a=await article(ids[0]!,"2026-01-02T00:00:00Z"),b=await article(ids[99]!,"2026-01-03T00:00:00Z");
  const params={source:ids,timeField:"published",limit:"1"};
  const first=await get("/articles",params);assert.equal(first.status,200);
  assert.deepEqual(first.data.items.map((x:any)=>x.id),[b.doc]);assert.ok(first.data.nextCursor);
  const second=await get("/articles",{...params,cursor:first.data.nextCursor});
  assert.equal(second.status,200);assert.deepEqual(second.data.items.map((x:any)=>x.id),[a.doc]);
  assert.equal(second.data.nextCursor,null);
});

test("collection output separates no observation, empty success and failed run without raw secrets",async()=>{
  let sources=(await get("/sources",{q:s1})).data.items;
  assert.equal(sources[0].collection.latestRun,null);
  await sql`UPDATE sources SET last_error='SECRET',config='{"token":"SECRET"}',health='ok',last_ok_at=now() WHERE id=${s1}`;
  await sql`INSERT INTO fetch_runs(source_id,status,started_at,finished_at,found_count,new_count,error,detail) VALUES(${s1},'ok',now()-interval '1 minute',now(),0,0,'SECRET','{"token":"SECRET"}')`;
  sources=(await get("/sources",{q:s1})).data.items;assert.equal(sources[0].collection.latestRun.foundCount,0);assert.ok(sources[0].collection.lastSuccessAt);
  await sql`INSERT INTO fetch_runs(source_id,status,finished_at,error) VALUES(${s1},'failed',now(),'SECRET')`;
  sources=(await get("/sources",{q:s1})).data.items;assert.equal(sources[0].collection.latestRun.status,"failed");assert.equal(sources[0].collection.latestRun.foundCount,null);
  assert.ok(!JSON.stringify(sources).includes("SECRET"));assert.deepEqual(sources[0].aliases,[alias]);
});

test("trusted management CLI persists, replaces atomically, rejects unknown members and deletes",async()=>{
  const run=promisify(execFile),id=`${prefix}-managed`;
  const command=(...args:string[])=>run(process.execPath,["scripts/research-catalog.ts",...args],{timeout:15000});
  await command("set-group","--id",id,"--name","管理组","--source",s1);
  await assert.rejects(command("set-group","--id",id,"--name","管理组","--source","nonexistent"));
  assert.deepEqual((await get("/groups")).data.items.find((x:any)=>x.id===id).sourceIds,[s1]);
  await command("set-group","--id",id,"--name","管理组","--source",s2);
  assert.deepEqual((await get("/articles",{group:id})).data.query.sourceIds,[s2]);
  await command("set-alias","--source",s2,"--alias",managedAlias);
  assert.deepEqual((await get("/articles",{source:managedAlias})).data.query.sourceIds,[s2]);
  await command("delete-alias","--source",s2,"--alias",managedAlias);
  assert.equal((await get("/articles",{source:managedAlias})).status,400);
  await command("delete-group","--id",id);assert.equal((await get("/articles",{group:id})).status,400);
});

test("shared CLI queries groups and exports real API bodies with offline comparison",{skip:!process.env.AIHOT_RESEARCH_CLI},async()=>{
  const cli=process.env.AIHOT_RESEARCH_CLI!,directory=await mkdtemp(join(tmpdir(),"research-catalog-cli-"));
  const run=promisify(execFile),env={...process.env,AIHOT_RESEARCH_URL:base,AIHOT_RESEARCH_TOKEN:token,NO_PROXY:"127.0.0.1,localhost"};
  async function command(...args:string[]) {
    try { return await run("python3",[cli,"--allow-localhost",...args],{env,timeout:30000}); }
    catch(error) {if ((error as any).code===3)return error as any;throw error;}
  }
  try {
    const groups=JSON.parse((await command("groups")).stdout);assert.ok(groups.items.some((x:any)=>x.id===group));
    const list=JSON.parse((await command("search","--source",alias,"--group",empty,"--time-field","published","--since","2026-01-01","--until","2026-01-04","--timezone","UTC","--all")).stdout);
    assert.deepEqual(list.query.sourceIds,[s1]);assert.equal(list.traversalComplete,true);assert.ok(list.items.length>0);
    const output=join(directory,"export");
    await command("export","--source",alias,"--time-field","published","--since","2026-01-01","--until","2026-01-04","--timezone","UTC","--output",output);
    const manifestPath=join(output,"manifest.json"),manifest=JSON.parse(await readFile(manifestPath,"utf8"));
    assert.equal(manifest.exportComplete,true);assert.ok(manifest.items.length>0);
    for(const item of manifest.items) {
      const doc=JSON.parse(await readFile(join(output,item.id+".json"),"utf8"));
      const api=(await get(`/articles/${item.id}`)).data;
      assert.equal(doc.body.text,api.body.text);assert.equal(doc.url,api.url);assert.equal(doc.id,api.id);
    }
    const comparison=JSON.parse((await command("compare",manifestPath,manifestPath)).stdout);
    assert.deepEqual(comparison.added,[]);assert.deepEqual(comparison.changed,[]);assert.deepEqual(comparison.notPresentInSecond,[]);
  } finally {await rm(directory,{recursive:true,force:true});}
});
