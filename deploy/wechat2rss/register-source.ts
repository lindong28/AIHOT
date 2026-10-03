// Register the account-level sources from the industry pack without changing paused accounts.
// node --env-file=/path/app.env deploy/wechat2rss/register-source.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { credential, REPO_ROOT } from "@aihot/backend/config";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

if (!credential("collectors", "WECHAT2RSS_BASE_URL") || !credential("collectors", "WECHAT2RSS_RSS_TOKEN")) {
  throw new Error("请配置 WECHAT2RSS_BASE_URL 与 WECHAT2RSS_RSS_TOKEN；未修改信源。");
}
const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8"));
const accounts = sources.filter((s: { kind: string; config: { provider?: string } }) => s.kind === "mp_account" && s.config.provider === "wechat2rss");
try {
  await sql.begin(async (tx) => {
    for (const s of accounts) {
      assertSupportedConfig("mp_account", s.config);
      await tx`INSERT INTO sources (id, name, kind, config, tier, first_party, participation_mode, interval_minutes, enabled, site_fulltext, syndicate_fulltext, next_fetch_at)
        VALUES (${s.id}, ${s.name}, 'mp_account', ${tx.json(s.config)}, ${s.tier}, ${s.first_party}, ${s.participation_mode}, ${s.interval_minutes}, ${s.enabled}, false, false, now())
        ON CONFLICT (id) DO NOTHING`;
    }
  });
  console.log(`已登记 ${accounts.length} 个公众号来源（含原有项）；已有配置、启停状态与游标保留。尚未验证采集，请检查 worker 运行记录。`);
} finally {
  await closeDb();
}
