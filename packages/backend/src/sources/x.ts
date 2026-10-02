// X accounts via SocialData search ("from:handle -filter:replies", newest first). Plain account queries
// are read together, about two dozen accounts per search (planXShards); SocialData bills returned objects.
import { searchTweets, tweetMedia, tweetText, type SdArticle, type SdTweet } from "../providers/socialdata.ts";
import { BudgetExceededError, ProviderRejectedError } from "../providers/receipts.ts";
import type { XPostData } from "../content/materials.ts";
import { sha256 } from "../lib/ids.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

function avatar(url: string | undefined): string | null {
  // Larger avatar than the default 48px thumbnail.
  return url ? url.replace("_normal.", "_bigger.") : null;
}

export function toXPost(t: SdTweet): XPostData {
  const q = t.quoted_status ?? null;
  return {
    tweetId: t.id_str,
    authorName: t.user.name,
    handle: t.user.screen_name,
    avatarUrl: avatar(t.user.profile_image_url_https),
    text: tweetText(t),
    lang: t.lang ?? null,
    replyTo: t.in_reply_to_status_id_str ?? null,
    media: tweetMedia(t),
    quoted: q
      ? { authorName: q.user.name, handle: q.user.screen_name, text: tweetText(q), url: `https://x.com/${q.user.screen_name}/status/${q.id_str}`, media: tweetMedia(q) }
      : null,
  };
}

const X_ARTICLE_LINK = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+/gi;

/** The post links an X Article (long-form text posted on X): its body is fetched before judging. */
export function linksXArticle(text: string | null | undefined): boolean {
  return new RegExp(X_ARTICLE_LINK.source, "i").test(text ?? "");
}

/** Nothing but the article's link: without the article there is nothing to judge (under 30 characters left). */
export function onlyXArticleLink(text: string | null | undefined): boolean {
  return linksXArticle(text) && (text ?? "").replace(X_ARTICLE_LINK, "").trim().length < 30;
}

/** An X Article as plain text with Markdown-like headings, quotes and list marks; media blocks are left out. */
export function xArticleText(article: SdArticle): { title: string; text: string } | null {
  const lines: string[] = [];
  for (const b of article.content_state?.blocks ?? []) {
    const text = (b.text ?? "").trim();
    if (!text || b.type === "atomic") continue;
    const mark = { "header-one": "# ", "header-two": "## ", "header-three": "### ", blockquote: "> ", "unordered-list-item": "- ", "ordered-list-item": "1. " }[b.type ?? ""] ?? "";
    lines.push(mark + text);
  }
  const text = lines.join("\n\n").trim();
  return text ? { title: (article.title ?? "").trim(), text } : null;
}

export function tweetToCandidate(t: SdTweet): Candidate {
  const post = toXPost(t);
  const firstLine = post.text.split("\n").find((l) => l.trim()) ?? post.text;
  return {
    url: `https://x.com/${t.user.screen_name}/status/${t.id_str}`,
    identityKey: `x:${t.id_str}`,
    title: firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine,
    author: t.user.screen_name,
    language: t.lang ?? null,
    publishedAt: new Date(t.tweet_created_at),
    bodyText: [post.text, post.quoted ? `\n\n【引用 @${post.quoted.handle}】${post.quoted.text}` : ""].join("").trim(),
    // A linked X Article is the post's real body: extraction fetches it (jobs/content.ts route).
    bodyStatus: linksXArticle(post.text) ? "pending" : "ok",
    xPost: post,
    media: post.media ?? [],
    raw: { favorite: t.favorite_count ?? null, retweet: t.retweet_count ?? null, views: t.views_count ?? null },
  };
}

/** Half-hour receipt window: a retried fetch in the same window reuses the paid response. */
function windowKey(now = Date.now()): string {
  return new Date(Math.floor(now / 1_800_000) * 1_800_000).toISOString();
}

/** Pages of new posts read per run after a watermark; a longer search continues in later runs. */
const MAX_PAGES = 2;
/** Pages per run spent on older stretches left over from earlier runs. */
const MAX_BACKLOG_PAGES = 2;

/** Where a newest-first search stopped at the page limit: the same query continues from `next`. */
export interface XBacklog {
  query: string;
  next: string | null;
  window?: string;
  maxId?: string;
  error?: string;
  initialRemaining?: number;
}

export interface XRead {
  tweets: SdTweet[];
  lastId: string | null;
  /** Stretches still to read, oldest first (kept in the source cursor). */
  backlog: XBacklog[];
  pages: number;
  /** The new-post search stopped at the page limit; the rest joined the backlog. */
  truncated: boolean;
  backlogPages: number;
  /** Legacy run-counter field; unfinished stretches are now retained, so this stays zero. */
  dropped: number;
  retryAfterSeconds?: number;
  checkedAt: string;
}

export type XCheckpoint = (tweets: SdTweet[], state: Pick<XRead, "lastId" | "backlog">) => Promise<void>;

export interface XFetch extends Omit<XRead, "tweets"> {
  candidates: Candidate[];
}

/**
 * New posts since the watermark. The search is bounded by since_id, so every further page holds older
 * posts that are still new to us. A search longer than one run's pages (a long outage) moves the
 * watermark to the newest post and keeps its position; later runs read on from there until it reaches
 * the old watermark, so nothing in between is skipped. Without a watermark (a source's very first
 * fetch) one page is read: its import is bounded anyway.
 */
export async function readXSearch(base: string, opts: { lastId: string | null; backlog: XBacklog[]; subject: string; type?: "Latest" | "Top"; checkpoint?: XCheckpoint; purpose?: string; initialPages?: number; maxPages?: number; maxBacklogPages?: number; window?: string }): Promise<XRead> {
  const { lastId } = opts;
  const backlog = opts.backlog.map((b) => ({ ...b }));
  const all: SdTweet[] = [];
  const query = lastId ? `${base} since_id:${lastId}` : base;
  let fresh = backlog.find((b) => b.query === query && !b.error);
  if (!fresh) {
    fresh = { query, next: null, window: opts.window ?? windowKey(), ...(!lastId ? { initialRemaining: opts.initialPages ?? 1 } : {}) };
    backlog.push(fresh);
  }
  let maxId = lastId;
  let pages = 0;
  let backlogPages = 0;
  let backlogAttempts = 0;
  let retryAfterSeconds: number | undefined;
  const checkpoint = async (tweets: SdTweet[] = []) => opts.checkpoint?.(tweets, { lastId: maxId, backlog });
  // Persist identity before dispatch; restart recovery reuses the paid receipt even in a new bucket.
  for (const b of backlog) b.window ??= windowKey();
  await checkpoint();
  const older = backlog.filter((b) => b !== fresh && !b.error);
  for (const stretch of [fresh, ...older]) {
    const isFresh = stretch === fresh;
    let used = 0;
    while (backlog.includes(stretch) && (isFresh ? used < (opts.maxPages ?? MAX_PAGES) : backlogAttempts < (opts.maxBacklogPages ?? MAX_BACKLOG_PAGES))) {
      let res: Awaited<ReturnType<typeof searchTweets>>;
      used++;
      if (!isFresh) backlogAttempts++;
      try {
        res = await searchTweets(stretch.query, { purpose: opts.purpose ?? "source_fetch", subject: opts.subject,
          window: stretch.window!, type: opts.type ?? "Latest", cursor: stretch.next });
      } catch (error) {
        if (error instanceof ProviderRejectedError && (error.status === 400 || error.status === 422) && stretch.next) {
          if (stretch.maxId && (opts.type ?? "Latest") === "Latest") {
            stretch.query = `${stretch.query.replace(/\s+max_id:\d+/g, "")} max_id:${stretch.maxId}`;
            stretch.next = null;
          } else stretch.error = "cursor rejected; no saved chronological ID boundary";
          await checkpoint();
        }
        if (error instanceof BudgetExceededError) retryAfterSeconds = error.retryAfterSeconds;
        if (pages + backlogPages === 0 && isFresh) throw error;
        break;
      }
      if (isFresh) pages++; else backlogPages++;
      all.push(...res.tweets);
      for (const t of res.tweets) if (!maxId || BigInt(t.id_str) > BigInt(maxId)) maxId = t.id_str;
      const lowest = res.tweets.reduce<string | undefined>((m, t) => !m || BigInt(t.id_str) < BigInt(m) ? t.id_str : m, undefined);
      if (stretch.initialRemaining !== undefined) stretch.initialRemaining--;
      if (!res.tweets.length || stretch.initialRemaining === 0) backlog.splice(backlog.indexOf(stretch), 1);
      else if (!res.nextCursor && res.tweets.length >= 20 && lowest !== stretch.maxId && (opts.type ?? "Latest") === "Latest") {
        stretch.query = `${stretch.query.replace(/\s+max_id:\d+/g, "")} max_id:${lowest}`;
        stretch.next = null;
        stretch.maxId = lowest;
      }
      else if (!res.nextCursor) backlog.splice(backlog.indexOf(stretch), 1);
      else {
        stretch.next = res.nextCursor;
        stretch.maxId = lowest;
      }
      // Store this page before advancing its cursor. A failed save leaves the previous identity.
      await checkpoint(res.tweets.filter((t) => !t.retweeted_status));
    }
    if (retryAfterSeconds || backlogAttempts >= (opts.maxBacklogPages ?? MAX_BACKLOG_PAGES)) break;
  }

  const seen = new Set<string>();
  const tweets = all.filter((t) => !t.retweeted_status && !seen.has(t.id_str) && !!seen.add(t.id_str));
  return { tweets, lastId: maxId, backlog, pages, truncated: backlog.length > 0, backlogPages, dropped: 0, retryAfterSeconds, checkedAt: fresh.window! };
}

/** One account's own search (its first fetch, a query of its own, or a manual run from the admin). */
export async function fetchXSearch(source: SourceRow, checkpoint?: XCheckpoint): Promise<XFetch> {
  const base = String(source.config.query ?? "");
  if (!base) throw new FetchError("query missing");
  const { tweets, ...read } = await readXSearch(base, {
    lastId: source.cursor?.lastTweetId ?? null,
    backlog: Array.isArray(source.cursor?.xBacklog) ? source.cursor.xBacklog : [],
    subject: `source:${source.id}`,
    type: source.config.searchType ?? "Latest",
    checkpoint,
  });
  return { candidates: tweets.map(tweetToCandidate), ...read };
}

// --- Shards: plain account queries read together ------------------------------------------------

/** A query that can share a search: exactly "from:handle -filter:replies", newest first. */
const SHARDABLE = /^from:([A-Za-z0-9_]{1,15}) -filter:replies$/i;
/** The same test in SQL, for the schedulers. */
export const SHARDABLE_SQL = "^from:[A-Za-z0-9_]{1,15} -filter:replies$";
/** Leave room under 512 characters for both since_id and a recovery max_id boundary. */
const SHARD_QUERY_MAX = 440;
const SHARD_MAX_ACCOUNTS = 24;

/** The account a source reads, when it can share a search: a plain query and a watermark already set. */
export function shardHandle(s: Pick<SourceRow, "kind" | "config" | "cursor">): string | null {
  if (s.kind !== "x_search" || (s.config.searchType ?? "Latest") !== "Latest" || !s.cursor?.lastTweetId) return null;
  return SHARDABLE.exec(String(s.config.query ?? ""))?.[1] ?? null;
}

export function shardQuery(handles: string[]): string {
  return `(${handles.map((h) => `from:${h}`).join(" OR ")}) -filter:replies`;
}

export interface XShard {
  key: string;
  mode: string;
  sourceIds: string[];
}

/**
 * Accounts that can share a search, per participation mode, in a stable order (by source id) and
 * packed into queries under the length limit. The same sources give the same shards, so a shard's
 * accounts stay together between runs; a source added or removed shifts only the shards after it.
 */
export function planXShards(sources: Array<Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "participation_mode">>): XShard[] {
  const byMode = new Map<string, Array<{ id: string; handle: string }>>();
  for (const s of sources) {
    const handle = shardHandle(s);
    if (handle) byMode.set(s.participation_mode, [...(byMode.get(s.participation_mode) ?? []), { id: s.id, handle }]);
  }
  const shards: XShard[] = [];
  for (const [mode, list] of [...byMode].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let current: typeof list = [];
    const close = () => {
      if (current.length) shards.push({ mode, sourceIds: current.map((c) => c.id), key: `${mode}:${sha256(current.map((c) => c.id).join(",")).slice(0, 12)}` });
      current = [];
    };
    for (const s of list) {
      if (current.length >= SHARD_MAX_ACCOUNTS || shardQuery([...current, s].map((c) => c.handle)).length > SHARD_QUERY_MAX) close();
      current.push(s);
    }
    close();
  }
  return shards;
}
