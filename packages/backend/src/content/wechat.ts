// Observed provider chrome is not an article. Short posts and media-only posts remain valid.
import { load } from "cheerio";
import { sanitizeBody } from "./sanitize.ts";
import { stripTags } from "../lib/text.ts";
import { guardedFetch } from "../lib/http-fetch.ts";

export const WECHAT_ARCHIVE_SOURCES = ["archive-radar-wx-mp2rss", "archive-radar-wx-wechat2rss", "archive-radar-wx-ai-assistant-kb-archive"];
export function wechatBodyIssue(text: string | null | undefined, html?: string | null): string | null {
  const $ = load(html ?? "", null, false);
  if ($("img[src],img[data-src],video[src],iframe[src]").length) return null;
  const compact = (text ?? "").replace(/\s+/g, "");
  if (!compact) return "missing_body";
  if (["不喜欢", "跳转微信打开", "：，。视频小程序赞，轻点两下取消赞在看，轻点两下取消在看"].includes(compact)) return "wechat_ui_only";
  return null;
}

/** Direct original fetch, only for a known missing body. No model, paid fetch or login bypass. */
export async function fetchWechatBody(url: string) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.hostname !== "mp.weixin.qq.com") throw new Error("Expected a WeChat original URL");
  const response = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
  if (response.status !== 200 || new URL(response.url).hostname !== target.hostname) throw new Error("WeChat original unavailable");
  const $ = load(response.text());
  const content = $("#js_content");
  if (!content.length) throw new Error("WeChat article body unavailable; original may require browser verification");
  const bodyHtml = sanitizeBody(content.html() ?? "", url);
  const bodyText = stripTags(bodyHtml);
  if (wechatBodyIssue(bodyText, bodyHtml)) throw new Error("WeChat original contains no usable body");
  return { bodyHtml, bodyText, bodyStatus: "ok" as const };
}
