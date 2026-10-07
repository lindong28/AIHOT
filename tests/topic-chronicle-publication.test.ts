import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { publicCuratedChronicle } from "@aihot/backend/publication/topic-chronicle-read";
import { buildApp } from "../apps/api/src/app.ts";

const suffix = tag(), source = `chronicle-${suffix}`, slug = source, match = `chronicle:${suffix}`;
const app = await buildApp();
const now = new Date(), day = new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
let serial = 0, history: string, withdrawn: string, storyId: number;
const storyPublicId = randomUUID();
async function article(kind: string, title = "公开的模型发布", score = 90) {
  const sourceId = ["hot_signal", "isolated"].includes(kind) ? `${source}-${kind}` : source;
  const { articleId } = await upsertMaterial({ sourceId, url: `https://chronicle.example/${suffix}/${serial++}`, title,
    bodyText: "人工智能研究团队发布新模型及配套产品。".repeat(30), via: "fetch", publishedAt: new Date(`${day}T08:00:00Z`) });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,tags,score,selected,output)
    VALUES(${articleId},1,'rule','pass','ai-models',${title},'这是模型发布的中文摘要。',${[match]},${score},${kind !== "all"},
      ${sql.json({ fact: { subject: "Demo", action: "launch", object: title, occurredAt: day }, itemType: "model_release" })})`;
  await publishArticle(articleId, { releasedAt: new Date(now.getTime() - 60000) });
  if (kind === "history") await sql`UPDATE publications SET backfill=true WHERE article_id=${articleId}`;
  if (kind === "delayed") await sql`UPDATE publications SET visible_after=now()+interval '1 day' WHERE article_id=${articleId}`;
  if (kind === "withdrawn") await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleId}`;
  if (kind === "ineligible") await sql`UPDATE publications SET eligible=false WHERE article_id=${articleId}`;
  return articleId;
}
async function get(page = 1, tab = "selected") {
  const response = await app.inject({ method: "GET", url: `/api/site/topics/${slug}?tab=${tab}&page=${page}` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
before(async () => {
  for (const mode of ["editorial", "hot_signal", "isolated"]) {
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,enabled,config)
      VALUES(${mode === "editorial" ? source : `${source}-${mode}`},'大事记测试来源','rss','T1',${mode},true,'{"feedUrl":"https://chronicle.example/rss"}')`;
  }
  await sql`INSERT INTO topics(slug,name,grp,tags,definition,position) VALUES(${slug},'大事记测试主题','field',${[match]},'仅供本地测试',9998)`;
  history = await article("history", "历史回填的模型发布");
  withdrawn = await article("withdrawn", "撤回的模型发布");
  for (const kind of ["delayed", "ineligible", "hot_signal", "isolated", "all"]) await article(kind, `${kind} 模型发布`);
  for (let i = 0; i < 21; i++) await article("all", `普通文章 ${i}`, 60);
  [{ id: storyId }] = await sql`INSERT INTO stories(public_id,title) VALUES(${storyPublicId},'测试同一故事的两个进展') RETURNING id`;
  for (const [title, action] of [["第一次发布模型", "launch"], ["后来开放 API", "api"]]) {
    const id = await article("selected", title!);
    const [{ id: factId }] = await sql`INSERT INTO facts(public_id,story_id,title,subject,action,object,occurred_at)
      VALUES(${randomUUID()},${storyId},${title!},'Demo',${action!},${title!},${day}) RETURNING id`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${factId},${id},'primary')`;
    await sql`UPDATE publications SET fact_id=${factId},story_id=${storyId} WHERE article_id=${id}`;
  }
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

test("public API includes eligible history and separate facts, but no hidden or unreleased material", async () => {
  const before = await sql`SELECT (SELECT count(*) FROM facts) AS facts,(SELECT count(*) FROM stories) AS stories,(SELECT count(*) FROM story_signals) AS signals`;
  const selected = await get(), all = await get(1, "all");
  assert.deepEqual(selected.chronicle, all.chronicle);
  const events = selected.chronicle.months.flatMap((m: any) => m.events);
  assert.deepEqual(new Set(events.map((e: any) => e.title)), new Set(["历史回填的模型发布", "第一次发布模型", "后来开放 API"]));
  assert.equal(events.filter((e: any) => e.href === `/story/${storyPublicId}`).length, 2);
  assert.ok(events.some((e: any) => e.href === `/items/${history}`));
  assert.equal((await get(2, "all")).chronicle, null);
  assert.deepEqual(await sql`SELECT (SELECT count(*) FROM facts) AS facts,(SELECT count(*) FROM stories) AS stories,(SELECT count(*) FROM story_signals) AS signals`, before);
});

test("curated item and story links respect current publication eligibility, including a merge alias", async () => {
  const alias = randomUUID();
  await sql`INSERT INTO story_aliases(public_id,story_id) VALUES(${alias},${storyId})`;
  const events = [
    { date: "2020", kind: "model", title: "可公开文章", item: history },
    { date: "2020", kind: "model", title: "撤回文章", item: withdrawn },
    { date: "2020", kind: "model", title: "公开故事", story: storyPublicId },
    { date: "2020", kind: "model", title: "故事旧入口", story: alias },
    { date: "2020", kind: "company", title: "外部人工历史", url: "https://example.com/history" },
    { date: "2020", kind: "company", title: "无链接人工历史" },
  ];
  const input = { topic: "openai", through: "2020-12", events };
  assert.equal((await publicCuratedChronicle(input, now)).events.length, 5);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE story_id=${storyId}`;
  const filtered = await publicCuratedChronicle(input, now);
  assert.deepEqual(filtered.events.map(e => e.title), ["可公开文章", "外部人工历史", "无链接人工历史"]);
  assert.equal((await get()).chronicle.months.flatMap((m: any) => m.events).length, 1);
});

test("a fact with no occurrence date does not reappear as new when later reports arrive", async () => {
  const old = await article("selected", "很早的发布首次报道"), recent = await article("selected", "同一发布最近的报道");
  const [{ id: factId }] = await sql`INSERT INTO facts(public_id,title,subject,action,object)
    VALUES(${randomUUID()},'旧发布','Demo','launch','Old model') RETURNING id`;
  for (const id of [old, recent]) {
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${factId},${id},'report')`;
    await sql`UPDATE publications SET fact_id=${factId} WHERE article_id=${id}`;
  }
  await sql`UPDATE publications SET published_at='2020-01-01',timeline_at='2020-01-01' WHERE article_id=${old}`;
  assert.equal((await get()).chronicle.months.flatMap((m: any) => m.events).length, 1);
});
