/** Reader-facing attribution. Collection ids remain the provenance and policy identity. */
export const LEGACY_WECHAT_SOURCES = ["archive-radar-wx-mp2rss", "archive-radar-wx-wechat2rss"];
const WECHAT_ARCHIVE = "archive-radar-wx-ai-assistant-kb-archive";
const HN_SOURCES = ["radar-buzzing-hn", "archive-radar-hn-ai"];

interface Source { id: string; name: string; kind: string }
interface Article { url: string; author?: string | null; x_post?: unknown }

export function sourceLabel(source: Source, article: Article, accountNames: readonly string[] = []): string {
  let url: URL | null = null;
  try { url = new URL(article.url); } catch { /* Invalid originals cannot establish a publisher. */ }
  const host = url?.hostname.replace(/^www\./, "") ?? "";
  const post = host === "x.com" || host === "twitter.com" ? url?.pathname.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:\/|$)/) : null;
  if (post && post[1]!.toLowerCase() !== "i") {
    const x = article.x_post as { handle?: string; tweetId?: string; authorName?: string } | null;
    const displayName = x?.handle?.toLowerCase() === post[1]!.toLowerCase() && x.tweetId === post[2] ? x.authorName?.trim() : null;
    const name = displayName?.toLowerCase() === `@${post[1]}`.toLowerCase() ? null : displayName;
    return `${name ? `${name.slice(0, 200)} (@${post[1]})` : `@${post[1]}`} · X`;
  }
  if (source.kind === "mp_account") return `${source.name} · 微信公众号`;
  if (LEGACY_WECHAT_SOURCES.includes(source.id) || source.id === WECHAT_ARCHIVE) {
    const author = article.author?.trim();
    const known = host === "mp.weixin.qq.com" && source.id !== WECHAT_ARCHIVE && author
      && accountNames.filter(n => n === author).length === 1;
    return known ? `${author} · 微信公众号` : "微信公众号（账号未识别）";
  }
  if (HN_SOURCES.includes(source.id)) return host && host !== "news.ycombinator.com" ? `${host}（经 Hacker News）` : "Hacker News";
  if (source.kind === "external" && source.name === source.id) return host || "外部来源（名称未提供）";
  return source.name;
}

/** RSS author normally means a writer; only known aggregate contracts get special treatment. */
export function publicAuthor(sourceId: string, author: string | null, label: string): string | null {
  if (HN_SOURCES.includes(sourceId) || LEGACY_WECHAT_SOURCES.includes(sourceId) || sourceId === WECHAT_ARCHIVE) return null;
  return author && label !== `${author} · 微信公众号` ? author : null;
}
