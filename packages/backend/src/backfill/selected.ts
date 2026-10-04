// Explicit operator-selected material uses the native queues, receipts and publication rules.
import { z } from "zod";
import { sql, type Db } from "../db.ts";
import { manifestEntry, materialHash, entryIdentity } from "./manifest.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { upsertMaterial } from "../content/materials.ts";
import { queueProcessing } from "../jobs/content.ts";
import { topicMatchTags, type TopicRow } from "../publication/topics.ts";
import { selectedCondition } from "../publication/items.ts";

const selectedEntry = manifestEntry.extend({ submittedUrl: z.url().optional() });
type Entry = z.infer<typeof selectedEntry>;

export function validateSelected(input: unknown[]): Entry[] {
  if (!input.length) throw new Error("指定文章清单不能为空");
  const seen = new Set<string>();
  return input.map((value) => {
    const e = selectedEntry.parse(value);
    const key = entryIdentity(e);
    if (e.quality.state !== "complete" || materialHash(e.material) !== e.quality.contentHash) throw new Error("原文未确认完整或 contentHash 不匹配");
    if (!e.material.bodyText.trim() || !e.material.title.trim()) throw new Error("标题和正文不能为空");
    const url = new URL(e.material.url);
    if (url.hostname === "mp.weixin.qq.com" && (url.pathname !== "/s" || ["__biz", "mid", "idx", "sn"].some((p) => !url.searchParams.get(p)))) {
      throw new Error("微信原文必须使用包含 __biz/mid/idx/sn 的规范长链接；短链接放在 submittedUrl");
    }
    if (e.submittedUrl && !identityKeyForUrl(e.submittedUrl)) throw new Error("submittedUrl 必须为 HTTP(S) 链接");
    if (seen.has(key)) throw new Error("清单中存在重复文章身份");
    seen.add(key);
    return e;
  });
}

async function existing(e: Entry, db: Db) {
  const keys = [...new Set([entryIdentity(e), ...(e.submittedUrl ? [identityKeyForUrl(e.submittedUrl)!] : [])])];
  const urls = [e.material.url, ...(e.submittedUrl ? [e.submittedUrl] : [])];
  const rows = await db<{ id: string }[]>`SELECT id FROM articles WHERE identity_key = ANY(${keys}::text[]) OR url = ANY(${urls}::text[])`;
  if (rows.length > 1) throw new Error("规范链接与提交链接匹配到多篇文章；请先核对既有重复数据");
  return rows[0]?.id ?? null;
}

/** Validates the whole list first; each new article and its job commit together. No model calls here. */
export async function importSelected(input: unknown[], apply = false) {
  const entries = validateSelected(input);
  const sourceIds = [...new Set(entries.map((e) => e.material.sourceId))];
  const sources = await sql<{ id: string }[]>`SELECT id FROM sources WHERE id=ANY(${sourceIds}::text[]) AND participation_mode='editorial'`;
  if (sources.length !== sourceIds.length) throw new Error("清单包含未登记或非 editorial 来源");
  const results = [];
  for (const e of entries) {
    const result = apply ? await sql.begin(async (tx) => {
      // Serialise this entrypoint's retries; native identity uniqueness also covers collectors.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${entryIdentity(e)},0))`;
      const id = await existing(e, tx);
      if (id) return { articleId: id, action: "existing" as const };
      const m = await upsertMaterial({ ...e.material, publishedAt: new Date(e.material.publishedAt),
        via: "import", bodyStatus: "ok", insertOnly: true, backfill: "user-request" }, tx);
      if (!m.created) return { articleId: m.articleId, action: "existing" as const };
      const jobId = await queueProcessing(m.articleId, { db: tx });
      if (!jobId) throw new Error("新文章未能入队，本条事务已回滚");
      return { articleId: m.articleId, action: "queued" as const };
    }) : { articleId: await existing(e, sql), action: "preview" as const };
    results.push({ url: e.material.url, submittedUrl: e.submittedUrl ?? e.material.url, title: e.material.title, ...result });
  }
  return results;
}

/** Read current persisted results; absence of an analysis is not a negative AI judgement. */
export async function selectedStatus(input: unknown[]) {
  const entries = validateSelected(input);
  const topics = await sql<TopicRow[]>`SELECT * FROM topics ORDER BY position`;
  const results = [];
  for (const e of entries) {
    const id = await existing(e, sql);
    const [row] = id ? await sql`
      SELECT a.id,a.title,a.revision,a.processing_state,a.processing_error,a.backfill,
        a.content_discarded_at,n.relevance,n.category,n.tags,n.subjects,n.score,n.selected,n.reason_zh,
        p.eligible AS published_eligible,p.selected AS published_selected,p.visibility,p.tags AS published_tags,
        (${selectedCondition(new Date())}) AS publicly_selected
      FROM articles a LEFT JOIN LATERAL (SELECT * FROM analyses WHERE article_id=a.id
        AND input_revision=a.revision ORDER BY created_at DESC,id DESC LIMIT 1) n ON true
      LEFT JOIN publications p ON p.article_id=a.id WHERE a.id=${id}` : [];
    const matched = topics.filter((t) => topicMatchTags(t).some((tag) => (row?.tags ?? []).includes(tag)))
      .map((t) => ({ slug: t.slug, name: t.name }));
    const published = row?.publicly_selected ? topics.filter((t) => topicMatchTags(t).some((tag) => (row.published_tags ?? []).includes(tag)))
      .map((t) => ({ slug: t.slug, name: t.name })) : [];
    results.push({ url: e.material.url, submittedUrl: e.submittedUrl ?? e.material.url, title: e.material.title,
      article: row ?? null, matchedTopics: matched, publishedTopics: published });
  }
  return results;
}
