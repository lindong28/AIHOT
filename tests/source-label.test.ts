import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceLabel, publicAuthor } from "../packages/backend/src/publication/source-label.ts";

const wechat = { id: "archive-radar-wx-mp2rss", name: "微信公众号（Mp2RSS 合集）", kind: "external" };
test("legacy WeChat attribution needs a uniquely known account, not a guessed author", () => {
  const a = { url: "https://mp.weixin.qq.com/s/article", author: "量子位" };
  assert.equal(sourceLabel(wechat, a, ["量子位"]), "量子位 · 微信公众号");
  assert.equal(sourceLabel(wechat, a, []), "微信公众号（账号未识别）");
  assert.equal(sourceLabel(wechat, a, ["量子位", "量子位"]), "微信公众号（账号未识别）");
  assert.equal(sourceLabel(wechat, { ...a, author: "mp.weixin.qq.com" }, []), "微信公众号（账号未识别）");
  assert.equal(sourceLabel({ ...wechat, id: "mp-qbit", kind: "mp_account", name: "量子位" }, { ...a, author: "记者张三" }), "量子位 · 微信公众号");
});
test("ordinary media keeps its brand; aggregators identify the original site and discovery channel", () => {
  const a = { url: "https://www.nature.com/articles/123", author: "HN-submitter" };
  assert.equal(sourceLabel({ id: "archive-radar-hn-ai", name: "Hacker News AI/LLM", kind: "external" }, a), "nature.com（经 Hacker News）");
  assert.equal(sourceLabel({ id: "nature", name: "Nature", kind: "rss" }, a), "Nature");
  assert.equal(sourceLabel({ id: "external-abc", name: "external-abc", kind: "external" }, a), "nature.com");
});
test("X identity follows the original URL, never the tracked account or quoted post", () => {
  const s = { id: "radar-x-geminiapp", name: "X：Gemini", kind: "x_search" };
  const a = { url: "https://x.com/Google/status/123", author: "someone", x_post: { handle: "Google", tweetId: "123", authorName: "Google" } };
  assert.equal(sourceLabel(s, a), "Google (@Google) · X");
  assert.equal(sourceLabel(s, { ...a, x_post: { ...a.x_post, handle: "GeminiApp" } }), "@Google · X");
  assert.equal(sourceLabel(s, { ...a, x_post: { ...a.x_post, tweetId: "456" } }), "@Google · X");
  assert.equal(sourceLabel(s, { ...a, x_post: { ...a.x_post, authorName: "@Google" } }), "@Google · X");
});
test("public authors omit feed placeholders, HN submitters and duplicate account names", () => {
  assert.equal(publicAuthor("archive-radar-hn-ai", "HN-submitter", "nature.com（经 Hacker News）"), null);
  assert.equal(publicAuthor(wechat.id, "量子位", "量子位 · 微信公众号"), null);
  assert.equal(publicAuthor("archive-radar-wx-ai-assistant-kb-archive", "mp.weixin.qq.com", "微信公众号（账号未识别）"), null);
  assert.equal(publicAuthor("nature", "记者张三", "Nature"), "记者张三");
});
