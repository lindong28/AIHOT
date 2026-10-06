// Navigation identity is separate from collection/policy identity. These expressions use s, p, a
// from the public read layer, so counts, filtering and card links cannot resolve different owners.
import { sql } from "../db.ts";
import { LEGACY_WECHAT_SOURCES } from "./source-label.ts";

export const HN_SOURCE = sql`s.id IN ('radar-buzzing-hn', 'archive-radar-hn-ai')`;
const legacyWechatIds: string[] = [...LEGACY_WECHAT_SOURCES, "archive-radar-wx-ai-assistant-kb-archive"];
const legacyWechat = sql`s.id IN ${sql(legacyWechatIds)}`;
const developer = sql`coalesce(s.config->>'url', s.config->>'feedUrl', '') ~* '^https?://(api[.])?github[.]com/'
  OR (s.kind IN ('json_list', 'web_list') AND coalesce(s.config->>'url', '') ~* '^https?://huggingface[.]co/(api/|papers|models|datasets|spaces)')`;
const sourceKey = sql`replace(replace(replace(replace(replace(s.id, '%', '%25'), '/', '%2F'), '?', '%3F'), '#', '%23'), ' ', '%20')`;
const configuredHandle = sql`lower(substring(s.config->>'query' from '(?i)^from:([a-z0-9_]{1,15})(?: -filter:replies)?$'))`;
// Most publications are not X posts. Keep the full URL validation, but only run that regex
// for matching hosts; source directories otherwise repeat it across every public article.
const postHandle = sql`CASE WHEN lower(split_part(p.url, '/', 3)) IN ('x.com', 'www.x.com', 'twitter.com', 'www.twitter.com')
  THEN nullif(lower(substring(p.url from '(?i)^https?://(?:www[.])?(?:x[.]com|twitter[.]com)/([a-z0-9_]{1,15})/status/[0-9]+(?:[/?#]|$)')), 'i') END`;

/** Configured sources, including accounts that have no public article yet. */
export const SOURCE_HOME_PATH = sql`CASE
  WHEN s.kind = 'mp_account' THEN '/sources/wechat/' || ${sourceKey}
  WHEN ${legacyWechat} THEN '/sources/wechat'
  WHEN ${HN_SOURCE} THEN '/sources/hacker-news'
  WHEN s.kind = 'x_search' THEN '/sources/x' || coalesce('/' || ${configuredHandle}, '')
  WHEN ${developer} THEN '/sources/developers/' || ${sourceKey}
  ELSE '/sources/websites/' || ${sourceKey} END`;

/** Article URL wins for X (a monitored account can retweet another account). */
export const SOURCE_PATH = sql`CASE
  WHEN ${postHandle} IS NOT NULL THEN '/sources/x/' || ${postHandle}
  WHEN s.id IN ${sql(LEGACY_WECHAT_SOURCES)} THEN '/sources/wechat' || coalesce('/' || (
    SELECT replace(replace(replace(replace(replace(min(ms.id), '%', '%25'), '/', '%2F'), '?', '%3F'), '#', '%23'), ' ', '%20')
    FROM sources ms WHERE ms.kind = 'mp_account' AND ms.participation_mode <> 'isolated'
      AND ms.name = btrim(a.author) AND p.url ~* '^https?://mp[.]weixin[.]qq[.]com/' HAVING count(*) = 1
  ), '')
  ELSE ${SOURCE_HOME_PATH} END`;
