import { sql } from "../db.ts";
import { attestWechatReadingLink } from "./wechat.ts";
import { resolveWechatMaterialIdentity } from "./wechat-link-registry.ts";

/** Explicit operator import. No network, body update, model rerun, or automatic alias replacement. */
export async function associateWechatReadingEvidence(input: {
  articleId?: string; identityKey?: string; observation: unknown; operator: string; apply?: boolean;
}) {
  if (Boolean(input.articleId) === Boolean(input.identityKey)) throw new Error("Specify exactly one article or material identity");
  return sql.begin(async tx => {
    // The existing authoritative owner is selected without rewriting its identity or URL.
    const [article] = input.articleId
      ? await tx`SELECT id,identity_key,url FROM articles WHERE id=${input.articleId}`
      : await tx`SELECT id,identity_key,url FROM articles WHERE identity_key=${input.identityKey!}`;
    let identityKey: string, sourceUrl: string;
    if (article) { identityKey = article.identity_key; sourceUrl = article.url; }
    else {
      if (!input.identityKey) throw new Error("Target article does not exist");
      identityKey = input.identityKey;
      const [document] = await tx`SELECT url FROM research_documents WHERE identity_key=${identityKey}`;
      const [material] = document ? [] : await tx`SELECT coalesce(material->>'url',preparation->'research'->>'url') AS url
        FROM backfill_items WHERE identity_key=${identityKey} ORDER BY updated_at DESC,run_id DESC LIMIT 1`;
      const url = document?.url ?? material?.url;
      if (!url) throw new Error("Target retained material has no indexed original URL");
      sourceUrl = String(url);
    }
    const proof = attestWechatReadingLink(input.observation,sourceUrl,input.operator);
    const owner = await resolveWechatMaterialIdentity(tx,sourceUrl,identityKey,proof,true,!input.apply);
    if (owner !== identityKey) throw new Error("Target is not the existing WeChat identity owner");
    const [saved] = await tx`SELECT reading_url,source_url,observed_at,evidence_source,evidence_hash,created_at
      FROM wechat_reading_links WHERE identity_key=${identityKey}`;
    if (input.apply && (!saved || saved.reading_url !== proof.readingUrl)) throw new Error("Reading-link readback failed");
    return { mode:input.apply ? "apply" as const : "dry-run" as const, status:input.apply ? "associated" : "validated",
      identityKey,articleId:article?.id ?? null,url:sourceUrl,readingUrl:proof.readingUrl,
      observedAt:saved ? new Date(saved.observed_at).toISOString() : proof.observedAt,
      evidenceSource:saved?.evidence_source ?? proof.evidenceSource,evidenceHash:saved?.evidence_hash ?? proof.evidenceHash,
      createdAt:saved ? new Date(saved.created_at).toISOString() : null };
  });
}
