// Configure the existing native RSS collector; keep the authenticated URL out of Git.
// DATABASE_URL=... node deploy/wechat2rss/register-source.ts /absolute/path/service.env
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";

const file = process.argv[2];
if (!file) throw new Error("请指定 Wechat2RSS 私有 service.env 文件；未修改信源。");
const token = parseEnv(readFileSync(file, "utf8")).RSS_TOKEN;
if (!token?.trim()) throw new Error("Wechat2RSS RSS_TOKEN 未配置；未修改信源。");
const feed = new URL("http://127.0.0.1:18480/feed/all.xml");
feed.searchParams.set("k", token);
try {
  const config = { feedUrl: feed.toString(), _aihot: { initialBackfillLimit: 8 } };
  await sql`INSERT INTO sources (id, name, kind, config, tier, first_party, participation_mode, interval_minutes, enabled, site_fulltext, syndicate_fulltext, next_fetch_at)
    VALUES ('radar-wechat2rss', '微信公众号（Wechat2RSS）', 'rss', ${sql.json(config)}, 'T1_5', false, 'editorial', 15, true, false, false, now())
    ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`;
  console.log("Wechat2RSS 已登记为原生 RSS 信源；保留已有启停状态与游标。尚未验证采集，未启动自动任务。");
} finally {
  await closeDb();
}
