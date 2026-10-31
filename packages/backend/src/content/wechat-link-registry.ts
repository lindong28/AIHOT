import { sql, type Db } from "../db.ts";
import { identityKeyForUrl, normalizeUrl } from "../lib/url.ts";
import { assertWechatReadingProof, wechatArticleUrl, type WechatReadingProof } from "./wechat.ts";
import { refreshReadingLinkLedger } from "../publication/reading-links.ts";

/** Read-only alias lookup. Fragment precedence belongs to the caller (private research resolve). */
export async function readingLinkOwner(url: string, db: Db = sql): Promise<string | null> {
  if (!wechatArticleUrl(url)) return null;
  const key = identityKeyForUrl(url)!;
  const [row] = await db`SELECT identity_key FROM wechat_reading_links
    WHERE identity_key=${key} OR canonical_identity=${key} OR reading_url=${normalizeUrl(url)!}`;
  return row ? String(row.identity_key) : null;
}

/** Called inside the material transaction, before any article/backfill row lock or insertion. */
export async function resolveWechatMaterialIdentity(db: Db, url: string, fallback: string, proof?: WechatReadingProof, waitForLocks = true, preview = false): Promise<string> {
  if (proof) {
    assertWechatReadingProof(proof);
    if (proof.sourceUrl !== url) throw new Error("Reading evidence belongs to another source URL");
  }
  if (!wechatArticleUrl(url)) {
    if (proof) throw new Error("Reading evidence is not a WeChat article");
    return fallback;
  }
  const key = identityKeyForUrl(url)!;
  // A collector that explicitly preserves a fragment owns a separate document.
  // Parent-page evidence and aliases must not collapse that identity.
  if (fallback !== key && fallback === identityKeyForUrl(url,{keepFragment:true})) return fallback;
  // A known mapping is immutable. Include its canonical lock so registration and both URL forms serialize.
  const [known] = await db`SELECT canonical_identity,reading_url FROM wechat_reading_links
    WHERE identity_key=${fallback} OR canonical_identity=${key} OR reading_url=${normalizeUrl(url)!}`;
  const keys = [...new Set([key, fallback, ...(proof ? [proof.canonicalIdentity,identityKeyForUrl(proof.readingUrl)!] : []),
    ...(known ? [String(known.canonical_identity),identityKeyForUrl(known.reading_url)!] : [])])].sort();
  for (const lock of keys) {
    if (waitForLocks) await db`SELECT pg_advisory_xact_lock(hashtextextended(${'wechat-identity:'+lock},0))`;
    else {
      const [result] = await db`SELECT pg_try_advisory_xact_lock(hashtextextended(${'wechat-identity:'+lock},0)) AS locked`;
      if (!result?.locked) throw new Error("Another WeChat identity writer is active; retry the frozen import later");
    }
  }
  const mappings = await db`SELECT * FROM wechat_reading_links WHERE identity_key IN ${db(keys)}
    OR canonical_identity IN ${db(keys)} OR reading_url=${proof?.readingUrl ?? normalizeUrl(url)!}`;
  if (!proof) {
    const owners = new Set(mappings.map(r => String(r.identity_key)));
    if (owners.size > 1) throw new Error("Conflicting WeChat identity owners");
    return owners.values().next().value ?? fallback;
  }
  const existing = await db`SELECT identity_key FROM articles WHERE identity_key IN ${db(keys)}
    UNION SELECT identity_key FROM research_documents WHERE identity_key IN ${db(keys)}
    UNION SELECT identity_key FROM backfill_items WHERE identity_key IN ${db(keys)}`;
  const owners = new Set([...mappings.map(r => String(r.identity_key)),...existing.map(r => String(r.identity_key))]);
  if (owners.size > 1) throw new Error("WeChat URLs already have different owners; manual review required");
  const identityKey = owners.values().next().value ?? proof.canonicalIdentity;
  if (mappings.some(r => r.identity_key !== identityKey || r.canonical_identity !== proof.canonicalIdentity || r.reading_url !== proof.readingUrl)) {
    throw new Error("Conflicting WeChat reading link; existing evidence was retained");
  }
  if (!mappings.length && !preview) {
    await db`INSERT INTO wechat_reading_links(identity_key,canonical_identity,reading_url,source_url,page_url,observed_at,evidence_source,evidence_hash)
      VALUES(${identityKey},${proof.canonicalIdentity},${proof.readingUrl},${proof.sourceUrl},${proof.pageUrl},${proof.observedAt},${proof.evidenceSource},${proof.evidenceHash})`;
    await refreshReadingLinkLedger(db,identityKey);
  }
  return identityKey;
}

/** Frozen manifests keep their original identity; a known alias of another owner must be reviewed. */
export async function assertWechatFrozenIdentity(db: Db, url: string, identity: string): Promise<void> {
  // A batch retains earlier entry locks. Fail instead of waiting on a reverse-ordered writer.
  if (await resolveWechatMaterialIdentity(db,url,identity,undefined,false) !== identity) {
    throw new Error("Frozen manifest URL is a verified alias of another identity; prepare it against the existing owner");
  }
}
