import { sql } from "@aihot/backend/db";
import { credential } from "@aihot/backend/config";
import { ConfigError } from "./configure.ts";
import { insertAccount } from "./register-source.ts";
import { confirm, findAccount, type Account, type Identity } from "./onboard-source.ts";
import { listSubscriptions, upstreamApi } from "./restore-subscriptions.ts";

export async function applyAccount(sources: Account[], target: Identity, base: string, token: string) {
  const source = findAccount(sources, target);
  if (!source) throw new ConfigError("已部署清单没有目标账号；先 config、按项目流程发布并部署，再 apply。");
  if (credential("collectors", "WECHAT2RSS_BASE_URL") !== base || credential("collectors", "WECHAT2RSS_RSS_TOKEN") !== token || !token) throw new ConfigError("采集器配置与本次上游 origin/token 不一致或未配置；未修改信源。");
  const row = (await listSubscriptions(upstreamApi(base, token))).get(target.bizId);
  if (!row) throw new ConfigError("上游没有目标订阅；先用原回执续跑 prepare。未注册其他账号。");
  confirm(row, target, source.config.feedId);
  return sql.begin(async tx => {
    // Registration is rare; serialize with other source inserts, including the legacy bulk CLI.
    await tx`LOCK TABLE sources IN SHARE ROW EXCLUSIVE MODE`;
    const matches = await tx<Account[]>`SELECT * FROM sources WHERE id=${source.id} OR config->>'bizId'=${target.bizId} OR (config->>'provider'='wechat2rss' AND config->>'feedId'=${source.config.feedId})`;
    const existing = findAccount(matches, target, source.config.feedId, source.id);
    if (existing && existing.id !== source.id) throw new ConfigError("数据库同一公众号已使用另一来源 id；未新增重复来源。");
    if (!existing) {
      const inserted = await insertAccount(tx, source);
      if (inserted.length !== 1) throw new ConfigError("目标来源未插入；数据库已有冲突，请先检查 status。事务未提交。");
    }
    const [stored] = await tx`SELECT id,name,enabled,health,cursor,interval_minutes,site_fulltext,syndicate_fulltext FROM sources WHERE id=${source.id}`;
    return { inserted: !existing, upstream_paused: row.paused ?? null, database: stored, collection: "not_triggered" };
  });
}

export async function accountStatus(sources: Account[], target: Identity, base: string, token: string) {
  let configured: Account | undefined;
  let configuration: Record<string, unknown>;
  try {
    configured = findAccount(sources, target);
    configuration = configured ? { state: "present", source_id: configured.id, enabled: configured.enabled } : { state: "missing" };
  } catch { configuration = { state: "conflict" }; }
  let upstream: Record<string, unknown>;
  try {
    const row = (await listSubscriptions(upstreamApi(base, token))).get(target.bizId);
    if (!row) upstream = { state: "missing" };
    else {
      const id = confirm(row, target, configured?.config.feedId);
      upstream = { state: "subscribed", feed_id: id, paused: row.paused ?? null };
    }
  } catch (error) { upstream = { state: "unverified", reason: error instanceof ConfigError ? error.message : "上游查询失败" }; }
  let database: Record<string, unknown>;
  try {
    const matches = await sql<Account[]>`SELECT * FROM sources WHERE id=${configured?.id || `radar-mp-${target.bizId}`} OR config->>'bizId'=${target.bizId}`;
    const stored = findAccount(matches, target, configured?.config.feedId, configured?.id);
    if (!stored) database = { state: "missing", collection: "not_registered" };
    else if (configured && stored.id !== configured.id) database = { state: "conflict", collection: "unverified" };
    else {
      const [run] = await sql`SELECT id,started_at,finished_at,status,found_count,new_count FROM fetch_runs WHERE source_id=${stored.id} ORDER BY started_at DESC,id DESC LIMIT 1`;
      const [counts] = await sql`SELECT count(*)::int AS stored_articles, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM publications p WHERE p.article_id=a.id AND p.selected AND p.visibility='public'))::int AS selected_public_articles FROM articles a WHERE a.source_id=${stored.id}`;
      const [state] = await sql`SELECT id,enabled,health,cursor,last_fetch_at,last_ok_at,next_fetch_at FROM sources WHERE id=${stored.id}`;
      database = { state: "registered", source: state, latest_fetch: run ?? null, collection: !stored.enabled ? "paused" : !run ? "pending" : run.status === "ok" ? (run.new_count === 0 ? "ok_zero_new" : "ingested") : run.status, ...counts };
    }
  } catch (error) { database = { state: "unverified", reason: error instanceof ConfigError ? error.message : "数据库查询失败；未把未知计为零。" }; }
  return { configuration, upstream, database };
}
