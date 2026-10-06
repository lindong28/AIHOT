import type { NewsScope, PublicSource, SourceDirectory, SourceGroup, SourcePage } from "@aihot/contracts/site";
import { sql } from "../db.ts";
import { proxiedImage } from "../media/imgproxy.ts";
import { ITEM_COLUMNS, ITEM_FROM, listedCondition, toFeedItemSummary, type ItemRow } from "./items.ts";
import { HN_SOURCE, SOURCE_HOME_PATH, SOURCE_PATH } from "./source-path.ts";

const GROUPS = [
  ["wechat", "微信公众号", "按公众号阅读文章与观点"],
  ["x", "X", "关注 AI 研究者、开发者与机构的动态"],
  ["hacker-news", "Hacker News", "来自 Hacker News 的 AI 新闻与讨论"],
  ["websites", "网站与博客", "媒体报道、公司博客与研究文章"],
  ["developers", "开发者平台", "项目更新、模型与开源社区动态"],
] as const;
const PAGE_SIZE = 40;
const publicWhere = (now: Date) => sql`${listedCondition(now)} AND p.eligible AND s.participation_mode = 'editorial'`;
type RegistryRow = { name: string; href: string; enabled: boolean; icon_url: string | null; public_url: string | null };
type CountRow = { href: string; total: number; name: string };

function identifier(href: string, url: string | null): string | null {
  if (href.startsWith('/sources/x/')) return '@' + href.split('/')[3];
  if (!href.startsWith('/sources/websites/') && !href.startsWith('/sources/developers/')) return null;
  try {
    const u = new URL(url ?? '');
    if (!['https:', 'http:'].includes(u.protocol)) return null;
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}

/** The registry is authoritative for active zero-item accounts; publications supply historical ones. */
export async function loadSourceDirectory(now = new Date(), tab: NewsScope = 'all'): Promise<SourceDirectory> {
  const where = sql`${publicWhere(now)} ${tab === 'selected' ? sql`AND p.selected` : sql``}`;
  const [registry, counts, hn] = await Promise.all([
    sql<RegistryRow[]>`SELECT s.name, ${SOURCE_HOME_PATH} AS href, s.enabled, s.icon_url,
      coalesce(s.config->>'url', s.config->>'feedUrl') AS public_url
      FROM sources s WHERE s.participation_mode <> 'isolated' ORDER BY s.enabled DESC, s.id`,
    sql<CountRow[]>`SELECT ${SOURCE_PATH} AS href, count(*) AS total, min(coalesce(p.source_label, s.name)) AS name
      FROM publications p JOIN sources s ON s.id = p.source_id JOIN articles a ON a.id = p.article_id
      WHERE ${where} GROUP BY 1`,
    sql<{ total: number }[]>`SELECT count(*) AS total FROM publications p JOIN sources s ON s.id = p.source_id
      WHERE ${where} AND ${HN_SOURCE}`,
  ]);
  const accounts = new Map<string, PublicSource>();
  for (const row of registry) {
    if (row.href.split('/').length !== 4) continue;
    if (!accounts.has(row.href)) accounts.set(row.href, {
      name: row.name, href: row.href, identifier: identifier(row.href, row.public_url),
      iconUrl: proxiedImage(row.icon_url, 'avatar'), active: row.enabled, total: 0,
    });
  }
  for (const row of counts) {
    if (row.href.split('/').length !== 4) continue;
    const account = accounts.get(row.href);
    if (account) account.total = Number(row.total);
    else accounts.set(row.href, {
      name: row.name.replace(/ · (X|微信公众号)$/, ''), href: row.href,
      identifier: identifier(row.href, null), iconUrl: null, active: false, total: Number(row.total),
    });
  }
  const groups: SourceGroup[] = GROUPS.map(([key, name, description]) => {
    const href = `/sources/${key}`;
    return {
      key, name, description, href,
      total: key === 'hacker-news' ? Number(hn[0]!.total) : counts.filter(r => r.href === href || r.href.startsWith(href + '/')).reduce((n, r) => n + Number(r.total), 0),
      accounts: [...accounts.values()].filter(a => a.href.startsWith(href + '/') && (a.active || a.total > 0))
        .sort((a, b) => Number(b.active) - Number(a.active) || b.total - a.total || a.name.localeCompare(b.name, 'zh-CN')),
    };
  });
  return { groups };
}

export async function loadSourcePage(groupKey: string, key: string | null, tab: 'all' | 'selected', page: number, now = new Date()): Promise<SourcePage | null> {
  if (!GROUPS.some(([g]) => g === groupKey)) return null;
  const directory = await loadSourceDirectory(now, tab);
  const group = directory.groups.find(g => g.key === groupKey)!;
  const path = key ? `${group.href}/${encodeURIComponent(key)}` : group.href;
  let source = key ? group.accounts.find(a => a.href === path) : null;
  if (key && !source) {
    // A readable noindex detail can outlive both collection and list eligibility. Its source link
    // still gets an empty source page; this does not admit that article to any public list.
    const [registered] = await sql<RegistryRow[]>`SELECT s.name, ${SOURCE_HOME_PATH} AS href, s.enabled, s.icon_url,
      coalesce(s.config->>'url', s.config->>'feedUrl') AS public_url FROM sources s
      WHERE s.participation_mode <> 'isolated' AND ${SOURCE_HOME_PATH} = ${path} ORDER BY s.enabled DESC, s.id LIMIT 1`;
    if (registered) source = { name: registered.name, href: path, identifier: identifier(path, registered.public_url), iconUrl: proxiedImage(registered.icon_url, 'avatar'), active: registered.enabled, total: 0 };
    else {
      const [historical] = await sql<{ name: string }[]>`SELECT coalesce(p.source_label, s.name) AS name
        FROM publications p JOIN sources s ON s.id = p.source_id JOIN articles a ON a.id = p.article_id
        WHERE p.visibility <> 'withdrawn' AND s.participation_mode = 'editorial' AND ${SOURCE_PATH} = ${path} LIMIT 1`;
      if (historical) source = { name: historical.name.replace(/ · (X|微信公众号)$/, ''), href: path, identifier: identifier(path, null), iconUrl: null, active: false, total: 0 };
    }
    if (!source) return null;
  }
  const membership = key ? sql`${SOURCE_PATH} = ${path}` : groupKey === 'hacker-news' ? HN_SOURCE
    : sql`split_part(${SOURCE_PATH}, '/', 3) = ${groupKey}`;
  const where = sql`${publicWhere(now)} AND ${membership}
    ${groupKey !== 'x' && groupKey !== 'hacker-news' ? sql`AND split_part(${SOURCE_HOME_PATH}, '/', 3) = ${groupKey}` : sql``}
    ${tab === 'selected' ? sql`AND p.selected` : sql``}`;
  // The directory already counted this exact scope, including the selected filter.
  // Non-X/HN categories can first filter the small source registry: only X URLs
  // override that category, and the full membership check still excludes those articles.
  const total = (source ?? group).total;
  const pageCount = Math.max(1, Math.ceil(Number(total) / PAGE_SIZE));
  if (page > pageCount) return null;
  const rows = await sql<ItemRow[]>`SELECT ${ITEM_COLUMNS} ${ITEM_FROM} WHERE ${where}
    ORDER BY p.timeline_at DESC, p.article_id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
  return { group, source: source ?? null, items: rows.map(toFeedItemSummary), total: Number(total), page, pageCount, tab };
}
