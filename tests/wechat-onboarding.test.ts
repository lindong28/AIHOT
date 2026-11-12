import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { sql, closeDb } from "@aihot/backend/db";
import { prepare, configureAccount, readReceipt, type Account } from "../deploy/wechat2rss/onboard-source.ts";
import { applyAccount, accountStatus } from "../deploy/wechat2rss/source-registration.ts";

const run = promisify(execFile);
const T = tag();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-"));
const target = { name: "接入测试", bizId: "999001" };
const id = `radar-mp-${target.bizId}`;
const receipt = path.join(dir, "receipt.json");
const sourcesFile = path.join(dir, "sources.json");
const envFile = path.join(dir, "service.env");
const rows: { id: number; name: string; link: string; paused?: boolean }[] = [];
let adds = 0;
let mode = "ok";
const server = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://fixture");
  assert.equal(url.searchParams.get("k"), "fixture-secret");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/list") {
    if (mode === "list-fail") { res.writeHead(503); res.end("fixture-secret"); return; }
    const page = Number(url.searchParams.get("page"));
    res.end(JSON.stringify({ err: "", data: rows.slice(page - 1, page), meta: { total: rows.length } }));
  } else if (url.pathname === `/add/${target.bizId}`) {
    adds++;
    if (mode !== "lost-before") rows.push({ id: Number(target.bizId), name: target.name, link: "http://127.0.0.1/feed/onboard-fixture.xml?k=fixture-secret" });
    if (mode.startsWith("lost-")) { req.socket.destroy(); return; }
    res.end(JSON.stringify({ err: "", data: "http://127.0.0.1/feed/onboard-fixture.xml?k=fixture-secret" }));
  } else { res.writeHead(404); res.end("{}"); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.WECHAT2RSS_BASE_URL = base;
process.env.WECHAT2RSS_RSS_TOKEN = "fixture-secret";
fs.writeFileSync(envFile, "RSS_TOKEN=fixture-secret\n");
after(async () => {
  await sql`DELETE FROM articles WHERE source_id=${id}`;
  await sql`DELETE FROM sources WHERE id=${id} OR id=${`collision-${T}`} OR id='radar-mp-999002'`;
  await closeDb();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("single-account CLI resumes subscription/config/database stages and reports pending, zero-new and ingested separately", async () => {
  rows.push({ id: 123, name: "无关账号", link: "http://127.0.0.1/feed/unrelated.xml", paused: true });
  fs.writeFileSync(sourcesFile, JSON.stringify({ sources: [{ id: "unrelated-missing", kind: "mp_account", config: { provider: "wechat2rss" }, enabled: true }] }, null, 2));
  const args = ["deploy/wechat2rss/onboard-source.ts", "prepare", "--name", target.name, "--biz-id", target.bizId, "--base", base, "--service-env", envFile, "--sources", sourcesFile, "--receipt", receipt, "--json"];
  await assert.rejects(run(process.execPath, args), (e: any) => e.code === 1 && e.stderr.includes("--add-missing"));
  assert.equal(adds, 0);
  const prepared = JSON.parse((await run(process.execPath, [...args, "--add-missing"])).stdout);
  assert.equal(prepared.result.feedId, "onboard-fixture");
  assert.equal(adds, 1);
  assert.ok(!fs.readFileSync(receipt, "utf8").includes("fixture-secret"));
  rows[1]!.paused = true;
  await run(process.execPath, [...args, "--add-missing"]);
  assert.equal(adds, 1);
  assert.equal(readReceipt(receipt)!.paused, true);
  const configured = await configureAccount(sourcesFile, readReceipt(receipt)!);
  assert.equal(configured.inserted, true);
  const saved = fs.readFileSync(sourcesFile, "utf8");
  assert.equal((await configureAccount(sourcesFile, readReceipt(receipt)!)).inserted, false);
  assert.equal(fs.readFileSync(sourcesFile, "utf8"), saved);
  const pack = JSON.parse(saved).sources as Account[];
  const source = pack[1]!;
  assert.equal(source.interval_minutes, 15);
  assert.equal(source.site_fulltext, true);
  assert.equal(source.syndicate_fulltext, false);
  const common = ["--name", target.name, "--biz-id", target.bizId, "--base", base, "--service-env", envFile, "--sources", sourcesFile];
  const cliConfig = JSON.parse((await run(process.execPath, ["deploy/wechat2rss/onboard-source.ts", "config", ...common, "--receipt", receipt, "--json"])).stdout);
  assert.equal(cliConfig.result.inserted, false);
  const applied = JSON.parse((await run(process.execPath, ["deploy/wechat2rss/onboard-source.ts", "apply", ...common, "--json"])).stdout).result;
  assert.equal(applied.inserted, true);
  assert.equal(applied.upstream_paused, true);
  assert.equal((await sql`SELECT id FROM sources WHERE id='unrelated-missing'`).length, 0);
  assert.equal((await accountStatus(pack, target, base, "fixture-secret")).database["collection"], "pending");
  await sql`UPDATE sources SET enabled=false,cursor='{"initializedAt":"2026-11-01"}', next_fetch_at='2100-01-01' WHERE id=${id}`;
  const before = await sql`SELECT * FROM sources WHERE id=${id}`;
  assert.equal((await applyAccount(pack, target, base, "fixture-secret")).inserted, false);
  assert.deepEqual(await sql`SELECT * FROM sources WHERE id=${id}`, before);
  assert.equal((await accountStatus(pack, target, base, "fixture-secret")).database["collection"], "paused");
  await sql`UPDATE sources SET enabled=true WHERE id=${id}`;
  await sql`INSERT INTO fetch_runs(source_id,status,finished_at,found_count,new_count) VALUES(${id},'ok',now(),0,0)`;
  assert.equal((await accountStatus(pack, target, base, "fixture-secret")).database["collection"], "ok_zero_new");
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES(${`onboard-${T}`},${id},${`onboard-${T}`},'https://example.test','测试',now(),now())`;
  await sql`INSERT INTO fetch_runs(source_id,status,finished_at,found_count,new_count) VALUES(${id},'ok',now(),1,1)`;
  const status = await accountStatus(pack, target, base, "fixture-secret");
  assert.equal(status.database["collection"], "ingested");
  assert.equal(status.database["stored_articles"], 1);
  assert.equal(status.database["selected_public_articles"], 0);
  const human = await run(process.execPath, ["deploy/wechat2rss/onboard-source.ts", "status", ...common]);
  assert.match(human.stdout, /已入库 1 篇；公开精选 0 篇/);
  mode = "list-fail";
  await assert.rejects(run(process.execPath, ["deploy/wechat2rss/onboard-source.ts", "status", ...common, "--json"]), (error: any) => error.code === 2 && JSON.parse(error.stdout).result.database.stored_articles === 1);
  const partial = await accountStatus(pack, target, base, "fixture-secret");
  assert.equal(partial.upstream["state"], "unverified");
  assert.equal(partial.database["stored_articles"], 1);
  assert.ok(!JSON.stringify(partial).includes("fixture-secret"));
  mode = "ok";
});

test("response loss is resolved by list, or retained as unknown without another add", async () => {
  rows.splice(1); adds = 0;
  mode = "lost-after";
  const resumed = await prepare(target, base, "fixture-secret", path.join(dir, "lost-after.json"), true);
  assert.equal(resumed.feedId, "onboard-fixture");
  assert.equal(adds, 1);
  rows.splice(1); adds = 0;
  mode = "lost-before";
  const unknown = path.join(dir, "lost-before.json");
  await assert.rejects(prepare(target, base, "fixture-secret", unknown, true), /添加结果未知/);
  await assert.rejects(prepare(target, base, "fixture-secret", unknown, true), /未重发/);
  assert.equal(adds, 1);
  assert.equal(readReceipt(unknown)!.phase, "add_pending");
  rows.push({ id: Number(target.bizId), name: target.name, link: "http://127.0.0.1/feed/onboard-fixture.xml" });
  assert.equal((await prepare(target, base, "fixture-secret", unknown, true)).phase, "subscribed");
  assert.equal(adds, 1);
  mode = "ok";
});

test("identity conflicts and incomplete pages stop before writes; same receipt is exclusive", async () => {
  const pack = JSON.parse(fs.readFileSync(sourcesFile, "utf8")).sources;
  rows[1]!.name = "另一个名字";
  const previous = adds;
  await assert.rejects(prepare(target, base, "fixture-secret", receipt, true), /身份/);
  await assert.rejects(applyAccount(pack, target, base, "fixture-secret"), /身份/);
  assert.equal(adds, previous);
  rows[1]!.name = target.name;
  await sql`UPDATE sources SET config=jsonb_set(config,'{feedId}','"wrong"') WHERE id=${id}`;
  await assert.rejects(applyAccount(pack, target, base, "fixture-secret"), /冲突/);
  await sql`UPDATE sources SET config=jsonb_set(config,'{feedId}','"onboard-fixture"') WHERE id=${id}`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${`collision-${T}`},${target.name},'mp_account',${sql.json({provider:"wechat2rss",bizId:target.bizId,feedId:"onboard-fixture"})})`;
  await assert.rejects(applyAccount(pack, target, base, "fixture-secret"), /重复/);
  await sql`DELETE FROM sources WHERE id=${`collision-${T}`}`;
  fs.writeFileSync(receipt + ".lock", "");
  await assert.rejects(prepare(target, base, "fixture-secret", receipt, true), /锁/);
  fs.unlinkSync(receipt + ".lock");
  mode = "list-fail";
  await assert.rejects(prepare(target, base, "fixture-secret", path.join(dir,"no-list.json"), true), /未完成请求/);
  assert.equal(adds, previous);
  mode = "ok";
});


test("target feed identity and custom source id collisions are rejected without DB writes", async () => {
  const pack = JSON.parse(fs.readFileSync(sourcesFile, "utf8")).sources as Account[];
  const before = await sql`SELECT * FROM sources WHERE id=${id}`;
  for (const feed of [undefined, "", "wrong"]) {
    const bad = structuredClone(pack);
    if (feed === undefined) delete (bad[1]!.config as Partial<Account["config"]>).feedId;
    else bad[1]!.config.feedId = feed;
    await assert.rejects(applyAccount(bad, target, base, "fixture-secret"));
  }
  assert.deepEqual(await sql`SELECT * FROM sources WHERE id=${id}`, before);
  const custom = structuredClone(pack[1]!);
  custom.id = `collision-${T}`;
  await sql`DELETE FROM articles WHERE source_id=${id}`;
  await sql`DELETE FROM sources WHERE id=${id}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES(${custom.id},'Other RSS','rss')`;
  const other = await sql`SELECT * FROM sources WHERE id=${custom.id}`;
  await assert.rejects(applyAccount([custom], target, base, "fixture-secret"), /冲突/);
  assert.deepEqual(await sql`SELECT * FROM sources WHERE id=${custom.id}`, other);
  await sql`DELETE FROM sources WHERE id=${custom.id}`;
  assert.equal((await applyAccount([custom], target, base, "fixture-secret")).inserted, true);
  assert.equal((await applyAccount([custom], target, base, "fixture-secret")).inserted, false);
});


test("a second existing account has its own identity and does not refresh the first", async () => {
  const second = { name: "另一个已核实账号", bizId: "999002" };
  rows.push({ id: 999002, name: second.name, link: "http://127.0.0.1/feed/onboard-second.xml", paused: false });
  const previous = adds;
  const secondReceipt = await prepare(second, base, "fixture-secret", path.join(dir, "second.json"), true);
  assert.equal(secondReceipt.feedId, "onboard-second");
  const configured = await configureAccount(sourcesFile, secondReceipt);
  assert.equal(configured.inserted, true);
  const pack = JSON.parse(fs.readFileSync(sourcesFile, "utf8")).sources;
  assert.equal((await applyAccount(pack, second, base, "fixture-secret")).inserted, true);
  assert.equal((await accountStatus(pack, second, base, "fixture-secret")).database["collection"], "pending");
  assert.equal(adds, previous);
});
