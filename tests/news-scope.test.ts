import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { publishArticle } from '@aihot/backend/publication/publish';
import { buildApp } from '../apps/api/src/app.ts';

const id = tag(), source = `scope-${id}`, slug = `scope-${id}`, match = `scope:${id}`;
const app = await buildApp();
const allIds: string[] = [], selectedIds: string[] = [];
let serial = 0;
async function article(kind: 'all' | 'selected' | 'delayed' | 'withdrawn' | 'blocked' | 'unmatched' | 'hot' | 'isolated') {
  const sourceId = kind === 'hot' || kind === 'isolated' ? `${source}-${kind}` : source;
  const { articleId } = await upsertMaterial({ sourceId, url: `https://scope.example/${id}/${serial++}`, title: '用于范围切换的 AI 新闻',
    bodyText: '研究团队发布人工智能模型，提供了详细技术说明。'.repeat(30), via: 'fetch', publishedAt: new Date(Date.now() - serial * 60_000) });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,title_zh,summary_zh,tags,selected)
    VALUES(${articleId},1,'rule',${kind === 'blocked' ? 'block' : 'pass'},'用于范围切换的 AI 新闻','这是已经完成处理的中文摘要。',
      ${[kind === 'unmatched' ? 'other' : match]},${kind === 'selected' || kind === 'delayed'})`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  if (kind === 'delayed') await sql`UPDATE publications SET visible_after=now()+interval '1 day' WHERE article_id=${articleId}`;
  if (kind === 'withdrawn') await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleId}`;
  return articleId;
}
before(async () => {
  for (const mode of ['editorial', 'hot_signal', 'isolated']) {
    const suffix = mode === 'editorial' ? '' : mode === 'hot_signal' ? '-hot' : '-isolated';
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,enabled,config)
      VALUES(${source + suffix},'范围切换测试来源','rss','T1',${mode},true,'{"feedUrl":"https://scope.example/rss"}')`;
  }
  await sql`INSERT INTO topics(slug,name,grp,tags,definition,position) VALUES(${slug},'范围切换测试主题','field',${[match]},'查看同一主题的两种新闻范围。',9999)`;
  for (let n = 0; n < 23; n++) {
    const articleId = await article(n < 2 ? 'selected' : 'all');
    allIds.push(articleId); if (n < 2) selectedIds.push(articleId);
  }
  for (const kind of ['delayed', 'withdrawn', 'blocked', 'hot', 'isolated'] as const) await article(kind);
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
async function get(url: string) {
  const response = await app.inject({ method: 'GET', url });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test('topic scope counts match paginated contents and selected caches stay separate', async () => {
  const selected = (await get('/api/site/topics?tab=selected')).topics.find((t: any) => t.slug === slug);
  const all = (await get('/api/site/topics?tab=all')).topics.find((t: any) => t.slug === slug);
  assert.equal(selected.total, 2); assert.equal(all.total, 23);
  assert.equal((await get('/api/site/topics')).topics.find((t: any) => t.slug === slug).total, 2);
  const one = await get(`/api/site/topics/${slug}?tab=all`);
  const two = await get(`/api/site/topics/${slug}?tab=all&page=2`);
  assert.equal(one.topic.total, all.total); assert.equal(one.pageCount, 2);
  assert.equal(one.items.length, 20); assert.equal(two.items.length, 3);
  assert.deepEqual(new Set([...one.items, ...two.items].map(i => i.id)), new Set(allIds));
  const chosen = await get(`/api/site/topics/${slug}?tab=selected`);
  assert.equal(chosen.topic.total, selected.total);
  assert.deepEqual(new Set(chosen.items.map((i: any) => i.id)), new Set(selectedIds));
  assert.equal((await get(`/api/site/topics/${slug}`)).items.length, 2);
});

test('source directory, group and account totals follow the same scope', async () => {
  const accountPath = `/sources/websites/${source}`;
  for (const [tab, count] of [['all', 23], ['selected', 2]] as const) {
    const directory = await get(`/api/site/sources?tab=${tab}`);
    const group = directory.groups.find((g: any) => g.key === 'websites');
    assert.equal(group.accounts.find((a: any) => a.href === accountPath).total, count);
    const account = await get(`/api/site${accountPath}?tab=${tab}`);
    assert.equal(account.total, count); assert.equal(account.source.total, count);
    assert.equal(account.items.length, count);
    const category = await get(`/api/site/sources/websites?tab=${tab}`);
    assert.equal(category.total, group.total);
    if (tab === 'selected') assert.ok(account.items.every((i: any) => i.selected));
  }
  const defaults = await get('/api/site/sources');
  assert.equal(defaults.groups.find((g: any) => g.key === 'websites').accounts.find((a: any) => a.href === accountPath).total, 23);
});

test('both directory and detail APIs reject unknown scopes', async () => {
  for (const path of ['/api/site/topics', `/api/site/topics/${slug}`, '/api/site/sources', `/api/site/sources/websites/${source}`]) {
    assert.equal((await app.inject({ method: 'GET', url: path + '?tab=unfiltered' })).statusCode, 400);
  }
});
