import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadReport } from "@aihot/backend/publication/reports";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag(), key = `report-images-${T}`;
after(async () => {
  await sql`DELETE FROM reports WHERE kind='daily' AND key=${key}`;
  await stopBoss(); await closeDb();
});

test("reportImages is an optional boolean for every source kind", () => {
  for (const kind of ["rss", "web_list", "json_list", "x_search", "mp_account", "external"] as const) {
    for (const reportImages of [true, false]) assertSupportedConfig(kind, { reportImages });
    for (const reportImages of ["true", 1, null]) assert.throws(() => assertSupportedConfig(kind, { reportImages }));
  }
});

test("historical report covers separate media permission from body mode and respect release gates", async () => {
  const source = `cover-${T}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext)
    VALUES(${source},'图片来源','x_search','T1','editorial',false,false)`;
  const { articleId: id } = await upsertMaterial({ sourceId: source, url: `https://x.com/example/status/${Date.now()}`, title: '头条',
    bodyText: '原帖正文', bodyStatus: 'ok', via: 'fetch', media: [{ kind: 'image', url: 'https://example.org/cover.jpg', width: 800, height: 500 }] });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${id},1,'rule','pass','industry','头条','头条摘要',90,true)`;
  await publishArticle(id, { releasedAt: new Date(Date.now() - 60000) });
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at)
    VALUES('daily',${key},now(),now(),${sql.json({ sections: [{ label: '行业动态', items: [{ itemId: id, title: '头条', summary: '摘要', sourceName: '图片来源' }] }] })},now())`;
  const cover = async () => (await loadReport('daily', key))!.cover;
  assert.ok(await cover(), 'X images are usable even when the body is summary-only');
  assert.equal((await sql`SELECT body_mode FROM publications WHERE article_id=${id}`)[0]!.body_mode, 'summary');
  await sql`UPDATE sources SET config='{"reportImages":false}' WHERE id=${source}`;
  assert.equal(await cover(), null, 'explicit refusal overrides X defaults');
  await sql`UPDATE publications SET body_mode='full' WHERE article_id=${id}`;
  assert.equal(await cover(), null, 'explicit refusal also overrides full text');
  await sql`UPDATE sources SET config='{}' WHERE id=${source}`;
  await sql`UPDATE publications SET channel='news' WHERE article_id=${id}`;
  assert.ok(await cover(), 'existing full-text image permission remains available');
  await sql`UPDATE publications SET body_mode='summary' WHERE article_id=${id}`;
  await sql`UPDATE publications SET channel='news' WHERE article_id=${id}`;
  await sql`UPDATE sources SET kind='mp_account',config='{}' WHERE id=${source}`;
  assert.equal(await cover(), null, 'ordinary summary sources need opt-in');
  await sql`UPDATE sources SET config='{"reportImages":true}' WHERE id=${source}`;
  assert.ok(await cover(), 'explicit opt-in applies to existing reports without regeneration');
  await sql`UPDATE publications SET visible_after=now()+interval '1 day' WHERE article_id=${id}`;
  assert.equal(await cover(), null, 'an unreleased selected article cannot lend its image');
  await sql`UPDATE publications SET selected=false WHERE article_id=${id}`;
  assert.ok(await cover(), 'non-selected public items are not delayed by visible_after');
  await sql`UPDATE publications SET visibility='summary-only' WHERE article_id=${id}`;
  assert.equal(await cover(), null, 'restricted items cannot lend their images');
  await sql`UPDATE publications SET visibility='public' WHERE article_id=${id}`;
  await sql`UPDATE articles SET media='[]' WHERE id=${id}`;
  assert.equal(await cover(), null, 'a report may have no image');
  const other = `other-${T}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config) VALUES(${other},'实际供图来源','rss','T1','editorial','{"reportImages":true}')`;
  const { articleId: otherId } = await upsertMaterial({ sourceId: other, url: `https://example.org/${T}`, title: '同事件报道', via: 'import',
    media: [{ kind: 'image', url: 'https://example.org/related.jpg', width: 600, height: 400 }] });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${otherId},1,'rule','pass','industry','同事件报道','摘要',80,false)`;
  await publishArticle(otherId);
  assert.equal(await cover(), null, 'an unrelated article is never borrowed');
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(gen_random_uuid(),'同一事件') RETURNING id`;
  await sql`UPDATE publications SET story_id=${story!.id} WHERE article_id IN ${sql([id,otherId])}`;
  assert.match((await cover())!.caption!, /实际供图来源/, 'credit belongs to the actual image donor');
  await sql`UPDATE articles SET media='[{"kind":"image","url":"https://example.org/small.jpg","width":100}]' WHERE id=${otherId}`;
  assert.equal(await cover(), null, 'small images are excluded');
});
