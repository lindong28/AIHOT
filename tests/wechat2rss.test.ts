import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { checkMpAccount } from "@aihot/backend/sources/mp";
import { readWechat2Rss } from "@aihot/backend/sources/wechat2rss";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";

const T = tag();
const ids = [`wechat-a-${T}`, `wechat-b-${T}`];
const start = Date.now();
let mode = "ok";
let late = false;
let requests = 0;
const item = (biz: string, id: string, age: number) => `<item><title>文章 ${id}</title><link>https://mp.weixin.qq.com/s?__biz=${Buffer.from(biz).toString("base64")}&amp;mid=${T}${id}&amp;idx=1&amp;sn=track</link><author>作者 ${biz}</author><pubDate>${new Date(start - age).toUTCString()}</pubDate><description>摘要 ${id}</description><content:encoded><![CDATA[<p>完整短文 ${id}。</p>]]></content:encoded></item>`;
const server = http.createServer((req, res) => {
  requests++;
  assert.equal(new URL(req.url!, "http://stub").searchParams.get("k"), "fixture-secret");
  if (mode === "redirect") { res.writeHead(302, { location: "/leak" }); res.end(); return; }
  if (mode === "failed") { res.writeHead(503); res.end("fixture-secret"); return; }
  if (mode === "malformed") { res.end("<not-feed/>"); return; }
  const biz = mode === "wrong-account" ? "999" : req.url!.includes("feed-b") ? "222" : "111";
  const entries = Array.from({ length: 10 }, (_, i) => item(biz, String(i), (i + 1) * 3600_000));
  entries.push(item(biz, "old", 9 * 86400_000));
  if (late) entries.push(item(biz, "late", 12 * 3600_000));
  res.end(`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${entries.join("")}</channel></rss>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.WECHAT2RSS_BASE_URL = base;
process.env.WECHAT2RSS_RSS_TOKEN = "fixture-secret";
const configFor = (i: number) => ({ provider: "wechat2rss", bizId: i ? "222" : "111", feedId: i ? "feed-b" : "feed-a" });
before(async () => {
  for (let i = 0; i < ids.length; i++) await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,interval_minutes,next_fetch_at)
    VALUES (${ids[i]!},${`公众号 ${i}`},'mp_account',${sql.json(configFor(i))},'T1_5','editorial',15,'2100-01-01')`;
});
after(async () => {
  await stopBoss();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

test("per-account Wechat2RSS enters native material and processing queues without X metadata", async () => {
  for (const id of ids) {
    const result = await checkMpAccount(id, "schedule");
    assert.equal(result.status, "ok");
    assert.equal("created" in result && result.created, 8);
  }
  const rows = await sql`SELECT * FROM articles WHERE source_id IN ${sql(ids)}`;
  assert.equal(rows.length, 16);
  assert.equal(new Set(rows.map((r) => r.source_id)).size, 2);
  assert.equal(new Set(rows.map((r) => r.author)).size, 2);
  for (const row of rows) {
    assert.equal(row.language, "zh");
    assert.equal(row.body_status, "ok");
    assert.match(row.body_text, /完整短文/);
    assert.equal(row.x_post, null);
    assert.equal(row.backfill_reason, "first-import");
    assert.ok(row.published_at);
    assert.ok(row.processing_queued_at);
    assert.ok(row.raw.wechat2rss.bizId);
  }
});

test("fixed initial window, duplicate reads and delayed old publication dates", async () => {
  assert.equal((await checkMpAccount(ids[0]!, "schedule") as { created: number }).created, 2);
  assert.equal((await checkMpAccount(ids[0]!, "schedule") as { created: number }).created, 0);
  late = true;
  assert.equal((await checkMpAccount(ids[0]!, "schedule") as { created: number }).created, 1);
  const rows = await sql`SELECT title, revision FROM articles WHERE source_id = ${ids[0]!}`;
  assert.equal(rows.length, 11);
  assert.ok(rows.every((r) => r.revision === 1 && !r.title.endsWith("old")));
});

test("failures keep the success checkpoint and record a redacted failed run", async () => {
  const [before] = await sql`SELECT cursor FROM sources WHERE id=${ids[0]!}`;
  for (const failure of ["failed", "malformed", "wrong-account", "redirect"]) {
    mode = failure;
    const previous = requests;
    const result = await checkMpAccount(ids[0]!, "manual");
    assert.equal(result.status, "failed");
    assert.equal(requests, previous + 1, "redirect is not followed");
    assert.ok(!JSON.stringify(result).includes("fixture-secret"));
    const [after] = await sql`SELECT cursor FROM sources WHERE id=${ids[0]!}`;
    assert.deepEqual(after!.cursor, before!.cursor);
  }
  mode = "ok";
});

test("only the deployment loopback origin is trusted; source paths cannot escape", async () => {
  const source: SourceRow = { id: ids[0]!, config: configFor(0), name: "公众号", kind: "mp_account", participation_mode: "editorial",
    tier: "T1_5", first_party: false, interval_minutes: 15, enabled: true, cursor: null, fail_count: 0 };
  const previous = requests;
  for (const origin of ["http://localhost:1", "https://example.org", "http://127.0.0.1/path", "http://user:secret@127.0.0.1", "http://127.0.0.1?k=secret"]) {
    process.env.WECHAT2RSS_BASE_URL = origin;
    await assert.rejects(readWechat2Rss(source), /origin/);
  }
  process.env.WECHAT2RSS_BASE_URL = base;
  await assert.rejects(readWechat2Rss({ ...source, config: { ...source.config, feedId: "../list?k=secret" } }), /feedId/);
  assert.equal(requests, previous);
  assertSupportedConfig("mp_account", configFor(0));
  assertSupportedConfig("mp_account", { ghid: "existing-dajiala" });
  assert.throws(() => assertSupportedConfig("mp_account", { provider: "other" }));
});

test("paused account is not fetched by schedule", async () => {
  await sql`UPDATE sources SET enabled=false WHERE id=${ids[1]!}`;
  const previous = requests;
  assert.equal((await checkMpAccount(ids[1]!, "schedule")).status, "paused");
  assert.equal(requests, previous);
  assert.equal((await checkMpAccount(ids[1]!, "manual")).status, "ok");
});

test("registration requires both deployment settings before writing sources", async () => {
  const before = await sql`SELECT id,config,enabled,cursor FROM sources ORDER BY id`;
  for (const missing of [["WECHAT2RSS_BASE_URL"], ["WECHAT2RSS_RSS_TOKEN"], ["WECHAT2RSS_BASE_URL", "WECHAT2RSS_RSS_TOKEN"]]) {
    const env = { ...process.env };
    for (const name of missing) delete env[name];
    const result = spawnSync(process.execPath, ["deploy/wechat2rss/register-source.ts"], {
      cwd: new URL("../", import.meta.url), env, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /未修改信源/);
    assert.ok(!result.stderr.includes("fixture-secret"));
  }
  assert.deepEqual(await sql`SELECT id,config,enabled,cursor FROM sources ORDER BY id`, before);
});
