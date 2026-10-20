import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { readWechat2Rss } from "@aihot/backend/sources/wechat2rss";
import type { SourceRow } from "@aihot/backend/sources/types";

const secret = "transport-test-secret";
const mib = 1024 * 1024;
let size = 9 * mib;
let status = 200;
const prefix = '<rss><channel><item><title>Large official-account feed</title><link>https://mp.weixin.qq.com/s/example</link><pubDate>Mon, 19 Oct 2026 00:00:00 GMT</pubDate></item><!--';
const suffix = '--></channel></rss>';
const server = http.createServer((_req, res) => {
  res.writeHead(status, { "content-type": "application/xml" });
  if (status !== 200) { res.end(secret); return; }
  // A chunked feed exercises the streaming limit without trusting Content-Length.
  res.write(prefix);
  res.write("x".repeat(size - Buffer.byteLength(prefix + suffix)));
  res.end(suffix);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const beforeBase = process.env.WECHAT2RSS_BASE_URL;
const beforeToken = process.env.WECHAT2RSS_RSS_TOKEN;
process.env.WECHAT2RSS_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.WECHAT2RSS_RSS_TOKEN = secret;
after(async () => {
  if (beforeBase === undefined) delete process.env.WECHAT2RSS_BASE_URL; else process.env.WECHAT2RSS_BASE_URL = beforeBase;
  if (beforeToken === undefined) delete process.env.WECHAT2RSS_RSS_TOKEN; else process.env.WECHAT2RSS_RSS_TOKEN = beforeToken;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const source = { id: "large-feed", name: "Large feed", kind: "mp_account", config: { provider: "wechat2rss", bizId: "111", feedId: "fixture" },
  tier: "T1_5", participation_mode: "editorial", first_party: false, enabled: true, interval_minutes: 15, cursor: null, fail_count: 0 } as SourceRow;

test("Wechat2RSS accepts a feed larger than 8 MiB and the 16 MiB boundary", async () => {
  for (size of [9 * mib, 16 * mib]) {
    const items = await readWechat2Rss(source);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, "Large official-account feed");
    assert.equal(items[0]!.url, "https://mp.weixin.qq.com/s/example");
  }
});

test("Wechat2RSS rejects oversized streams with a safe size diagnosis", async () => {
  size = 16 * mib + 1;
  await assert.rejects(readWechat2Rss(source), (e: Error) => {
    assert.match(e.message, /exceeds 16 MiB/);
    assert.ok(!e.message.includes(secret));
    assert.ok(!e.message.includes("http"));
    return true;
  });
});

test("Wechat2RSS reports upstream status without its body or authenticated URL", async () => {
  status = 503;
  await assert.rejects(readWechat2Rss(source), (e: Error) => {
    assert.equal(e.message, "Wechat2RSS feed HTTP 503");
    assert.ok(!e.message.includes(secret));
    return true;
  });
});
