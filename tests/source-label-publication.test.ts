import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { repairSourceLabel, repairReportSourceLabels } from "../packages/backend/src/publication/repair-source-labels.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { repairHotSourceLabels } from "@aihot/backend/events/hot-read";

const app = await buildApp();
const T = tag();
const reportKeys: string[] = [], rankingIds: number[] = [];
after(async () => {
  if (reportKeys.length) await sql`DELETE FROM reports WHERE kind='daily' AND key IN ${sql(reportKeys)}`;
  if (rankingIds.length) await sql`DELETE FROM hot_rankings WHERE id IN ${sql(rankingIds)}`;
  await app.close(); await stopBoss(); await closeDb();
});

test("realtime and frozen backfill share attribution; legacy repair is metadata-only and idempotent", async () => {
  const source = "archive-radar-wx-mp2rss";
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,site_fulltext,syndicate_fulltext,enabled)
    VALUES(${source},'微信公众号（Mp2RSS 合集）','external','T1','editorial',false,false,false),
      ('test-mp-qbit','量子位','mp_account','T1','editorial',false,false,false) ON CONFLICT DO NOTHING`;
  for (const via of ["fetch", "import"] as const) {
    const { articleId: id } = await upsertMaterial({ sourceId: source, url: `https://mp.weixin.qq.com/s/source-label-${via}-${T}`, title: "中文原题", author: "量子位",
      bodyText: "PRIVATE ORIGINAL BODY", via, ...(via === "import" ? { insertOnly: true, backfill: "managed-test" } : {}) });
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
      VALUES(${id},1,'rule','pass','industry','中文标题','中文摘要',90,true)`;
    await publishArticle(id, { releasedAt: new Date(Date.now() - 60000) });
    let result = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().source.name, "量子位 · 微信公众号");
    assert.equal(result.json().author, null);
    const [before] = await sql`SELECT a.*,p.visibility,p.selected,p.body_mode,p.visible_after,p.sort_at FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.id=${id}`;
    await sql`UPDATE publications SET source_label=NULL WHERE article_id=${id}`;
    await sql`UPDATE selected_state SET payload_hash='old-source-label' WHERE article_id=${id}`;
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at)
      VALUES('daily',${'source-label-' + via + T},now(),now(),${sql.json({ sections: [{ items: [{ itemId: id, sourceName: "微信公众号（Mp2RSS 合集）", title: "原日报标题", sourceUrl: "https://mp.weixin.qq.com/s/frozen" }] }] })},now())`;
    reportKeys.push('source-label-' + via + T);
    const [{ n: ledgers }] = await sql`SELECT count(*)::int n FROM selected_ledger WHERE article_id=${id}`;
    const [{ n: receipts }] = await sql`SELECT count(*)::int n FROM receipts`;
    assert.equal(await repairSourceLabel(id), true);
    assert.equal(await repairSourceLabel(id), false);
    assert.equal(await repairReportSourceLabels(true), 1);
    assert.equal(await repairReportSourceLabels(true), 0);
    const [after] = await sql`SELECT a.*,p.visibility,p.selected,p.body_mode,p.visible_after,p.sort_at FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.id=${id}`;
    assert.deepEqual(after, before);
    const [{ n: nextLedgers }] = await sql`SELECT count(*)::int n FROM selected_ledger WHERE article_id=${id}`;
    assert.equal(nextLedgers, ledgers + 1);
    assert.equal((await sql`SELECT count(*)::int n FROM receipts`)[0]!.n, receipts);
    assert.equal((await sql`SELECT direct FROM pool_search WHERE article_id=${id}`)[0]!.direct.includes("量子位"), true);
    assert.equal((await app.inject({ method: "GET", url: `/api/site/items/${id}` })).json().source.name, "量子位 · 微信公众号");
    const ledger = (await sql`SELECT payload FROM selected_ledger WHERE article_id=${id} ORDER BY seq DESC LIMIT 1`)[0]!.payload;
    assert.equal(ledger.source.name, "量子位 · 微信公众号");
    const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(gen_random_uuid(),'来源测试') RETURNING id`;
    await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at)
      VALUES(${story!.id},${id},'same-participant',${source},'editorial',now() - interval '1 second')`;
    const entry = { storyId: story!.id, representativeItemId: id, representativeSource: "旧来源", sourceNames: ["旧来源"],
      participants: [{ name: "旧来源", kind: "editorial", tier: "T1" }], heat: 42, rank: 1, participantCount: 1 };
    const [ranking] = await sql`INSERT INTO hot_rankings(rule_version,entries) VALUES('test',${sql.json([entry])}) RETURNING id`;
    rankingIds.push(Number(ranking!.id));
    assert.equal(await repairHotSourceLabels(), 1);
    assert.equal(await repairHotSourceLabels(), 0);
    const fixed = (await sql`SELECT entries FROM hot_rankings WHERE id=${ranking!.id}`)[0]!.entries[0];
    assert.equal(fixed.heat, 42);
    assert.equal(fixed.rank, 1);
    assert.equal(fixed.participantCount, 1);
    assert.deepEqual(fixed.sourceNames, ["量子位 · 微信公众号"]);
    assert.equal(fixed.representativeSource, "量子位 · 微信公众号");
    result = await app.inject({ method: "GET", url: `/items/${id}/markdown` });
    assert.ok(result.body.includes("量子位 · 微信公众号"));
  }
});
