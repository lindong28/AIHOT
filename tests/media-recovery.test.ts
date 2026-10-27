import "./setup.ts";
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";
process.env.AIHOT_DATA_DIR = process.env.MEDIA_TEST_DATA_DIR ?? `${process.env.HOME}/task-artifacts/aihot-media-recovery-${process.pid}`;
process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
await mkdir(process.env.AIHOT_DATA_DIR, { recursive: true });
let failed = true;
const hits = new Map<string, number>();
const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: "red" } }).png().toBuffer();
const server = createServer((req, res) => {
  const key = req.url!; hits.set(key, (hits.get(key) ?? 0) + 1);
  if (key.startsWith("/bad") && failed) { res.writeHead(503); res.end(); return; }
  res.writeHead(200, { "content-type": "image/png" }); res.end(png);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());
test("transient proxy errors cannot enter browser or shared caches", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { proxiedImage } = await import("@aihot/backend/media/imgproxy");
  const app = Fastify(); registerMedia(app);
  try {
    const response = await app.inject({ url: proxiedImage(`${base}/bad`, "card")! });
    assert.equal(response.statusCode, 502);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-accel-expires"], "0");
  } finally { await app.close(); }
});
test("preparation retains successes, reports failures and recovers after negative-cache expiry", async (t) => {
  const preparation = await import("@aihot/backend/media/prepare");
  assert.equal(typeof preparation.prepareRenditions, "function");
  const targets = [{ url: `${base}/good`, mode: "card" }, { url: `${base}/bad`, mode: "card" }];
  await assert.rejects(preparation.prepareRenditions("article-test", targets), (error: Error) => {
    assert.match(error.message, /article-test/); assert.match(error.message, /upstream 503/); assert.match(error.message, /resourceId/); return true;
  });
  assert.equal(hits.get("/good"), 1);
  const before = hits.get("/bad");
  await assert.rejects(preparation.prepareRenditions("article-test", targets));
  assert.equal(hits.get("/bad"), before);
  failed = false;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() }); t.mock.timers.tick(60_001);
  assert.deepEqual(await preparation.prepareRenditions("article-test", targets), { renditions: 2, failed: 0, animatedSaved: 0 });
  assert.equal(hits.get("/good"), 1); assert.equal(hits.get("/bad"), before! + 1);
});

test("diagnostics retain nested network codes and redact authenticated URLs", async () => {
  const { imageFailure, ImageStageError } = await import("@aihot/backend/media/failure");
  const cause = Object.assign(new Error("TLS handshake failed https://user:secret@example.org/path?token=abc sig=hidden Authorization: Bearer bearer-value"), { code: "ECONNRESET" });
  const detail = imageFailure("https://user:secret@example.org/path?token=abc", "card", new ImageStageError("fetch", new Error("fetch failed", { cause })));
  assert.equal(detail.host, "example.org");
  assert.equal(detail.causes[2]?.code, "ECONNRESET");
  assert.match(JSON.stringify(detail), /TLS handshake failed/);
  assert.doesNotMatch(JSON.stringify(detail), /secret|abc|hidden|user:|bearer-value/);
});

test("article preparation rejects into a persisted bounded queue retry", { timeout: 20000 }, async () => {
  const { sql, closeDb } = await import("@aihot/backend/db");
  const { upsertMaterial } = await import("@aihot/backend/content/materials");
  const { publishArticle } = await import("@aihot/backend/publication/publish");
  const { prepareArticleMedia } = await import("@aihot/backend/media/prepare");
  const { getBoss, stopBoss, QUEUE_OPTIONS, QUEUES } = await import("@aihot/backend/jobs/queue");
  const source = `media-recovery-${process.pid}`;
  const queue = `media-recovery-${process.pid}`;
  const boss = await getBoss();
  failed = true;
  try {
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES (${source}, 'Media recovery', 'x_search', 'T1', 'editorial')`;
    const { articleId } = await upsertMaterial({ sourceId: source, url: `https://example.org/${source}`, title: "图片测试", via: "ingest", bodyText: "图片测试", bodyStatus: "ok", xPost: { tweetId: source, authorName: "测试", handle: "test", text: "图片测试", media: [{ kind: "image", url: `${base}/bad-queue` }, { kind: "image", url: `${base}/good` }] } });
    await publishArticle(articleId);
    const options = QUEUE_OPTIONS[QUEUES.prepareMedia]!;
    assert.equal(options.retryLimit, 1); assert.equal(options.retryDelay, 120);
    await boss.createQueue(queue, options);
    await boss.work<{ articleId: string }>(queue, { pollingIntervalSeconds: 0.5 }, async ([job]) => prepareArticleMedia(job!.data.articleId));
    const id = await boss.send(queue, { articleId });
    async function waitFor(state: string) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const [row] = await sql`SELECT state, retry_count, output FROM pgboss.job WHERE id=${id}`;
        if (row?.state === state) return row;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail(`job did not reach ${state}`);
    }
    const retry = await waitFor("retry");
    assert.match(JSON.stringify(retry.output), new RegExp(articleId));
    assert.match(JSON.stringify(retry.output), /upstream 503/);
    // Advance only this test job's delay; production queue policy remains 120 seconds.
    await sql`UPDATE pgboss.job SET start_after=now() WHERE id=${id}`;
    const terminal = await waitFor("failed");
    assert.equal(terminal.retry_count, 1);
    assert.match(JSON.stringify(terminal.output), /resourceId/);
  } finally {
    await stopBoss(); await closeDb();
  }
});

test("malformed image diagnostics do not prevent later healthy renditions", async () => {
  const { prepareRenditions } = await import("@aihot/backend/media/prepare");
  let failure: unknown;
  try {
    await prepareRenditions("article-malformed", [{ url: "https://[", mode: "card" }, { url: `${base}/after-malformed`, mode: "card" }]);
  } catch (error) { failure = error; }
  assert.equal(hits.get("/after-malformed"), 1, "a malformed first image must not abandon the next image");
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /article-malformed/);
  const { imageFailure } = await import("@aihot/backend/media/failure");
  const detail = imageFailure("https://[", "card", new TypeError("Invalid URL"));
  assert.equal(detail.host, null);
  assert.equal(detail.causes[0]?.message, "Invalid URL");
  assert.doesNotMatch(JSON.stringify(detail), /https:/);
});
