// Dedicated retained-material reads. Public publication eligibility is deliberately not a filter.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import TurndownService from "turndown";
import { sql, type Db } from "../db.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { LEGACY_WECHAT_SOURCES } from "../publication/source-label.ts";
import { materialHash } from "../backfill/manifest.ts";
import { loadPreparation } from "../backfill/history-input.ts";
import { resolveSources, ResearchInputError } from "./catalog.ts";
import { readingLinkOwner } from "../content/wechat-link-registry.ts";

export { ResearchInputError } from "./catalog.ts";
export const documentId = (identity: string) => `doc_${createHash("sha256").update(identity).digest("hex")}`;
const like = (s: string) => `%${s.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
type Cursor = { query: string; until: string; stamp: string; after: string; id: string };
function sign(value: string, key: string) { return createHmac("sha256", key).update(value).digest("base64url"); }
function encode(value: Cursor, key: string) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${sign(payload, key)}`;
}
function decode(value: string | undefined, query: string, key: string): Cursor | null {
  if (!value) return null;
  try {
    const [payload, signature, extra] = value.split(".");
    const expected = sign(payload!, key);
    if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw Error();
    const c = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Cursor;
    if (c.query !== query || !Number.isFinite(Date.parse(c.until)) || typeof c.after !== "string" || typeof c.id !== "string") throw Error();
    return c;
  } catch { throw new ResearchInputError("invalid_cursor"); }
}
const iso = (value: Date | string | null): string | null => value == null ? null : new Date(value).toISOString();

// A restriction on any current article linked to this identity wins over older material copies.
const FROM = sql`FROM research_documents d
  LEFT JOIN wechat_reading_links reading ON reading.identity_key=d.identity_key
  LEFT JOIN publications p ON p.article_id=d.article_id AND p.revision=d.revision
  LEFT JOIN LATERAL (
    SELECT bool_or(o.visibility='withdrawn') AS denied, bool_or(o.visibility='summary-only') AS restricted
    FROM editorial_overrides o WHERE o.article_id=d.article_id OR o.article_id IN
      (SELECT b.article_id FROM backfill_items b WHERE b.identity_key=d.identity_key AND b.article_id IS NOT NULL)
  ) policy ON true
  LEFT JOIN LATERAL (
    SELECT min(s.id) AS id FROM sources s WHERE s.kind='mp_account' AND s.name=btrim(d.author)
      AND d.source_id = ANY(${sql.array(LEGACY_WECHAT_SOURCES)}) AND d.url ~* '^https?://mp[.]weixin[.]qq[.]com/' HAVING count(*)=1
  ) account ON true`;
const VISIBLE = sql`NOT coalesce(policy.denied,false)`;
const READABLE = sql`NOT coalesce(policy.restricted,false) AND NOT d.discarded`;
const COLUMNS = sql`d.id,d.identity_key,d.article_id,d.run_id,d.material_version,d.source_id,d.url,d.title,d.author,d.language,d.title_json,d.author_json,
  reading.reading_url,
  d.published_at,d.discovered_at,d.sort_at,d.first_indexed_at,d.updated_at,d.revision,d.content_hash,d.discarded,
  coalesce(account.id,d.source_id) AS account_id,coalesce(policy.restricted,false) AS restricted,
  p.title AS generated_title,p.summary,coalesce(p.selected,false) AS selected,
  CASE WHEN ${READABLE} THEN d.body_text END AS body_text,
  CASE WHEN ${READABLE} THEN d.body_json_text END AS body_json_text,
  CASE WHEN ${READABLE} THEN (nullif(d.body_text,'') IS NOT NULL OR nullif(d.body_html,'') IS NOT NULL
    OR d.body_json_text NOT IN ('""','null') OR d.body_json_html NOT IN ('""','null')) ELSE false END AS has_body`;
// Conservative snapshot marker: also changes for unrelated database writes, but never hides a
// committed restriction deletion/revision behind another row's later timestamp. No writer lock.
async function stamp(db: Db): Promise<string> {
  const [r] = await db`SELECT pg_current_snapshot()::text AS stamp`;
  return r!.stamp;
}
async function cutoff(db: Db): Promise<string> {
  const [r] = await db`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`;
  return r!.value;
}
type Row = Record<string, any>;
function summary(r: Row, terms: string[] = []) {
  const title = r.title_json ? JSON.parse(r.title_json) : r.title;
  const body = r.body_json_text ? JSON.parse(r.body_json_text) : r.body_text;
  const matches = terms.flatMap(term => ["title", "summary", "body_text"].flatMap(field => {
    const text = (field === "title" ? title : field === "body_text" ? body : r[field]) as string | null;
    const at = text?.toLowerCase().indexOf(term) ?? -1;
    return at < 0 ? [] : [{ field: field === "body_text" ? "body" : field, text: text!.slice(Math.max(0, at - 60), at + term.length + 120) }];
  }));
  return { id: r.id, articleId: r.article_id, origin: r.article_id ? "article" : "material",
    title, generatedTitle: r.generated_title ?? null, summary: r.summary ?? null,
    url: r.url, readingUrl: r.reading_url ?? null, author: r.author_json ? JSON.parse(r.author_json) : r.author, language: r.language, sourceId: r.account_id, collectionSourceId: r.source_id,
    publishedAt: iso(r.published_at), discoveredAt: iso(r.discovered_at), sortAt: iso(r.sort_at),
    indexedAt: iso(r.first_indexed_at), updatedAt: iso(r.updated_at),
    timeBasis: r.published_at ? "published" : "discovered", revision: r.revision,
    contentHash: r.restricted ? null : r.content_hash, selected: r.selected,
    bodyStatus: r.restricted ? "restricted" : r.discarded ? "discarded" : r.has_body ? "available" : "missing", matches };
}
export type ResearchQuery = { source?: string[]; group?: string[]; timeField?: "effective"|"published"|"discovered"|"updated"; q?: string; from?: string; to?: string; selected?: boolean; limit: number; cursor?: string };
export async function listArticles(db: Db, input: ResearchQuery, key: string) {
  const terms = (input.q ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length > 6) throw new ResearchInputError("too_many_terms");
  const sourceIds = await resolveSources(db,input.source,input.group);
  const timeField = input.timeField ?? "effective";
  const queryInfo = {sourceIds,timeField,from:input.from??null,to:input.to??null,q:input.q??null,selected:input.selected??null};
  const query = createHash("sha256").update(JSON.stringify([sourceIds,terms,queryInfo.from,queryInfo.to,queryInfo.selected,timeField])).digest("hex");
  const time = timeField==="published" ? sql`d.published_at` : timeField==="discovered" ? sql`d.discovered_at` : timeField==="updated" ? sql`d.updated_at` : sql`coalesce(d.published_at,d.discovered_at)`;
  // Keep the historical effective ordering fixed across material promotion and revisions.
  const order = timeField==="effective" ? sql`d.sort_at` : time;
  const cursor = decode(input.cursor, query, key);
  const currentStamp = await stamp(db);
  const until = cursor?.until ?? await cutoff(db);
  const condition = terms.reduce((acc, term) => sql`${acc} AND (lower(d.title) LIKE ${like(term)}
    OR lower(d.title_json) LIKE ${like(JSON.stringify(term).slice(1,-1))}
    OR lower(p.summary) LIKE ${like(term)} OR (${READABLE} AND (lower(coalesce(d.body_text,'')) LIKE ${like(term)}
      OR lower(coalesce(d.body_json_text,'')) LIKE ${like(JSON.stringify(term).slice(1,-1))})))`, sql``);
  // Explicit text casts preserve PostgreSQL microseconds: the driver's timestamp serializer uses
  // JS Date (milliseconds), which can omit an identity created just before the first page.
  const rows = await db`SELECT ${COLUMNS},${order}::text AS sort_cursor ${FROM} WHERE ${VISIBLE} AND d.first_indexed_at<=${until}::text::timestamptz
    AND ${order} IS NOT NULL
    ${sourceIds !== null ? sql`AND coalesce(account.id,d.source_id)=ANY(${sql.array(sourceIds)}::text[])` : sql``}
    ${input.from ? sql`AND ${time}>=${input.from}::text::timestamptz` : sql``}
    ${input.to ? sql`AND ${time}<${input.to}::text::timestamptz` : sql``}
    ${input.selected !== undefined ? sql`AND coalesce(p.selected,false)=${input.selected}` : sql``}
    ${condition} ${cursor ? sql`AND (${order},d.id)<(${cursor.after}::text::timestamptz,${cursor.id})` : sql``}
    ORDER BY ${order} DESC,d.id DESC LIMIT ${input.limit + 1}`;
  const page = rows.slice(0,input.limit), last = page.at(-1);
  // JSON scalar indexes are only candidates: escape sequences (e.g. \\n) are not original text.
  // Advance by consumed candidates even for an empty result page, so callers can finish traversal.
  const items = page.map(r => summary(r,terms)).filter(item => terms.every(term =>
    item.matches.some(match => match.text.toLowerCase().includes(term))));
  return { items, query:queryInfo, consistency: "live", asOf: until,
    changedSinceStart: !!cursor && cursor.stamp !== currentStamp,
    nextCursor: rows.length > input.limit && last ? encode({ query, until, stamp: cursor?.stamp ?? currentStamp, after: last.sort_cursor, id: last.id },key) : null };
}
export async function listSources(db: Db, input: { q?: string; kind?: string; limit: number; cursor?: string }, key: string) {
  const query = JSON.stringify(["sources",input.q ?? null,input.kind ?? null]);
  const cursor = decode(input.cursor,query,key), currentStamp = await stamp(db);
  const until = cursor?.until ?? await cutoff(db);
  const rows = await db`SELECT s.id,s.name,s.kind,
    ARRAY(SELECT alias FROM research_source_aliases a WHERE a.source_id=s.id ORDER BY alias) AS aliases,
    jsonb_build_object('enabled',s.enabled,'health',s.health,'lastSuccessAt',s.last_ok_at,'lastFetchAt',s.last_fetch_at,'nextFetchAt',s.next_fetch_at,
      'latestRun',(SELECT jsonb_build_object('startedAt',f.started_at,'finishedAt',f.finished_at,'status',f.status,
        'foundCount',CASE WHEN f.finished_at IS NOT NULL AND f.status='ok' THEN f.found_count END,
        'newCount',CASE WHEN f.finished_at IS NOT NULL AND f.status='ok' THEN f.new_count END)
        FROM fetch_runs f WHERE f.source_id=s.id ORDER BY f.started_at DESC,f.id DESC LIMIT 1)) AS collection
    FROM sources s WHERE s.created_at<=${until}::text::timestamptz
    ${input.q ? sql`AND (lower(s.name) LIKE ${like(input.q)} OR lower(s.id) LIKE ${like(input.q)} OR EXISTS(SELECT 1 FROM research_source_aliases a WHERE a.source_id=s.id AND lower(a.alias) LIKE ${like(input.q)}))` : sql``}
    ${input.kind ? sql`AND s.kind=${input.kind}` : sql``} ${cursor ? sql`AND s.id>${cursor.id}` : sql``}
    ORDER BY s.id LIMIT ${input.limit+1}`;
  const items = rows.slice(0,input.limit);
  return {items,consistency:"live",asOf:until,changedSinceStart:!!cursor && cursor.stamp!==currentStamp,
    nextCursor:rows.length>input.limit ? encode({query,until,stamp:cursor?.stamp??currentStamp,after:"",id:items.at(-1)!.id},key):null};
}
export async function readArticle(db: Db, id: string) {
  const [r] = await db`SELECT ${COLUMNS},CASE WHEN ${READABLE} THEN d.body_html END AS body_html,
    CASE WHEN ${READABLE} THEN d.body_json_html END AS body_json_html
    ${FROM} WHERE ${VISIBLE} AND (d.id=${id} OR d.article_id=${id}) LIMIT 1`;
  if (!r) return null;
  const item = summary(r);
  let completeness: { state: string; evidence: string | null } = {state:"unverified",evidence:null};
  const readable = item.bodyStatus === "available";
  if (readable) {
    const [b] = await db`SELECT b.*,run.scope FROM backfill_items b JOIN backfill_runs run ON run.id=b.run_id
      WHERE b.identity_key=${r.identity_key} AND b.content_discarded_at IS NULL
      AND ((${r.article_id === null} AND b.run_id=${r.run_id}) OR (b.article_id=${r.article_id} AND b.article_revision=${r.revision} AND b.article_hash=${r.content_hash}))
      ORDER BY b.updated_at DESC,b.run_id DESC LIMIT 1`;
    if (b) {
      completeness.evidence = b.evidence;
      try {
        const preparation = b.preparation ? loadPreparation(b.preparation) : null;
        const version = r.material_version ? preparation?.versions.find(v=>v.key===r.material_version) : null;
        const material = version?.material ?? b.material;
        const verified = r.material_version ? createHash("sha256").update(JSON.stringify(material)).digest("hex") === r.content_hash : materialHash(material) === b.content_hash;
        // selected alone is NOT proof: history preparation also selects unassessed originals.
        const approved = preparation?.versions.some(v => v.approved?.state === "complete" && v.approved.contentHash === materialHash(material));
        if (version?.approved) completeness.evidence = version.approved.evidence;
        if (verified && (approved || (b.scope === "approved" && b.reason !== "outside_range" && !["unverified","incomplete"].includes(b.reason)))) completeness.state = "complete";
        else if (verified && b.reason === "incomplete") completeness.state = "incomplete";
      } catch { /* Older material without a verifiable hash remains unverified. */ }
    }
  }
  const translations = readable && r.article_id ? await db`SELECT lang,title,body_text AS text,body_html AS html,complete,origin
    FROM translations WHERE article_id=${r.article_id} AND revision=${r.revision}` : [];
  return {...item,body:readable ? {text:r.body_json_text?JSON.parse(r.body_json_text):r.body_text,html:r.body_json_html?JSON.parse(r.body_json_html):r.body_html,truncated:false}:null,completeness,translations};
}
export async function resolveArticle(db: Db, url: string) {
  const identity = identityKeyForUrl(url,{keepFragment:true});
  if (!identity) throw new ResearchInputError("invalid_url");
  const canonical = identityKeyForUrl(url)!;
  for (const candidate of new Set([`url:${url.trim()}`,identity])) {
    if (candidate === canonical) continue;
    // A real fragment identity wins, including its restrictions; never fall through a denial.
    const [exists] = await db`SELECT 1 FROM research_documents WHERE identity_key=${candidate}`;
    if (exists) return readArticle(db,documentId(candidate));
  }
  const owner = await readingLinkOwner(url,db);
  return readArticle(db,documentId(owner ?? canonical));
}
export function articleMarkdown(item: NonNullable<Awaited<ReturnType<typeof readArticle>>>, preferReading = false) {
  const original = item.body?.text || (item.body?.html ? new TurndownService().turndown(item.body.html) : "");
  const url = preferReading ? item.readingUrl ?? item.url : item.url;
  const source = url !== item.url ? `\n\n采集地址: ${item.url}` : "";
  return `# ${item.title}\n\nID: ${item.id}\n\n原文: ${url}${source}\n\n来源: ${item.sourceId}\n\n正文状态: ${item.bodyStatus}；完整性: ${item.completeness.state}\n\n## 已存原文\n\n${original || "无可返回正文"}\n\n## 生成摘要\n\n${item.summary ?? "无"}\n`;
}
