// Restore upstream subscriptions from the industry pack; never recreate the live SQLite DB.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ConfigError, readSecrets } from "./configure.ts";

type Account = { id: string; enabled: boolean; kind: string; config: { provider?: string; bizId?: string; feedId?: string } };
type Subscription = { id: number; link: string; paused?: boolean };
export async function restore(accounts: Account[], base: string, token: string, apply: boolean) {
  const origin = new URL(base);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash || !token) throw new ConfigError("需要回环 HTTP origin 和 RSS_TOKEN。");
  async function api(endpoint: string) {
    const url = new URL(endpoint, origin); url.searchParams.set("k", token);
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error();
      const body = await response.json() as { err?: string; data: unknown; meta?: { total: number } };
      if (!body || typeof body !== "object" || body.err) throw new Error();
      return body;
    } catch { throw new ConfigError("Wechat2RSS API 未完成请求；检查服务、登录与 token。未输出认证 URL 或上游正文。"); }
  }
  const existing = new Map<string, Subscription>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    const body = await api(`/list?page=${page}&size=100`);
    if (!Array.isArray(body.data) || typeof body.meta?.total !== "number" || !Number.isSafeInteger(body.meta.total) || body.meta.total < 0 || body.meta.total > 10000) throw new ConfigError("订阅列表格式或总数异常，未开始恢复。");
    if (total !== undefined && total !== body.meta.total) throw new ConfigError("分页期间订阅总数变化，请重试；未开始恢复。");
    total = body.meta.total;
    for (const row of body.data) {
      if (!Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.link !== "string" || existing.has(String(row.id))) throw new ConfigError("订阅列表身份无效或分页重复，未开始恢复。");
      existing.set(String(row.id), row);
    }
    if (existing.size === total) break;
    if (existing.size > total! || !body.data.length) throw new ConfigError("订阅分页不完整，未开始恢复。");
  }
  const expected = accounts.filter((s) => s.kind === "mp_account" && s.config.provider === "wechat2rss" && s.enabled);
  if (!expected.length) throw new ConfigError("清单没有启用的 Wechat2RSS 账号；未验证任何订阅。");
  function check(account: Account, link: string) {
    let actual: string;
    try { actual = new URL(link).pathname; } catch { throw new ConfigError("上游订阅地址格式无效。"); }
    if (actual !== `/feed/${account.config.feedId}.xml`) throw new ConfigError(`账号 ${account.id} 的 feedId 不匹配；核查中央 RSS_SECRET 与 RSS_ENC_FEED_ID，不要改写账号身份。`);
  }
  for (const account of expected) {
    if (!/^\d+$/.test(String(account.config.bizId)) || !/^[a-zA-Z0-9_-]+$/.test(account.config.feedId || "")) throw new ConfigError("来源清单缺少有效 bizId/feedId。");
    const row = existing.get(String(account.config.bizId)); if (row) check(account, row.link);
  }
  const missing = expected.filter((s) => !existing.has(String(s.config.bizId)));
  if (missing.length && !apply) throw new ConfigError(`已核对 ${expected.length} 个账号，缺少 ${missing.length} 个上游订阅；确认登录后加 --apply 恢复缺项。`);
  let index = 0, added = 0, failed = false;
  // Requests only enqueue upstream refreshes; Wechat2RSS owns the WeChat refresh rate.
  const results = await Promise.allSettled(Array.from({ length: Math.min(8, missing.length) }, async () => {
    while (!failed && index < missing.length) {
      const account = missing[index++]!;
      try {
        const result = await api(`/add/${account.config.bizId}`);
        if (typeof result.data !== "string") throw new ConfigError("新增订阅未返回有效地址。");
        check(account, result.data); added++;
      } catch (e) { failed = true; throw e; }
    }
  }));
  const rejected = results.find((r) => r.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  return { checked: expected.length, added, paused: expected.filter((s) => existing.get(String(s.config.bizId))?.paused).length };
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { "service-env": { type: "string" }, sources: { type: "string" }, apply: { type: "boolean", default: false } } });
    const env = readSecrets(values["service-env"] || "/home/ubuntu/aihot/shared/wechat2rss/service.env");
    const sources = JSON.parse(fs.readFileSync(values.sources || fileURLToPath(new URL("../../industry/sources.json", import.meta.url)), "utf8")).sources;
    const result = await restore(sources, "http://127.0.0.1:18480", env.RSS_TOKEN || "", values.apply);
    console.log(`Wechat2RSS 已核对 ${result.checked} 个账号，新增 ${result.added} 个订阅，保留 ${result.paused} 个上游暂停状态。新增订阅的文章仍由上游异步抓取；请检查 AIHOT 来源运行记录。`);
  } catch (e) { console.error(e instanceof ConfigError ? e.message : "订阅恢复未完成；检查配置和来源清单。已添加的订阅保留，可重复运行补齐缺项。"); process.exitCode = 1; }
}
