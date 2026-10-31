// The existing Wechat2RSS instance supplies a separate RSS feed for each official account.
import { fetchWechatBody, wechatBodyIssue } from "../content/wechat.ts";
import { bodyFailureMessage, updateWechatBodyIssue } from "../content/wechat-body-issues.ts";
import { repairHash, repairWechatBody } from "../content/wechat-repair.ts";
import { credential } from "../config.ts";
import { sql } from "../db.ts";
import { upsertMaterial } from "../content/materials.ts";
import { queueProcessing } from "../jobs/content.ts";
import { parseRss } from "./rss.ts";
import type { SourceRow } from "./types.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { resolveWechatMaterialIdentity } from "../content/wechat-link-registry.ts";

// Full-text account feeds can exceed the public collector’s 8 MiB limit. Keep this loopback-only read bounded.
const MAX_FEED_BYTES = 16 * 1024 * 1024;
class FeedReadError extends Error {}

/** Only an operator-configured loopback tunnel may bypass public collector SSRF checks. */
export async function readWechat2Rss(source: SourceRow) {
  const base = credential("collectors", "WECHAT2RSS_BASE_URL");
  const token = credential("collectors", "WECHAT2RSS_RSS_TOKEN");
  if (!base || !token) throw new Error("Wechat2RSS: configure WECHAT2RSS_BASE_URL and WECHAT2RSS_RSS_TOKEN");
  let origin: URL;
  try { origin = new URL(base); } catch { throw new Error("Wechat2RSS: invalid deployment origin"); }
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("Wechat2RSS: deployment origin must be http://127.0.0.1:PORT");
  }
  const { feedId, bizId } = source.config;
  if (typeof feedId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(feedId) || !/^\d+$/.test(String(bizId ?? ""))) {
    throw new Error("Wechat2RSS: feedId and numeric bizId required");
  }
  const url = new URL(`/feed/${feedId}.xml`, origin);
  url.searchParams.set("k", token);
  let xml: string;
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(25_000) });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new FeedReadError(`Wechat2RSS feed HTTP ${response.status}`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.byteLength;
      if (size > MAX_FEED_BYTES) throw new FeedReadError("Wechat2RSS feed exceeds 16 MiB response limit");
      chunks.push(chunk);
    }
    xml = Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof FeedReadError) throw error;
    // Do not expose token-bearing URLs or upstream response bodies in source errors/logs.
    throw new Error("Wechat2RSS feed unavailable; check the tunnel, token and service");
  }
  const items = parseRss(xml, source, origin.origin);
  for (const item of items) {
    const article = new URL(item.url);
    if (article.protocol !== "https:" || article.hostname !== "mp.weixin.qq.com") throw new Error("Wechat2RSS: unexpected article origin");
    const biz = article.searchParams.get("__biz");
    if (biz && Buffer.from(biz, "base64").toString() !== String(bizId)) throw new Error("Wechat2RSS: article account does not match source");
  }
  return items.map((item) => ({
    ...item, language: "zh", author: item.author || source.name,
    bodyStatus: item.bodyStatus,
    raw: { wechat2rss: { bizId: String(bizId), feedId } },
  }));
}

export async function checkWechat2Rss(sourceId: string, reason: "schedule" | "manual") {
  const [source] = await sql<SourceRow[]>`SELECT * FROM sources WHERE id = ${sourceId} AND kind = 'mp_account'`;
  if (!source) return { sourceId, status: "missing" as const };
  if (!source.enabled && reason !== "manual") return { sourceId, status: "paused" as const };
  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id, detail) VALUES (${sourceId}, ${sql.json({ reason, provider: "wechat2rss" })}) RETURNING id`;
  let created = 0;
  let revised = 0;
  try {
    const now = new Date();
    const initializedAt = source.cursor?.initializedAt ?? now.toISOString();
    const cutoff = Date.parse(initializedAt) - 7 * 86400_000;
    const items = await readWechat2Rss(source);
    const candidates = items.filter((item) => item.publishedAt && item.publishedAt.getTime() >= cutoff)
      .sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime());
    const batch = candidates.slice(0, source.cursor?.initializedAt ? 50 : 8);
    const missingKeys = batch.filter((item) => item.bodyStatus !== "ok")
      .map((item) => item.identityKey ?? identityKeyForUrl(item.url)).filter((key): key is string => !!key);
    const aliases = missingKeys.length ? await sql`SELECT identity_key,canonical_identity,reading_url FROM wechat_reading_links
      WHERE identity_key IN ${sql(missingKeys)} OR canonical_identity IN ${sql(missingKeys)} OR ('url:'||reading_url) IN ${sql(missingKeys)}` : [];
    const owners = new Map<string,string>();
    for (const a of aliases) for (const key of [a.identity_key,a.canonical_identity,identityKeyForUrl(a.reading_url)!]) owners.set(key,a.identity_key);
    const ownerKey = (item: {identityKey?: string;url:string}) => {
      const key = item.identityKey ?? identityKeyForUrl(item.url)!;
      return owners.get(key) ?? key;
    };
    const storedKeys = [...new Set(missingKeys.map(key => owners.get(key) ?? key))];
    const stored = storedKeys.length ? await sql`SELECT identity_key,body_text,body_html FROM articles
      WHERE source_id=${sourceId} AND identity_key IN ${sql(storedKeys)} AND body_status='ok' AND content_discarded_at IS NULL` : [];
    const bodies = new Map(stored.filter((a) => !wechatBodyIssue(a.body_text, a.body_html)).map((a) => [a.identity_key, a]));
    const failures = new Map<string, { stage: string; message: string; at: Date }>();
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(8, batch.length) }, async () => {
      while (index < batch.length) {
        const item = batch[index++]!;
        if (item.bodyStatus !== "ok") {
          const body = bodies.get(ownerKey(item));
          // A feed's placeholder must not invalidate a body already recovered for this source.
          if (body) Object.assign(item, { bodyText: body.body_text, bodyHtml: body.body_html, bodyStatus: "ok" });
          else {
            const at = new Date();
            try { Object.assign(item, await fetchWechatBody(item.url)); }
            catch (error) { failures.set(item.url, { stage: "fetch_body", message: bodyFailureMessage(error), at }); }
          }
        }
      }
    }));
    let missing = 0;
    for (const item of batch) {
      const saved = await sql.begin(async tx => {
        // A repair may have finished while this request was in flight; retain it under the row lock.
        if (item.bodyStatus !== "ok") {
          const identity = await resolveWechatMaterialIdentity(tx,item.url,item.identityKey ?? identityKeyForUrl(item.url)!);
          const [current] = await tx`SELECT body_text,body_html,body_status FROM articles
            WHERE source_id=${sourceId} AND identity_key=${identity}
              AND content_discarded_at IS NULL FOR UPDATE`;
          if (current?.body_status === "ok" && !wechatBodyIssue(current.body_text, current.body_html)) {
            Object.assign(item, { bodyText: current.body_text, bodyHtml: current.body_html, bodyStatus: "ok" });
          }
        }
        const result = await upsertMaterial({ ...item, sourceId, via: "fetch",
          backfill: item.publishedAt!.getTime() <= Date.parse(initializedAt) ? "first-import" : null }, tx);
        const usable = await updateWechatBodyIssue(result.articleId, failures.get(item.url) ?? {
          stage: "save_material", message: "已保存候选，但已有归属或回填保护下的文章仍缺正文；请在内容诊断中查看并修复", at: now,
        }, tx);
        if (!usable) missing++;
        if (usable && (result.created || result.revised)) await queueProcessing(result.articleId, { db: tx });
        return result;
      });
      created += Number(saved.created);
      revised += Number(saved.revised);
    }
    const body = { checked: batch.length, ready: batch.length - missing, missing };
    const cursor = { ...(source.cursor ?? {}), initializedAt, lastCheckedAt: now.toISOString() };
    await sql`UPDATE sources SET cursor = ${sql.json(cursor)}, last_fetch_at = now(), last_ok_at = now(),
      health = 'ok', fail_count = 0, last_error = NULL,
      next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now() WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${items.length}, new_count = ${created},
      detail = ${sql.json({ reason, provider: "wechat2rss", body })} WHERE id = ${run!.id}`;
    return { sourceId, status: "ok" as const, found: items.length, created, revised, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wechat2RSS collection failed";
    await sql`UPDATE sources SET last_fetch_at = now(), fail_count = fail_count + 1, last_error = ${message},
      health = CASE WHEN fail_count + 1 >= 3 THEN 'failing' ELSE 'degraded' END,
      next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now() WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed" as const, error: message };
  }
}

/** One explicit attempt, including articles no longer in the recent feed. Never changes source health. */
export async function retryWechatBody(sourceId: string, articleId: string) {
  const [a] = await sql`SELECT a.* FROM articles a JOIN sources s ON s.id=${sourceId}
    WHERE a.id=${articleId} AND s.kind='mp_account' AND s.config->>'provider'='wechat2rss'
      AND (a.source_id=s.id OR EXISTS (SELECT 1 FROM article_discoveries d WHERE d.article_id=a.id AND d.source_id=s.id))`;
  if (!a) throw new Error("WeChat source article not found");
  if (a.content_discarded_at || a.managed_backfill_id) throw new Error("Article requires its retention/backfill workflow");
  if (await updateWechatBodyIssue(articleId)) return { articleId, status: "already_ready" as const };
  const at = new Date();
  let stage = "fetch_body";
  try {
    const body = await fetchWechatBody(a.url);
    stage = "save_repair";
    await repairWechatBody({ articleId, expectedHash: repairHash(a), bodyText: body.bodyText, bodyHtml: body.bodyHtml, evidence: "管理员重试：从同一微信原文地址读取并验证正文" },body.readingProof);
    return { articleId, status: "repaired" as const };
  } catch (error) {
    const message = bodyFailureMessage(error);
    const recovered = await updateWechatBodyIssue(articleId, { stage, message, at });
    return { articleId, status: recovered ? "already_ready" as const : "failed" as const, error: message };
  }
}
