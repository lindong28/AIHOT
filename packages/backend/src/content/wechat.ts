// Observed provider chrome is not an article. Short posts and media-only posts remain valid.
import { load } from "cheerio";
import { sanitizeBody } from "./sanitize.ts";
import { stripTags } from "../lib/text.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { z } from "zod";
import { identityKeyForUrl, normalizeUrl } from "../lib/url.ts";
import { sha256, stableJson } from "../lib/ids.ts";

export const WECHAT_ARCHIVE_SOURCES = ["archive-radar-wx-mp2rss", "archive-radar-wx-wechat2rss", "archive-radar-wx-ai-assistant-kb-archive"];
export function wechatBodyIssue(text: string | null | undefined, html?: string | null): string | null {
  const $ = load(html ?? "", null, false);
  if ($("img[src],img[data-src],video[src],iframe[src]").length) return null;
  const compact = (text ?? "").replace(/\s+/g, "");
  if (!compact) return "missing_body";
  if (["不喜欢", "跳转微信打开", "：，。视频小程序赞，轻点两下取消赞在看，轻点两下取消在看"].includes(compact)) return "wechat_ui_only";
  return null;
}

const identitySchema = z.object({ biz: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  mid: z.string().regex(/^[1-9]\d*$/), idx: z.string().regex(/^[1-9]\d*$/), sn: z.string().regex(/^[a-fA-F0-9]{32}$/) }).strict();
export const wechatObservationSchema = z.object({ observedAt: z.iso.datetime({ offset: true }), pageUrl: z.string(),
  hasContent: z.literal(true), identity: identitySchema, msgLink: z.string().optional(), ogUrl: z.string().optional() }).strict();
export interface WechatReadingProof {
  readonly canonicalIdentity: string; readonly readingUrl: string; readonly sourceUrl: string;
  readonly pageUrl: string; readonly observedAt: string; readonly evidenceSource: string; readonly evidenceHash: string;
}
const proofs = new WeakSet<object>();
export function assertWechatReadingProof(proof: WechatReadingProof): void {
  if (!proof || !proofs.has(proof)) throw new Error("Untrusted WeChat reading-link evidence");
}
export function wechatArticleUrl(value: string): URL | null {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "mp.weixin.qq.com" && !u.port && !u.username && !u.password
      && (u.pathname === "/s" || /^\/s\/[A-Za-z0-9_-]+$/.test(u.pathname)) ? u : null;
  } catch { return null; }
}
export function wechatCanonicalIdentity(value: string): string | null {
  const u = wechatArticleUrl(value);
  if (!u || u.pathname !== "/s") return null;
  const parsed = identitySchema.safeParse({ biz: u.searchParams.get("__biz"), mid: u.searchParams.get("mid"),
    idx: u.searchParams.get("idx"), sn: u.searchParams.get("sn") });
  if (!parsed.success || ["__biz","mid","idx","sn"].some(k => u.searchParams.getAll(k).length !== 1)) return null;
  return identityKeyForUrl(u.href);
}
function proofFromObservation(input: unknown, sourceUrl: string, evidenceSource: string): WechatReadingProof {
  const o = wechatObservationSchema.parse(input);
  if (Date.parse(o.observedAt) > Date.now() + 300_000) throw new Error("Observation time is in the future");
  const long = new URL("https://mp.weixin.qq.com/s");
  for (const [key,value] of Object.entries(o.identity)) long.searchParams.set(key === "biz" ? "__biz" : key, value);
  const canonicalIdentity = wechatCanonicalIdentity(long.href)!;
  const declarations = [o.msgLink, o.ogUrl].filter((v): v is string => v !== undefined);
  if (!declarations.length) throw new Error("Missing WeChat reading-link declaration");
  const links = declarations.map(v => {
    const u = wechatArticleUrl(v);
    if (!u || u.pathname === "/s") throw new Error("Expected a WeChat share URL");
    // Share links do not carry article identity parameters; never strip a contradictory identity.
    if (["__biz","mid","idx","sn"].some(k => u.searchParams.has(k))) throw new Error("Unexpected identity on share URL");
    return normalizeUrl(u.href)!;
  });
  const readingUrl = links[0]!;
  if (links.some(v => v !== readingUrl)) throw new Error("WeChat link declarations disagree");
  for (const value of [sourceUrl, o.pageUrl]) {
    const u = wechatArticleUrl(value);
    if (!u || (u.pathname === "/s" ? wechatCanonicalIdentity(value) !== canonicalIdentity : normalizeUrl(value) !== readingUrl)) {
      throw new Error("WeChat page identity does not match target");
    }
  }
  const proof = Object.freeze({ canonicalIdentity, readingUrl, sourceUrl, pageUrl: o.pageUrl, observedAt: o.observedAt,
    evidenceSource, evidenceHash: sha256(stableJson({ ...o, sourceUrl, evidenceSource })) });
  proofs.add(proof);
  return proof;
}
/** Explicit DB-operator attestation of already obtained evidence, never a collector/raw-JSON input. */
export function attestWechatReadingLink(input: unknown, sourceUrl: string, operator: string): WechatReadingProof {
  if (!operator.trim() || operator.length > 500) throw new Error("Evidence operator/source is required");
  return proofFromObservation(input, sourceUrl, `operator-attestation:${operator.trim()}`);
}
// Read only literal assignments observed in WeChat HTML. Never execute page JavaScript.
function scriptLiteral(script: string, name: string): string | null {
  const literal = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+)`;
  const pattern = new RegExp(String.raw`\b(?:var|let|const)\s+${name}\s*=\s*(${literal}(?:\s*\|\|\s*${literal})*)\s*(?:;|\r?\n)`, "g");
  const values: string[] = [];
  for (const match of script.matchAll(pattern)) {
    const parts = match[1]!.match(new RegExp(literal, "g")) ?? [];
    const decoded = parts.map(v => /^\d+$/.test(v) ? v : v.slice(1,-1).replace(/\\(?:x([\da-fA-F]{2})|u([\da-fA-F]{4})|([\\/'"]))/g,
      (_all,hex2,hex4,char) => char ?? String.fromCharCode(parseInt(hex2 ?? hex4,16))));
    values.push(decoded.find(v => v.length > 0) ?? "");
  }
  if (values.some(v => v !== values[0])) throw new Error(`Conflicting WeChat ${name} declarations`);
  return values.length ? values[0]! : null;
}
function matchingScriptLiteral(script: string, ...names: string[]): string | null {
  const values = names.map(name => scriptLiteral(script,name)).filter((v): v is string => v !== null);
  if (values.some(v => v !== values[0])) throw new Error("Conflicting WeChat identity declarations");
  return values[0] ?? null;
}
/** Same-response body and metadata parser. Missing/conflicting metadata does not discard a usable body. */
export function parseWechatPage(html: string, sourceUrl: string, pageUrl = sourceUrl, observedAt = new Date()) {
  if (!wechatArticleUrl(sourceUrl) || !wechatArticleUrl(pageUrl)) throw new Error("Expected a WeChat article URL");
  const $ = load(html);
  const content = $("#js_content");
  if (!content.length) throw new Error("WeChat article body unavailable; original may require browser verification");
  const bodyHtml = sanitizeBody(content.html() ?? "", pageUrl);
  const bodyText = stripTags(bodyHtml);
  if (wechatBodyIssue(bodyText, bodyHtml)) throw new Error("WeChat original contains no usable body");
  let readingProof: WechatReadingProof | undefined;
  try {
    const script = $("script").map((_i,el) => $(el).html() ?? "").get().join("\n");
    const msgLink = scriptLiteral(script,"msg_link"), og = $("meta[property='og:url']").map((_i,el) => $(el).attr("content") ?? "").get();
    if (og.some(v => v !== og[0])) throw new Error("Conflicting og:url declarations");
    const observation = { observedAt: observedAt.toISOString(), pageUrl, hasContent: true,
      identity: { biz: matchingScriptLiteral(script,"biz","__biz"), mid: matchingScriptLiteral(script,"mid","appmsgid"),
        idx: scriptLiteral(script,"idx"), sn: scriptLiteral(script,"sn") },
      ...(msgLink === null ? {} : {msgLink}), ...(og.length ? {ogUrl:og[0]} : {}) };
    readingProof = proofFromObservation(observation,sourceUrl,"wechat-body-response");
  } catch { /* The body remains usable; no alias is asserted when page metadata is insufficient. */ }
  return { bodyHtml, bodyText, bodyStatus: "ok" as const, ...(readingProof ? { readingProof } : {}) };
}
/** Direct original fetch, only for a known missing body. No model, paid fetch or login bypass. */
export async function fetchWechatBody(url: string) {
  if (!wechatArticleUrl(url)) throw new Error("Expected a WeChat original URL");
  const response = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
  if (response.status !== 200 || !wechatArticleUrl(response.url)) throw new Error("WeChat original unavailable");
  return parseWechatPage(response.text(),url,response.url);
}
