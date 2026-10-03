// The existing Wechat2RSS instance supplies a separate RSS feed for each official account.
import { credential } from "../config.ts";
import { sql } from "../db.ts";
import { upsertMaterial } from "../content/materials.ts";
import { queueProcessing } from "../jobs/content.ts";
import { parseRss } from "./rss.ts";
import type { SourceRow } from "./types.ts";

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
      throw new Error("http");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body!) {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("size");
      chunks.push(chunk);
    }
    xml = Buffer.concat(chunks).toString("utf8");
  } catch {
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
    bodyStatus: item.bodyText ? "ok" as const : "none" as const,
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
    for (const item of candidates.slice(0, source.cursor?.initializedAt ? 50 : 8)) {
      const saved = await upsertMaterial({ ...item, sourceId, via: "fetch",
        backfill: item.publishedAt!.getTime() <= Date.parse(initializedAt) ? "first-import" : null });
      created += Number(saved.created);
      revised += Number(saved.revised);
      if (saved.created || saved.revised) await queueProcessing(saved.articleId);
    }
    const cursor = { ...(source.cursor ?? {}), initializedAt, lastCheckedAt: now.toISOString() };
    await sql`UPDATE sources SET cursor = ${sql.json(cursor)}, last_fetch_at = now(), last_ok_at = now(),
      health = 'ok', fail_count = 0, last_error = NULL,
      next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now() WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${items.length}, new_count = ${created} WHERE id = ${run!.id}`;
    return { sourceId, status: "ok" as const, found: items.length, created, revised };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wechat2RSS collection failed";
    await sql`UPDATE sources SET last_fetch_at = now(), fail_count = fail_count + 1, last_error = ${message},
      health = CASE WHEN fail_count + 1 >= 3 THEN 'failing' ELSE 'degraded' END, updated_at = now() WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed" as const, error: message };
  }
}
