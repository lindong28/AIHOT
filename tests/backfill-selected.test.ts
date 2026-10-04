import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { materialHash } from "@aihot/backend/backfill/manifest";
import { importSelected, selectedStatus, validateSelected } from "@aihot/backend/backfill/selected";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { spawnSync } from "node:child_process";

const source = `selected-${tag()}`;
before(async () => { await sql`INSERT INTO sources(id,name,kind) VALUES(${source},'Selected test','rss')`; });
after(async () => { await stopBoss(); await closeDb(); });
function entry(url = `https://example.com/${tag()}`, publishedAt = "2026-01-01T00:00:00Z") {
  const material = { sourceId: source, url, title: "Original title", bodyText: "Complete original text", publishedAt };
  return { material, quality: { state: "complete", evidence: "fixture original", contentHash: materialHash(material) } };
}

test("preview is read-only; concurrent/repeated apply inserts and queues once, preserving originals", async () => {
  const e = entry();
  assert.equal((await importSelected([e]))[0]!.articleId, null);
  assert.equal((await selectedStatus([e]))[0]!.article, null);
  const results = await Promise.all([importSelected([e], true), importSelected([e], true)]);
  assert.deepEqual(results.map((r) => r[0]!.action).sort(), ["existing", "queued"]);
  const id = results[0]![0]!.articleId!;
  const changed = structuredClone(e); changed.material.title = "Should not replace"; changed.quality.contentHash = materialHash(changed.material);
  assert.equal((await importSelected([changed], true))[0]!.articleId, id);
  const [a] = await sql`SELECT title,revision,body_status,backfill,timeline_at FROM articles WHERE id=${id}`;
  assert.equal(a!.title, e.material.title); assert.equal(a!.revision, 1); assert.equal(a!.body_status, "ok");
  assert.equal(a!.backfill, true); assert.equal(a!.timeline_at.toISOString(), "2026-01-01T00:00:00.000Z");
  const jobs = await sql`SELECT priority FROM pgboss.job WHERE name='content.analyze' AND data->>'articleId'=${id}`;
  assert.equal(jobs.length, 1); assert.equal(jobs[0]!.priority, -2);
});

test("recent and sparse dates are accepted without changing historical batch rules", async () => {
  const recent = entry(undefined, new Date().toISOString());
  const old = entry();
  const results = await importSelected([recent, old], true);
  assert.equal(results.filter((r) => r.action === "queued").length, 2);
});

test("WeChat short links must resolve; an existing short alias is reused", async () => {
  const short = `https://mp.weixin.qq.com/s/${tag()}`;
  assert.throws(() => validateSelected([entry(short)]), /规范长链接/);
  const e = { ...entry(`https://mp.weixin.qq.com/s?__biz=test&mid=${Date.now()}&idx=1&sn=test`), submittedUrl: short };
  const old = await upsertMaterial({ sourceId: source, url: short, title: "Existing", bodyText: "Saved", via: "fetch" });
  const result = await importSelected([e], true);
  assert.equal(result[0]!.articleId, old.articleId); assert.equal(result[0]!.action, "existing");
});

test("invalid completeness, duplicate identities and missing sources fail before any article insert", async () => {
  const good = entry(), bad = entry(); bad.material.bodyText = "Changed after approval";
  await assert.rejects(importSelected([good, bad], true), /contentHash/);
  assert.equal((await selectedStatus([good]))[0]!.article, null);
  assert.throws(() => validateSelected([good, good]), /重复/);
  bad.quality.contentHash = materialHash(bad.material); bad.quality.state = "unverified";
  assert.throws(() => validateSelected([bad]), /完整/);
  const missing = entry(); missing.material.sourceId = "not-a-source"; missing.quality.contentHash = materialHash(missing.material);
  await assert.rejects(importSelected([good, missing], true), /未登记/);
  assert.equal((await selectedStatus([good]))[0]!.article, null);
});

test("status distinguishes pending, old revision and topic matching from public inclusion", async () => {
  const e = entry(); const [{ articleId: id }] = await importSelected([e], true);
  const slug = `topic-${tag()}`;
  await sql`INSERT INTO topics(slug,name,grp,tags,definition,position) VALUES(${slug},'Test topic','field',ARRAY['test-topic'],'fixture',9999)`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,tags,score,selected) VALUES(${id},0,'rule','block','opinion',ARRAY['test-topic'],0,false)`;
  assert.equal((await selectedStatus([e]))[0]!.article!.relevance, null);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,tags,score,selected) VALUES(${id},1,'rule','pass','paper',ARRAY['test-topic'],7.5,false)`;
  const result = (await selectedStatus([e]))[0]!;
  assert.equal(result.article!.relevance, "pass"); assert.equal(result.article!.score, 7.5);
  assert.ok(result.matchedTopics.some((t) => t.slug === slug)); assert.deepEqual(result.publishedTopics, []);
});

test("real CLI status exits 2 for pending and 0 for native blocked terminal state", async () => {
  const e = entry(); const [{ articleId: id }] = await importSelected([e], true);
  const run = () => spawnSync(process.execPath, ["scripts/backfill-selected.ts", "status", "/dev/stdin", "--json"],
    { input: JSON.stringify(e) + "\n", encoding: "utf8", timeout: 20_000 });
  assert.equal(run().status, 2);
  await sql`UPDATE articles SET processing_state='blocked' WHERE id=${id}`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,selected) VALUES(${id},1,'rule','block',false)`;
  const blocked = run(); assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).results[0].article.relevance, "block");
});
