// Explicit, replay-safe repairs. Frozen imports and paid receipts remain immutable.
import { z } from "zod";
import { updateWechatBodyIssue } from "./wechat-body-issues.ts";
import { sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { contentHash } from "./materials.ts";
import { sanitizeBody } from "./sanitize.ts";
import { WECHAT_ARCHIVE_SOURCES, wechatBodyIssue } from "./wechat.ts";
import { publishArticleTx, republishSource } from "../publication/publish.ts";
import { queueProcessing } from "../jobs/content.ts";
import { materialHash, manifestEntry } from "../backfill/manifest.ts";
import { resolveWechatMaterialIdentity } from "./wechat-link-registry.ts";
import type { WechatReadingProof } from "./wechat.ts";

export const repairSchema = z.object({ articleId: z.string().min(1), expectedHash: z.string().length(64),
  bodyText: z.string(), bodyHtml: z.string().nullable(), evidence: z.string().min(1) }).strict();
export type WechatRepair = z.infer<typeof repairSchema>;
export function repairHash(a: Record<string, any>): string {
  return sha256(stableJson({ id: a.id, sourceId: a.source_id, revision: a.revision, bodyText: a.body_text,
    bodyHtml: a.body_html, bodyStatus: a.body_status, managedBackfillId: a.managed_backfill_id }));
}
export async function auditWechatBodies() {
  const rows = await sql`SELECT a.id,a.source_id,a.url,a.title,a.revision,a.body_text,a.body_html,a.body_status,a.managed_backfill_id,
    s.site_fulltext,p.body_mode FROM articles a JOIN sources s ON s.id=a.source_id LEFT JOIN publications p ON p.article_id=a.id
    WHERE s.kind='mp_account' OR s.id IN ${sql(WECHAT_ARCHIVE_SOURCES)} ORDER BY a.id`;
  const gaps = rows.map(a => ({ articleId: a.id, url: a.url, title: a.title, expectedHash: repairHash(a),
    issue: wechatBodyIssue(a.body_text,a.body_html) ?? (!a.body_html ? "text_only" : a.body_status !== "ok" ? "unconfirmed" : null) })).filter(a => a.issue);
  return { checkedAt: new Date().toISOString(), total: rows.length, siteDisabled: rows.filter(a => !a.site_fulltext).length, gaps };
}

/** Rebuilds existing projections, never analyzes or changes a source's enabled/cursor/syndication. */
export async function enableWechatFulltext() {
  const sources = await sql`SELECT id FROM sources WHERE kind='mp_account' OR id IN ${sql(WECHAT_ARCHIVE_SOURCES)} ORDER BY id`;
  let changed = 0, rebuilt = 0, index = 0;
  await Promise.all(Array.from({ length: Math.min(8, sources.length) }, async () => {
    while (index < sources.length) {
      const id = sources[index++]!.id;
      const sourceChanged = await sql.begin(async tx => {
        const [s] = await tx`SELECT site_fulltext FROM sources WHERE id=${id} FOR UPDATE`;
        if (s!.site_fulltext) return 0;
        await tx`INSERT INTO audit_log(actor,action,subject,before,after) VALUES('wechat-repair','source.fulltext',${'source:'+id},${tx.json({site_fulltext:false})},${tx.json({site_fulltext:true})})`;
        await tx`UPDATE sources SET site_fulltext=true,updated_at=now() WHERE id=${id}`;
        return 1;
      });
      changed += sourceChanged;
      const published = await republishSource(id);
      rebuilt += published.total;
    }
  }));
  return { sources: sources.length, changed, rebuilt };
}

export async function repairWechatBody(input: unknown, readingProof?: WechatReadingProof) {
  const r = repairSchema.parse(input);
  const bodyHtml = r.bodyHtml ? sanitizeBody(r.bodyHtml) : null;
  if (wechatBodyIssue(r.bodyText,bodyHtml)) throw new Error("Repair has no usable article body");
  const key = sha256(stableJson(r));
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'wechat-repair:'+r.articleId}))`;
    if (readingProof) {
      const [target] = await tx`SELECT url,identity_key FROM articles WHERE id=${r.articleId}`;
      if (!target || await resolveWechatMaterialIdentity(tx,target.url,target.identity_key,readingProof) !== target.identity_key) {
        throw new Error("Reading-link owner changed; audit again");
      }
    }
    const [old] = await tx`SELECT after FROM audit_log WHERE action='wechat.body_repair' AND request_id=${key}`;
    if (old) return { ...old.after, reused: true };
    const [initial] = await tx`SELECT managed_backfill_id FROM articles WHERE id=${r.articleId}`;
    if (initial?.managed_backfill_id) {
      const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext(${'backfill:'+initial.managed_backfill_id})) AS locked`;
      if (!lock!.locked) throw new Error("Original backfill executor is active");
    }
    const [a] = await tx`SELECT a.*,s.kind,
      EXISTS (SELECT 1 FROM article_discoveries d JOIN sources ds ON ds.id=d.source_id
        WHERE d.article_id=a.id AND ds.kind='mp_account' AND ds.config->>'provider'='wechat2rss') AS wechat_discovery
      FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${r.articleId} FOR UPDATE OF a`;
    if (!a || !(a.kind==='mp_account' || WECHAT_ARCHIVE_SOURCES.includes(a.source_id) || a.wechat_discovery)) throw new Error("Not a WeChat source article");
    if (a.managed_backfill_id !== initial?.managed_backfill_id || repairHash(a)!==r.expectedHash) throw new Error("Article changed since the repair snapshot; audit again");
    const [overridden] = await tx`SELECT 1 FROM editorial_overrides WHERE article_id=${a.id}`;
    if (overridden) throw new Error("Article has editorial overrides; review them before repair");
    const textChanged = a.body_text !== r.bodyText;
    let runId: string | null = null;
    let hash = a.content_hash;
    let revision = a.revision;
    if (textChanged) {
      revision++;
      hash = contentHash({title:a.title,bodyText:r.bodyText,excerpt:a.excerpt});
      if (a.managed_backfill_id) {
        const [original] = await tx`SELECT * FROM backfill_runs WHERE id=${a.managed_backfill_id} FOR UPDATE`;
        if (!original || !["complete","needs_attention","paused"].includes(original.state) || !original.models) throw new Error("Original batch must be inactive and have model bindings");
        const [active] = await tx`SELECT 1 FROM backfill_items WHERE run_id=${original.id} AND state='running' LIMIT 1`;
        if (active) throw new Error("Original batch has an unsettled running item");
        if (!a.published_at) throw new Error("Managed repair requires the original publication date");
        const material = manifestEntry.shape.material.parse({sourceId:a.source_id,url:a.url,title:a.title,author:a.author,language:a.language,
          publishedAt:a.published_at.toISOString(),excerpt:a.excerpt,bodyText:r.bodyText,bodyHtml,media:a.media});
        runId = 'wechat-repair-' + key.slice(0,32);
        const day = a.published_at.toISOString().slice(0,10);
        await tx`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,models,scope)
          VALUES(${runId},${'公众号正文修复 '+a.id},${key},${day},${day},${tx.json(original.models)},'approved')`;
        await tx`INSERT INTO backfill_items(run_id,identity_key,day,material,content_hash,evidence,state,article_id,article_revision,article_hash)
          VALUES(${runId},${a.identity_key},${day},${tx.json(material)},${materialHash(material)},${r.evidence},'pending',${a.id},${revision},${hash})`;
      }
      await tx`INSERT INTO article_revisions(article_id,revision,content_hash,material_hash,title,body_text)
        VALUES(${a.id},${revision},${hash},${hash},${a.title},${r.bodyText})`;
      // Explicitly supersede stale business output until the repaired revision is analyzed.
      await tx`INSERT INTO analyses(article_id,input_revision,origin,relevance,selected,output)
        VALUES(${a.id},${revision},'rule','unknown',false,${tx.json({reason:'wechat_body_repaired_awaiting_analysis'})})`;
    }
    await tx`UPDATE articles SET body_text=${r.bodyText},body_html=${bodyHtml},body_status='ok',revision=${revision},content_hash=${hash},
      managed_backfill_id=${runId ?? a.managed_backfill_id},
      processing_state=CASE WHEN ${textChanged} THEN 'new' ELSE processing_state END,
      processing_error=CASE WHEN ${textChanged} THEN NULL ELSE processing_error END,
      processing_attempts=CASE WHEN ${textChanged} THEN 0 ELSE processing_attempts END,
      processing_retry_at=CASE WHEN ${textChanged} THEN NULL ELSE processing_retry_at END,
      processing_queued_at=CASE WHEN ${textChanged} THEN NULL ELSE processing_queued_at END,
      updated_at=now() WHERE id=${a.id}`;
    await updateWechatBodyIssue(a.id, undefined, tx);
    await publishArticleTx(tx,a.id);
    if (textChanged && !runId) await queueProcessing(a.id,{db:tx});
    const after = { articleId:a.id,revision,textChanged,runId,bodyText:r.bodyText,bodyHtml,evidence:r.evidence };
    await tx`INSERT INTO audit_log(actor,action,subject,before,after,request_id)
      VALUES('wechat-repair','wechat.body_repair',${'article:'+a.id},${tx.json({revision:a.revision,bodyText:a.body_text,bodyHtml:a.body_html,bodyStatus:a.body_status,managedBackfillId:a.managed_backfill_id})},${tx.json(after)},${key})`;
    return { articleId:a.id,revision,textChanged,runId,reused:false };
  });
}
