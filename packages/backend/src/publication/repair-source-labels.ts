import { sql } from "../db.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { displayTags } from "./rules.ts";
import { appendLedger, v1Payload } from "./publish.ts";
import { sourceLabel } from "./source-label.ts";

export async function sourceLabelCandidates(after = "", limit = 250) {
  const [rows, accounts] = await Promise.all([
    sql`SELECT p.article_id, p.source_label, a.url, a.author, a.x_post, s.id, s.name, s.kind
        FROM publications p JOIN articles a ON a.id=p.article_id JOIN sources s ON s.id=p.source_id
        WHERE p.article_id > ${after} ORDER BY p.article_id LIMIT ${limit}`,
    sql<{ name: string }[]>`SELECT name FROM sources WHERE kind='mp_account'`,
  ]);
  return rows.map(r => ({ articleId: String(r.article_id), sourceId: String(r.id),
    before: String(r.source_label ?? r.name),
    after: sourceLabel({ id: r.id, name: r.name, kind: r.kind }, { url: r.url, author: r.author, x_post: r.x_post }, accounts.map(a => a.name)),
  }));
}

/** Correct attribution only; never rejudge, release, enqueue a notification or change licences. */
export async function repairSourceLabel(articleId: string): Promise<boolean> {
  return sql.begin(async tx => {
    // Same lock order as publishArticleTx: a concurrent publication cannot restore an older label.
    const [a] = await tx`SELECT * FROM articles WHERE id=${articleId} FOR UPDATE`;
    if (!a) return false;
    const [p] = await tx`SELECT * FROM publications WHERE article_id=${articleId} FOR UPDATE`;
    if (!p) return false;
    const [s] = await tx`SELECT id,name,kind FROM sources WHERE id=${p.source_id}`;
    if (!s) return false;
    const accounts = await tx<{ name: string }[]>`SELECT name FROM sources WHERE kind='mp_account'`;
    const label = sourceLabel({ id: s.id, name: s.name, kind: s.kind }, { url: a.url, author: a.author, x_post: a.x_post }, accounts.map(a => a.name));
    if (label === (p.source_label ?? s.name)) return false;
    const [analysis] = await tx`SELECT subjects FROM analyses WHERE article_id=${articleId} ORDER BY input_revision DESC,id DESC LIMIT 1`;
    const search = collapseWhitespace([p.title, p.original_title, p.summary, label,
      ...displayTags(p.tags), ...(analysis?.subjects ?? [])].filter(Boolean).join(" ")).toLowerCase();
    await tx`UPDATE publications SET source_label=${label}, search_text=${search}, revision=revision+1, updated_at=now() WHERE article_id=${articleId}`;
    await tx`UPDATE pool_search SET direct=${search} WHERE article_id=${articleId}`;
    if (p.selected && p.visibility === "public") {
      const payload = v1Payload({ articleId, title: p.title, originalTitle: p.original_title, summary: p.summary, sourceName: label,
        url: p.url, publishedAt: p.published_at, discoveredAt: p.discovered_at, category: p.category, score: p.score, selected: true, reason: p.reason });
      const hash = sha256(stableJson(payload));
      const [state] = await tx`SELECT in_set,payload_hash FROM selected_state WHERE article_id=${articleId}`;
      if (!state?.in_set || state.payload_hash !== hash) {
        const now = new Date(), at = p.visible_after && p.visible_after > now ? p.visible_after : now;
        const seq = await appendLedger(tx, articleId, "upsert", payload, at, now);
        await tx`INSERT INTO selected_state(article_id,in_set,payload_hash,last_seq) VALUES(${articleId},true,${hash},${seq})
          ON CONFLICT(article_id) DO UPDATE SET in_set=true,payload_hash=EXCLUDED.payload_hash,last_seq=EXCLUDED.last_seq`;
      }
    }
    return true;
  });
}

/** Only citation metadata changes. Report prose, dates and original links remain frozen. */
export function repairCitationLabels(value: unknown, labels: ReadonlyMap<string, string>): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((n, child) => n + repairCitationLabels(child, labels), 0);
  const item = value as Record<string, any>;
  let changed = 0;
  const label = typeof item.itemId === "string" ? labels.get(item.itemId) : undefined;
  if (label && "sourceName" in item && item.sourceName !== label) { item.sourceName = label; changed++; }
  if (label && item.source && typeof item.source === "object" && "name" in item.source && item.source.name !== label) { item.source.name = label; changed++; }
  return changed + Object.values(item).reduce<number>((n, child) => n + repairCitationLabels(child, labels), 0);
}

export async function repairReportSourceLabels(apply: boolean): Promise<number> {
  const labels = new Map((await sql`SELECT article_id,source_label FROM publications WHERE source_label IS NOT NULL`).map(r => [String(r.article_id), String(r.source_label)]));
  const reports = await sql`SELECT kind,key FROM reports ORDER BY kind,key`;
  let count = 0;
  for (const report of reports) {
    count += await sql.begin(async tx => {
      const [row] = await tx`SELECT id,revision,content,generated_at FROM reports WHERE kind=${report.kind} AND key=${report.key} FOR UPDATE`;
      if (!row) return 0;
      const original = structuredClone(row.content);
      if (!repairCitationLabels(row.content, labels)) return 0;
      if (apply) {
        await tx`INSERT INTO report_revisions(report_id,revision,content,generated_at,reason)
          VALUES(${row.id},${row.revision},${tx.json(original)},${row.generated_at},'source-label-repair') ON CONFLICT DO NOTHING`;
        await tx`UPDATE reports SET content=${tx.json(row.content)},revision=revision+1,updated_at=now() WHERE id=${row.id}`;
      }
      return 1;
    });
  }
  return count;
}
