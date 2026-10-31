import { sql, type Db, type Tx } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { appendLedger, v1Payload } from "./publish.ts";

/** Public query fragment; use where publications is aliased as p. Raw stored URL is retained. */
export const VERIFIED_READING_URL = sql`(SELECT l.reading_url FROM articles ra
  JOIN wechat_reading_links l ON l.identity_key=ra.identity_key WHERE ra.id=p.article_id)`;
export const PUBLIC_READING_URL = sql`coalesce(${VERIFIED_READING_URL},p.url)`;

/** A link-only update appends a snapshot; it never rejudges, notifies, or rewrites older snapshots. */
export async function refreshReadingLinkLedger(db: Db, identityKey: string): Promise<void> {
  const [a] = await db`SELECT id FROM articles WHERE identity_key=${identityKey} FOR UPDATE`;
  if (!a) return;
  const [p] = await db`SELECT p.*,coalesce(p.source_label,s.name) AS source_name,l.reading_url
    FROM publications p JOIN sources s ON s.id=p.source_id
    JOIN wechat_reading_links l ON l.identity_key=${identityKey}
    WHERE p.article_id=${a.id} FOR UPDATE OF p`;
  if (!p || !p.selected || p.visibility !== "public") return;
  const payload = v1Payload({ articleId:p.article_id,title:p.title,originalTitle:p.original_title,summary:p.summary,
    sourceName:p.source_name,url:p.reading_url,publishedAt:p.published_at,discoveredAt:p.discovered_at,
    category:p.category,score:p.score,selected:true,reason:p.reason });
  const hash = sha256(stableJson(payload));
  const [state] = await db`SELECT in_set,payload_hash FROM selected_state WHERE article_id=${a.id}`;
  if (state?.in_set && state.payload_hash === hash) return;
  const now = new Date(), visibleAt = p.visible_after && p.visible_after > now ? p.visible_after : now;
  const seq = await appendLedger(db as Tx,a.id,"upsert",payload,visibleAt,now);
  await db`INSERT INTO selected_state(article_id,in_set,payload_hash,last_seq) VALUES(${a.id},true,${hash},${seq})
    ON CONFLICT(article_id) DO UPDATE SET in_set=true,payload_hash=EXCLUDED.payload_hash,last_seq=EXCLUDED.last_seq`;
}
