import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadSourceDirectory, loadSourcePage } from "@aihot/backend/publication/sources";
import { buildApp } from "../apps/api/src/app.ts";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { resolveRedirect, isApiOwned } from "@aihot/contracts/http-policy";

const T = tag();
const mp = `test-directory-mp-${T}`, empty = `test-directory-empty-${T}`, x = `test-directory-x-${T}`;
const web = `test-directory-web-${T}`, dev = `test-directory-dev-${T}`, hidden = `test-directory-hidden-${T}`;
const handle = `sd${T.slice(-10)}`;
const tweetBase = BigInt(Date.now()) * 1000n;
const name = `来源测试公众号-${T}`;
const clock = new Date('2098-10-06T00:00:00Z');
const app = await buildApp();
test('public source routes are owned by web and never redirect to the admin area', () => {
  for (const path of ['/sources', '/sources/wechat', '/sources/x/example']) {
    assert.equal(resolveRedirect(path, ''), null);
    assert.equal(isApiOwned(path), false);
  }
});
before(async () => {
  for (const s of [
    { id: mp, name, kind: 'mp_account', config: { provider: 'wechat2rss', feedId: 'PRIVATE-FEED-ID', bizId: '1234' } },
    { id: empty, name: '暂无新闻的公众号', kind: 'mp_account', config: {} },
    { id: x, name: '研究者 X', kind: 'x_search', config: { query: `from:${handle.toUpperCase()} -filter:replies` } },
    { id: web, name: 'AI 研究博客', kind: 'rss', config: { feedUrl: 'https://research.example.com/rss?token=PRIVATE-TOKEN' } },
    { id: dev, name: '开源项目更新', kind: 'rss', config: { feedUrl: 'https://github.com/example/project/releases.atom' } },
    { id: hidden, name: '不公开的来源', kind: 'rss', config: {} },
  ]) await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,enabled)
    VALUES(${s.id},${s.name},${s.kind},${sql.json(s.config)},'T1',${s.id === hidden ? 'isolated' : 'editorial'},true)`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,enabled) VALUES
    ('archive-radar-wx-mp2rss','Mp2RSS 合集','external','T1','editorial',false),
    ('archive-radar-hn-ai','Hacker News','external','T1','editorial',false) ON CONFLICT DO NOTHING`;
});
after(async () => { await app.close(); await stopBoss(); await closeDb(); });
let serial = 0;
async function article(sourceId: string, url: string, opts: { author?: string; selected?: boolean; via?: 'fetch' | 'import' } = {}) {
  serial++;
  const { articleId } = await upsertMaterial({ sourceId, url, title: `来源导航新闻 ${serial}`, author: opts.author,
    bodyText: '这是一条用于验证来源导航的文章正文。'.repeat(30), via: opts.via ?? 'fetch', publishedAt: new Date(clock.getTime() - serial * 60_000),
    ...(opts.via === 'import' ? { insertOnly: true, backfill: 'managed-test' } : {}) });
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','industry',${`来源导航新闻 ${serial}`},'同一账号的实时新闻与历史新闻在这里汇合。',85,${opts.selected ?? false})`;
  await publishArticle(articleId, { releasedAt: new Date(clock.getTime() - 3600_000) });
  return articleId;
}

test('directory includes enabled zero-item sources, sanitizes metadata, and classifies platforms', async () => {
  const result = await app.inject({ method: 'GET', url: '/api/site/sources' });
  assert.equal(result.statusCode, 200);
  assert.ok(!/PRIVATE-|feedId|bizId|config|provider/.test(result.body));
  const { groups } = result.json();
  const account = groups.find((g: any) => g.key === 'wechat').accounts.find((a: any) => a.href.endsWith('/' + empty));
  assert.equal(account.active, true); assert.equal(account.total, 0);
  assert.ok(groups.find((g: any) => g.key === 'x').accounts.some((a: any) => a.href === `/sources/x/${handle}`));
  assert.ok(groups.find((g: any) => g.key === 'developers').accounts.some((a: any) => a.href.endsWith('/' + dev)));
  assert.ok(groups.find((g: any) => g.key === 'websites').accounts.some((a: any) => a.identifier === 'research.example.com'));
  assert.ok(!result.body.includes(hidden));
});

test('native and historical WeChat converge; unknown and ambiguous authors stay in category', async () => {
  const native = await article(mp, `https://mp.weixin.qq.com/s/native-${T}`, { selected: true });
  const historical = await article('archive-radar-wx-mp2rss', `https://mp.weixin.qq.com/s/history-${T}`, { author: name, via: 'import' });
  const unknown = await article('archive-radar-wx-mp2rss', `https://mp.weixin.qq.com/s/unknown-${T}`, { author: '未知账号' });
  let page = (await loadSourcePage('wechat', mp, 'all', 1, clock))!;
  assert.deepEqual(new Set(page.items.map(i => i.id)), new Set([native, historical]));
  assert.equal(page.source!.total, 2);
  assert.ok(page.items.every(i => i.source.href === `/sources/wechat/${mp}`));
  assert.equal((await loadSourcePage('wechat', mp, 'selected', 1, clock))!.total, 1);
  const selectedDirectory = await loadSourceDirectory(clock, 'selected');
  assert.equal(selectedDirectory.groups.find(g => g.key === 'wechat')!.accounts.find(a => a.href.endsWith('/' + mp))!.total, 1);
  const category = (await loadSourcePage('wechat', null, 'all', 1, clock))!;
  assert.equal(category.items.find(i => i.id === unknown)!.source.href, '/sources/wechat');
  await sql`UPDATE sources SET enabled=false WHERE id=${mp}`;
  page = (await loadSourcePage('wechat', mp, 'all', 1, clock))!;
  assert.equal(page.source!.active, false); assert.equal(page.total, 2);
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${mp + '-duplicate'},${name},'mp_account','T1','editorial')`;
  page = (await loadSourcePage('wechat', mp, 'all', 1, clock))!;
  assert.deepEqual(page.items.map(i => i.id), [native]);
  await sql`DELETE FROM sources WHERE id=${mp + '-duplicate'}`;
  await sql`UPDATE sources SET enabled=true WHERE id=${mp}`;
});

test('X canonical author wins over tracked source and overlaps with HN channel', async () => {
  const native = await article(x, `https://x.com/${handle.toUpperCase()}/status/${tweetBase}`);
  const viaHn = await article('archive-radar-hn-ai', `https://twitter.com/${handle}/status/${tweetBase + 1n}`, { via: 'import' });
  const retweet = await article(x, `https://x.com/anotherauthor/status/${tweetBase + 2n}`);
  const page = (await loadSourcePage('x', handle, 'all', 1, clock))!;
  assert.deepEqual(new Set(page.items.map(i => i.id)), new Set([native, viaHn]));
  assert.ok(page.items.every(i => i.source.href === `/sources/x/${handle}`));
  const hn = (await loadSourcePage('hacker-news', null, 'all', 1, clock))!;
  assert.ok(hn.items.some(i => i.id === viaHn));
  assert.ok(!hn.items.some(i => i.id === native));
  assert.ok((await loadSourcePage('x', 'anotherauthor', 'all', 1, clock))!.items.some(i => i.id === retweet));
  const selectedHn = (await loadSourcePage('hacker-news', null, 'selected', 1, clock))!;
  assert.ok(!selectedHn.items.some(i => i.id === viaHn));
  assert.equal(selectedHn.total, (await loadSourceDirectory(clock, 'selected')).groups.find(g => g.key === 'hacker-news')!.total);
});

test('source links on unlisted historical details resolve to empty source pages', async () => {
  const old = `test-directory-old-${T}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,enabled) VALUES(${old},'历史公众号','mp_account','T1','editorial',false)`;
  const id = await article(old, `https://mp.weixin.qq.com/s/unlisted-${T}`);
  await sql`UPDATE publications SET eligible=false WHERE article_id=${id}`;
  const detail = (await app.inject({ method: 'GET', url: `/api/site/items/${id}` })).json();
  const result = await app.inject({ method: 'GET', url: '/api/site' + detail.source.href });
  assert.equal(result.statusCode, 200); assert.equal(result.json().total, 0); assert.equal(result.json().items.length, 0);
  const xId = await article(old, `https://x.com/old${T.slice(-8)}/status/${tweetBase + 3n}`);
  await sql`UPDATE publications SET eligible=false WHERE article_id=${xId}`;
  const xDetail = (await app.inject({ method: 'GET', url: `/api/site/items/${xId}` })).json();
  const xResult = await app.inject({ method: 'GET', url: '/api/site' + xDetail.source.href });
  assert.equal(xResult.statusCode, 200); assert.equal(xResult.json().total, 0);
});

test('counts and paginated lists exclude withdrawn, delayed and ineligible publications', async () => {
  const ids: string[] = [];
  for (let n = 0; n < 43; n++) ids.push(await article(web, `https://research.example.com/${T}/${n}`));
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${ids[0]!}`;
  await sql`UPDATE publications SET selected=true,visible_after=${new Date(clock.getTime() + 60_000)} WHERE article_id=${ids[1]!}`;
  await sql`UPDATE publications SET eligible=false WHERE article_id=${ids[2]!}`;
  let first = (await loadSourcePage('websites', web, 'all', 1, clock))!;
  assert.equal(first.total, 40); assert.equal(first.items.length, 40); assert.equal(first.source!.total, 40);
  assert.ok(first.items.every(i => !ids.slice(0, 3).includes(i.id)));
  assert.equal(await loadSourcePage('websites', web, 'all', 2, clock), null);
  await article(web, `https://research.example.com/${T}/extra`);
  first = (await loadSourcePage('websites', web, 'all', 1, clock))!;
  const second = (await loadSourcePage('websites', web, 'all', 2, clock))!;
  assert.equal(first.pageCount, 2); assert.equal(second.items.length, 1);
  assert.ok(!first.items.some(i => i.id === second.items[0]!.id));
  assert.ok(Date.parse(first.items.at(-1)!.timelineAt) >= Date.parse(second.items[0]!.timelineAt));
  assert.equal((await app.inject({ method: 'GET', url: '/api/site/sources/websites?page=0' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/site/sources/websites?tab=private' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/site/sources/nonexistent' })).statusCode, 404);
  assert.equal((await loadSourceDirectory(clock)).groups.find(g => g.key === 'websites')!.accounts.find(a => a.href.endsWith('/' + web))!.total, 41);
});
