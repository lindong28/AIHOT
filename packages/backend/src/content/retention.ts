// Content retention is separate from paid-request retention. Receipts remain auditable.
import { sql, type Db } from "../db.ts";
import { loadPreparation, storePreparation } from "../backfill/history-input.ts";

const LEGACY_WECHAT = new Set(["archive-radar-wx-mp2rss", "archive-radar-wx-wechat2rss"]);
export function wechatOrigin(sourceId: string | undefined, kind: string | undefined, url: unknown): boolean {
  if (kind === "mp_account" || LEGACY_WECHAT.has(sourceId ?? "")) return true;
  try { return new URL(String(url)).hostname.toLowerCase() === "mp.weixin.qq.com"; } catch { return false; }
}

/** Called only after a completed business decision, never merely because publication is absent. */
export async function discardFilteredContent(articleId: string, db?: Db): Promise<boolean> {
  if (!db) return sql.begin(tx => discardFilteredContent(articleId, tx)) as Promise<boolean>;
  const [a] = await db`SELECT a.id,a.source_id,a.url,a.revision,a.processing_state,a.content_discarded_at,
    a.content_discard_after,a.backfill,a.published_at,a.discovered_at,s.kind,s.participation_mode FROM articles a JOIN sources s ON s.id=a.source_id
    WHERE a.id=${articleId} FOR UPDATE OF a`;
  if (!a || a.content_discarded_at || wechatOrigin(a.source_id, a.kind, a.url)) return false;
  const [wechat] = await db`SELECT 1 FROM article_discoveries d JOIN sources s ON s.id=d.source_id
    WHERE d.article_id=${articleId} AND (s.kind='mp_account' OR s.id IN ('archive-radar-wx-mp2rss','archive-radar-wx-wechat2rss')) LIMIT 1`;
  if (wechat) return false;
  const [p] = await db`SELECT eligible FROM publications WHERE article_id=${articleId}`;
  if (!p || p.eligible) return false;
  const [analysis] = await db`SELECT relevance FROM analyses WHERE article_id=${articleId} AND input_revision=${a.revision} ORDER BY id DESC LIMIT 1`;
  if (a.participation_mode === "editorial") {
    if (!["blocked", "analyzed"].includes(a.processing_state) || !["block", "unknown"].includes(analysis?.relevance)) return false;
  } else {
    if (a.processing_state !== "skipped") return false;
    const historical = a.backfill && (!a.published_at || a.discovered_at.getTime() - a.published_at.getTime() > 48 * 3600_000);
    if (a.participation_mode === "hot_signal" && !historical) {
      const [signal] = await db`SELECT 1 FROM story_signals WHERE article_id=${articleId} LIMIT 1`;
      if (!signal && (!a.content_discard_after || a.content_discard_after > new Date())) return false;
    }
  }
  // Unsettled paid requests still need their input for reconciliation/recovery.
  const [unsettled] = await db`SELECT 1 FROM receipts WHERE (subject=${'article:' + articleId}
    OR starts_with(subject,${'article:' + articleId + '@'}) OR starts_with(subject,${'article:' + articleId + ':'}))
    AND status IN ('pending','received','unknown') LIMIT 1`;
  if (unsettled) return false;
  await db`UPDATE articles SET title='',author=NULL,excerpt=NULL,body_text=NULL,body_html=NULL,raw=NULL,
    x_post=NULL,x_article=NULL,media='[]',body_status='none',content_discarded_at=now(),content_discard_after=NULL WHERE id=${articleId}`;
  await db`UPDATE article_revisions SET title='',body_text=NULL WHERE article_id=${articleId}`;
  await db`DELETE FROM translations WHERE article_id=${articleId}`;
  await db`UPDATE analyses SET title_zh=NULL,summary_zh=NULL,reason_zh=NULL,
    output=jsonb_strip_nulls(jsonb_build_object('identityGuard',CASE WHEN output ? 'identityGuard'
      THEN jsonb_build_object('outcome',output#>'{identityGuard,outcome}') END)),tags='{}',subjects='{}' WHERE article_id=${articleId}`;
  await db`UPDATE publications SET title='',original_title=NULL,summary=NULL,reason=NULL,tags='{}',search_text='',
    visibility='withdrawn',eligible=false,selected=false,indexable=false,body_mode='summary',syndicate=false WHERE article_id=${articleId}`;
  await db`DELETE FROM pool_search WHERE article_id=${articleId}`;
  await db`DELETE FROM embeddings WHERE kind='article' AND ref_id=${articleId}`;
  return true;
}

/** Terminal preparation may never have created an article. Keep provenance/decisions, not raw copies. */
export async function discardBackfillContent(runId: string, key: string): Promise<boolean> {
  return sql.begin(async db => {
    const [i] = await db`SELECT * FROM backfill_items WHERE run_id=${runId} AND identity_key=${key} FOR UPDATE`;
    if (!i || i.state !== "filtered" || i.content_discarded_at) return false;
    const p = i.preparation ? loadPreparation(i.preparation) : null;
    const materials = [i.material, ...(p?.versions.map(v => v.material) ?? [])].filter(Boolean);
    const sources = await db`SELECT id,kind FROM sources WHERE id IN ${db(materials.length ? materials.map(m => String(m.sourceId ?? "")) : [""])}`;
    if (materials.some(m => wechatOrigin(m.sourceId, sources.find(s => s.id === m.sourceId)?.kind, m.url))) return false;
    if (p?.versions.some(v => wechatOrigin(String(v.provenance.sourceId ?? ""), String(v.provenance.sourceKind ?? ""), v.provenance.url)
      || v.targetUrls.some(url => wechatOrigin(undefined, undefined, url))
      || wechatOrigin(undefined, v.prefilter?.row.article?.source?.kind, v.prefilter?.row.article?.url))) return false;
    // No article: only the all-versions settled BLOCK path is a content decision.
    if (!i.article_id && (!p || !p.versions.length || p.versions.some(v => p.results[v.key]?.prefilter?.label !== "BLOCK"))) return false;
    const receiptIds = Object.values(p?.results ?? {}).map(r => r.prefilter?.receiptId).filter(id => id != null);
    if (receiptIds.length) {
      const [unsettled] = await db`SELECT 1 FROM receipts WHERE id IN ${db(receiptIds)} AND status<>'completed' LIMIT 1`;
      if (unsettled) return false;
    }
    if (i.article_id) {
      const cleared = await discardFilteredContent(i.article_id, db);
      const [a] = await db`SELECT content_discarded_at FROM articles WHERE id=${i.article_id}`;
      if (!cleared && !a?.content_discarded_at) return false;
    }
    if (p) {
      for (const v of p.versions) {
        v.material = null; v.prefilter = null; v.context = {};
        const r = p.results[v.key];
        if (r) p.results[v.key] = { prefilter: r.prefilter ? { label: r.prefilter.label, receiptId: r.prefilter.receiptId } : undefined };
      }
    }
    await db`UPDATE backfill_items SET material='{}',preparation=${p ? db.json(storePreparation(p)) : null},content_discarded_at=now()
      WHERE run_id=${runId} AND identity_key=${key}`;
    return true;
  }) as Promise<boolean>;
}

/** Only new processing paths arm this deadline; existing historical content is not swept. */
export async function discardExpiredSignals() {
  const due = await sql`SELECT id FROM articles WHERE content_discarded_at IS NULL AND content_discard_after<=now() ORDER BY content_discard_after`;
  let discarded = 0;
  // Bound database work, without serialising independent articles.
  for (let i = 0; i < due.length; i += 4) {
    const results = await Promise.all(due.slice(i, i + 4).map(a => discardFilteredContent(a.id)));
    discarded += results.filter(Boolean).length;
  }
  return discarded;
}
