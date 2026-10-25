import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss, getBoss, QUEUES } from '@aihot/backend/jobs/queue';
import { checkWechat2Rss, retryWechatBody } from '@aihot/backend/sources/wechat2rss';
import { config } from '@aihot/backend/config';
import { bodyFailureMessage, updateWechatBodyIssue } from '@aihot/backend/content/wechat-body-issues';
import { contentChain, rerun } from '@aihot/backend/admin/content';
import { sourceDetail, listSources } from '@aihot/backend/admin/sources';
import { upsertMaterial } from '@aihot/backend/content/materials';

const sourceId = `partial-${tag()}`;
let mode = 'mixed';
const mock = new MockAgent();
const original = getGlobalDispatcher();
mock.disableNetConnect();
mock.enableNetConnect(host => host.startsWith('127.0.0.1:'));
setGlobalDispatcher(mock);
// guardedFetch must consume the mock dispatcher, with no private credential or proxy lookup.
config.allowPrivateNetworkFetch = true;
config.egressProxyUrl = null;
mock.get('https://mp.weixin.qq.com').intercept({path: /bad[12]/}).reply(200, '<html>verification required</html>').persist();
const server = http.createServer((_req, res) => {
  if (mode === 'failed') { res.writeHead(503); res.end(); return; }
  const ids = mode === 'mixed' ? ['good', 'bad1', 'bad2'] : mode.startsWith('shared') ? ['good', mode] : ['good'];
  res.end(`<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${ids.map(id => `<item><title>${id}</title><link>https://mp.weixin.qq.com/s?__biz=MzMz&amp;mid=${sourceId}-${id}&amp;idx=1</link><pubDate>${new Date().toUTCString()}</pubDate><content:encoded><![CDATA[<p>${id === 'good' || id === 'shared-good' ? '这是一篇可用的新闻正文。' : '跳转微信打开'}</p>]]></content:encoded></item>`).join('')}</channel></rss>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.WECHAT2RSS_BASE_URL = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
process.env.WECHAT2RSS_RSS_TOKEN = 'test-token';
await sql`INSERT INTO sources(id,name,kind,config) VALUES(${sourceId},'局部失败测试','mp_account',${sql.json({provider:'wechat2rss',bizId:'333',feedId:'partial'})})`;
after(async () => { setGlobalDispatcher(original); await mock.close(); await new Promise<void>(r => server.close(() => r())); await stopBoss(); await closeDb(); });

test('missing bodies do not fail the feed or block valid articles', async () => {
  const result = await checkWechat2Rss(sourceId, 'manual');
  assert.equal(result.status, 'ok');
  const rows = await sql`SELECT title,body_status,processing_queued_at FROM articles WHERE source_id=${sourceId}`;
  assert.equal(rows.length, 3);
  assert.ok(rows.find(r => r.title === 'good')!.processing_queued_at);
  assert.ok(rows.filter(r => r.title.startsWith('bad')).every(r => r.body_status !== 'ok' && !r.processing_queued_at));
  const [source] = await sql`SELECT health,fail_count FROM sources WHERE id=${sourceId}`;
  assert.equal(source!.health, 'ok');
  assert.equal(source!.fail_count, 0);
  const detail = await sourceDetail(sourceId);
  assert.deepEqual(detail!.runs[0]!.detail.body, {checked:3,ready:1,missing:2});
  assert.equal(detail!.bodyIssues.length, 2);
  assert.ok(detail!.bodyIssues.every(r => r.failed_attempts === 1 && r.stage === 'fetch_body'));
});

test('repeat failures retain causes, survive feed-window advance and still allow transport failure', async () => {
  await checkWechat2Rss(sourceId, 'manual');
  mode = 'good';
  await checkWechat2Rss(sourceId, 'manual');
  const detail = await sourceDetail(sourceId);
  assert.equal(detail!.issueTotal, 2);
  assert.ok(detail!.bodyIssues.every(r => r.failed_attempts === 2 && r.first_error === r.last_error));
  assert.equal(detail!.runs[0]!.detail.body.missing, 0);
  const filtered = await listSources({q:sourceId,bodyIssues:true});
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0]!.body_issues, 2);
  assert.equal((await sourceDetail(sourceId, 2))!.bodyIssues.length, 0);
  assert.equal((await sourceDetail(sourceId, NaN))!.issuePage, 1);
  mode = 'failed';
  assert.equal((await checkWechat2Rss(sourceId, 'manual')).status, 'failed');
  const [s] = await sql`SELECT health,fail_count FROM sources WHERE id=${sourceId}`;
  assert.equal(s!.health, 'degraded');
  assert.equal(s!.fail_count, 1);
  mode = 'good';
});

test('manual retry queues one bounded article job and preserves failure history after recovery', async () => {
  const [a] = await sql`SELECT * FROM articles WHERE source_id=${sourceId} AND title='bad1'`;
  const initial = await contentChain(a!.id);
  const queued = await rerun(a!.id, 'extract', 'partial-retry-001', 'test');
  assert.ok(queued!.jobId);
  const boss = await getBoss();
  const job = await boss.getJobById(QUEUES.mpCheck, queued!.jobId!);
  assert.equal((job!.data as {articleId:string}).articleId, a!.id);
  assert.equal(job!.retryLimit, 0);
  assert.equal((await retryWechatBody(sourceId, a!.id)).status, 'failed');
  assert.equal((await contentChain(a!.id))!.bodyIssue!.failed_attempts, 3);
  const recovered = new MockAgent();
  recovered.disableNetConnect();
  setGlobalDispatcher(recovered);
  recovered.get('https://mp.weixin.qq.com').intercept({path:/bad1/}).reply(200,'<div id="js_content"><p>修复后的真实正文内容。</p></div>');
  try {
    assert.equal((await retryWechatBody(sourceId, a!.id)).status, 'repaired');
    const chain = await contentChain(a!.id);
    assert.ok(chain!.bodyIssue!.resolved_at);
    assert.equal(chain!.bodyIssue!.first_error, initial!.bodyIssue!.first_error);
    assert.equal(chain!.article.revision, a!.revision + 1);
    assert.equal(chain!.article.body_status, 'ok');
    assert.ok(chain!.history.some(h => h.action === 'wechat.body_repair'));
    assert.ok(chain!.history.some(h => h.action === 'wechat.body_resolved'));
    assert.equal((await sourceDetail(sourceId))!.issueTotal, 1);
    assert.equal((await retryWechatBody(sourceId, a!.id)).status, 'already_ready');
    await updateWechatBodyIssue(a!.id, {stage:'fetch_body',message:'late failure',at:new Date(0)});
    assert.ok((await contentChain(a!.id))!.bodyIssue!.resolved_at);
    assert.equal((await contentChain(a!.id))!.article.revision, a!.revision + 1);
    await assert.rejects(retryWechatBody('other-source', a!.id), /not found/);
  } finally { await recovered.close(); setGlobalDispatcher(original); }
});

test('body diagnostics redact authenticated URLs and configured feed token', () => {
  const message = bodyFailureMessage(new Error('test-token https://host/path?key=private failed'));
  assert.equal(message, '[redacted] [URL] failed');
});

test('a globally deduplicated article remains discoverable and repairable from its Wechat2RSS source', async () => {
  const archive = `archive-${sourceId}`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${archive},'先入库的旧来源','external','{}')`;
  const shared = new MockAgent(); shared.disableNetConnect(); shared.enableNetConnect(host => host.startsWith('127.0.0.1:'));
  setGlobalDispatcher(shared);
  let available = false;
  shared.get('https://mp.weixin.qq.com').intercept({path:/shared-/}).reply(() => ({statusCode:200,data:available ? '<div id="js_content"><p>恢复的共享身份文章正文。</p></div>' : '<html>verification required</html>'})).persist();
  try {
    for (const scenario of ['shared-shell','shared-good']) {
      mode = scenario; available = false;
      const item = await upsertMaterial({sourceId:archive,url:`https://mp.weixin.qq.com/s?__biz=MzMz&mid=${sourceId}-${scenario}&idx=1`,title:scenario,via:'import',bodyStatus:'unconfirmed'});
      const result = await checkWechat2Rss(sourceId, 'manual');
      assert.equal(result.status, 'ok');
      assert.ok((await sourceDetail(sourceId))!.bodyIssues.some(i => i.article_id === item.articleId));
      assert.ok((await listSources({q:sourceId,bodyIssues:true})).rows.find(s => s.id === sourceId)!.body_issues);
      const issue = (await contentChain(item.articleId))!.bodyIssue!;
      assert.equal(issue.stage, scenario === 'shared-shell' ? 'fetch_body' : 'save_material');
      const queued = await rerun(item.articleId, 'extract', `retry-${scenario}`, 'test');
      const job = await (await getBoss()).getJobById(QUEUES.mpCheck, queued!.jobId!);
      assert.equal((job!.data as {sourceId:string}).sourceId, sourceId);
      available = true;
      assert.equal((await retryWechatBody(sourceId,item.articleId)).status, 'repaired');
      const chain = (await contentChain(item.articleId))!;
      assert.equal(chain.article.source_id, archive);
      assert.equal(chain.article.body_status, 'ok');
      assert.ok(chain.bodyIssue!.resolved_at);
      assert.ok(!(await sourceDetail(sourceId))!.bodyIssues.some(i => i.article_id === item.articleId));
    }
  } finally { await shared.close(); setGlobalDispatcher(original); }
});
