import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "cheerio";
import { sanitizeBody } from "../packages/backend/src/content/sanitize.ts";

const original = "https://mp.weixin.qq.com/s?__biz=MzA4NzgzMjA4MQ==&mid=2453487921&idx=1&sn=87a4df4ab6a61f3089dbef925faae256";
const proxy = (target: string) => `http://127.0.0.1:8080/link-proxy/?k=93422fb0&r=1&u=${encodeURIComponent(target)}`;
const link = (href: string) => `<p><a href="${href.replace(/&/g, "&amp;")}">跳转微信打开</a></p>`;
const hrefOf = (html: string) => load(html)("a").attr("href");

test("Wechat2RSS link proxies resolve to the original article, including stored HTML", () => {
  for (const target of [original, "https://example.org/post?q=a%26b#section"]) {
    const html = sanitizeBody(link(proxy(target)), original);
    assert.equal(hrefOf(html), target);
    assert.equal(sanitizeBody(html, original), html);
  }
});

test("ordinary links and unrelated u parameters retain their destinations", () => {
  for (const href of [original, "https://example.org/redirect?u=https%3A%2F%2Fexample.net", "/article", "#section"]) {
    assert.equal(hrefOf(sanitizeBody(link(href), original)), new URL(href, original).href);
  }
});

test("invalid proxy destinations cannot become executable links", () => {
  for (const target of ["javascript:alert(1)", "data:text/html,test", "//example.org", "not a URL", ""]) {
    const href = hrefOf(sanitizeBody(link(proxy(target)), original));
    assert.equal(href, proxy(target));
  }
  assert.equal(hrefOf(sanitizeBody(link("javascript:alert(1)"))), undefined);
});
