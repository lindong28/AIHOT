// Single-account onboarding. No git, deployment, refresh of existing accounts or collection.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ConfigError, readSecrets } from "./configure.ts";
import { listSubscriptions, upstreamApi, type Subscription } from "./restore-subscriptions.ts";

export type Identity = { name: string; bizId: string };
export type Receipt = Identity & { version: 1; phase: "add_pending" | "subscribed"; feedId?: string; paused?: boolean };
export type Account = { name: string; id: string; kind: string; config: { provider: string; bizId: string; feedId: string }; tier: string; first_party: boolean; participation_mode: string; interval_minutes: number; enabled: boolean; site_fulltext: boolean; syndicate_fulltext: boolean };
export function identity(name: unknown, bizId: unknown): Identity {
  if (typeof name !== "string" || !name.trim() || name !== name.trim() || /[\x00-\x1f]/.test(name) || typeof bizId !== "string" || !/^[1-9]\d{0,15}$/.test(bizId) || !Number.isSafeInteger(Number(bizId))) throw new ConfigError("需要已核实的公众号名称与十进制 bizId。");
  return { name, bizId };
}
export function feedId(link: string): string {
  try {
    const url = new URL(link);
    const match = /^\/feed\/([a-zA-Z0-9_-]+)\.xml$/.exec(url.pathname);
    if (!/^https?:$/.test(url.protocol) || !match || url.username || url.password || url.hash) throw new Error();
    return match[1]!;
  } catch { throw new ConfigError("上游未返回有效 feed 地址；未写配置，不输出认证地址。"); }
}
export function confirm(row: Subscription, target: Identity, expectedFeed?: string) {
  if (String(row.id) !== target.bizId || row.name !== target.name) throw new ConfigError("上游公众号名称或 bizId 与已核实输入不符；请核实身份，不自动改名。");
  if (row.paused !== undefined && typeof row.paused !== "boolean") throw new ConfigError("上游暂停状态格式不明；未改变订阅状态。");
  const actual = feedId(row.link);
  if (expectedFeed && actual !== expectedFeed) throw new ConfigError("上游 feedId 与现有身份不符；请核实 RSS_SECRET，不改写身份。");
  return actual;
}
export function readReceipt(file: string): Receipt | undefined {
  if (!fs.existsSync(file)) return undefined;
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  identity(r.name, r.bizId);
  if (r.version !== 1 || !["add_pending", "subscribed"].includes(r.phase) || (r.feedId !== undefined && (typeof r.feedId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(r.feedId))) || (r.paused !== undefined && typeof r.paused !== "boolean") || (r.phase === "subscribed" && !r.feedId)) throw new ConfigError("接入回执格式无效；请核对原回执。");
  return r;
}
function atomicWrite(file: string, text: string) {
  const temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch { throw new ConfigError("目标文件正在使用或上次中断留有锁；确认没有在飞接入后再处理 .lock 文件。"); }
  try { return await fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export async function prepare(target: Identity, base: string, token: string, receiptFile: string, addMissing: boolean) {
  identity(target.name, target.bizId);
  return withFileLock(receiptFile, async () => {
    const previous = readReceipt(receiptFile);
    if (previous && (previous.name !== target.name || previous.bizId !== target.bizId)) throw new ConfigError("回执属于其他公众号；请使用本账号自己的回执路径。");
    const api = upstreamApi(base, token);
    let rows = await listSubscriptions(api);
    let row = rows.get(target.bizId);
    let added = false;
    if (!row) {
      if (previous) throw new ConfigError("上次添加结果或已有订阅当前无法确认；完整列表仍无此账号，未重发 /add。请先核实上游状态并保留回执。");
      if (!addMissing) throw new ConfigError("上游缺少此账号；确认接入授权后使用 --add-missing，仅添加这个公众号。");
      atomicWrite(receiptFile, JSON.stringify({ version: 1, ...target, phase: "add_pending" }) + "\n");
      let returnedFeed: string | undefined;
      try {
        const result = await api(`/add/${target.bizId}`);
        if (typeof result.data !== "string") throw new ConfigError("添加响应格式无效。");
        returnedFeed = feedId(result.data);
        atomicWrite(receiptFile, JSON.stringify({ version: 1, ...target, phase: "add_pending", feedId: returnedFeed }) + "\n");
      } catch {
        // The request may have committed. A read is safe; a repeated /add is not.
      }
      rows = await listSubscriptions(api);
      row = rows.get(target.bizId);
      if (!row) throw new ConfigError("添加结果未知；回执已保留。再次 prepare 会先查完整列表，不重发 /add。");
      confirm(row, target, returnedFeed);
      added = true;
    }
    const result: Receipt = { version: 1, ...target, phase: "subscribed", feedId: confirm(row, target, previous?.feedId), paused: row.paused };
    atomicWrite(receiptFile, JSON.stringify(result, null, 2) + "\n");
    return { ...result, added };
  });
}
export function readPack(file: string) {
  const text = fs.readFileSync(file, "utf8");
  const pack = JSON.parse(text);
  if (!Array.isArray(pack.sources)) throw new ConfigError("来源清单缺少 sources 数组。");
  return { text, pack };
}
export function findAccount(sources: Account[], target: Identity, expectedFeed?: string, expectedId = `radar-mp-${target.bizId}`): Account | undefined {
  const candidates = sources.filter(s => s.id === expectedId || s.config?.bizId === target.bizId || (expectedFeed && s.config?.provider === "wechat2rss" && s.config.feedId === expectedFeed));
  if (candidates.length > 1) throw new ConfigError("此账号的来源身份重复；未修改配置或数据库。");
  const s = candidates[0];
  if (s && (s.name !== target.name || s.kind !== "mp_account" || s.config.provider !== "wechat2rss" || s.config.bizId !== target.bizId || (expectedFeed && s.config.feedId !== expectedFeed))) throw new ConfigError("来源 id、名称、bizId 或 feedId 冲突；未覆盖已有来源。");
  if (s && (typeof s.id !== "string" || !s.id || typeof s.config.feedId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(s.config.feedId))) throw new ConfigError("目标来源缺少有效 id/feedId；先核实并修正该来源配置。");
  return s;
}
export async function configureAccount(file: string, receipt: Receipt) {
  identity(receipt.name, receipt.bizId);
  if (receipt.phase !== "subscribed" || !receipt.feedId) throw new ConfigError("订阅尚未确认；先续跑 prepare。");
  return withFileLock(file, async () => {
    const { text, pack } = readPack(file);
    const existing = findAccount(pack.sources, receipt, receipt.feedId);
    if (existing) return { source: existing, inserted: false };
    const source = { id: `radar-mp-${receipt.bizId}`, name: receipt.name, kind: "mp_account", config: { provider: "wechat2rss", bizId: receipt.bizId, feedId: receipt.feedId }, tier: "T1_5", first_party: false, participation_mode: "editorial", interval_minutes: 15, enabled: true, site_fulltext: true, syndicate_fulltext: false };
    // Preserve the hand-maintained pack formatting and all unrelated fields.
    const end = text.lastIndexOf("]");
    if (end < 0 || text.slice(end + 1).trim() !== "}") throw new ConfigError("来源清单布局无法安全追加；未改文件。");
    const next = text.slice(0, end).trimEnd() + (pack.sources.length ? "," : "") + "\n    " + JSON.stringify(source) + "\n  " + text.slice(end);
    const parsed = JSON.parse(next);
    if (parsed.sources.length !== pack.sources.length + 1 || fs.readFileSync(file, "utf8") !== text) throw new ConfigError("来源清单已变化；未覆盖，请重试 config。");
    atomicWrite(file, next);
    return { source, inserted: true };
  });
}

const defaultSources = fileURLToPath(new URL("../../industry/sources.json", import.meta.url));
export async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    name: { type: "string" }, "biz-id": { type: "string" }, receipt: { type: "string" }, sources: { type: "string" }, "service-env": { type: "string" }, base: { type: "string", default: "http://127.0.0.1:18480" }, "add-missing": { type: "boolean", default: false }, json: { type: "boolean", default: false }, help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("单公众号接入：prepare|config|apply|status --name 名称 --biz-id 十进制ID [--json]\nprepare --receipt /绝对路径/账号.json [--add-missing]：完整列表判重；--add-missing 会向上游添加该账号并触发异步抓取。\nconfig --receipt 文件 [--sources industry/sources.json]：仅将已确认回执加入源配置；请在自有开发树执行。\napply：在发布部署后的 release 运行，仅登记清单内目标到 DB，保留已有状态。\nstatus：只读查看上游、配置、数据库、最近采集及入库/精选数量。\nprepare/apply/status 使用 --service-env 私有服务env；不自动 git push、部署、启动 worker 或历史回填。未知添加结果复用原回执续跑，不删除回执盲重试。 ");
    return;
  }
  const command = positionals[0];
  if (positionals.length !== 1 || !["prepare", "config", "apply", "status"].includes(command || "")) throw new ConfigError("指定 prepare、config、apply 或 status；用 --help 查看阶段与副作用。");
  const target = identity(values.name, values["biz-id"]);
  const sourcesFile = path.resolve(values.sources || defaultSources);
  let result: unknown;
  if (command === "config") {
    if (!values.receipt) throw new ConfigError("config 需要 --receipt。");
    const receipt = readReceipt(path.resolve(values.receipt));
    if (!receipt || receipt.name !== target.name || receipt.bizId !== target.bizId) throw new ConfigError("回执缺失或公众号身份不符。");
    result = await configureAccount(sourcesFile, receipt);
  } else {
    let env: Record<string, string | undefined> = {};
    try { env = readSecrets(values["service-env"] || "/home/ubuntu/aihot/shared/wechat2rss/service.env"); }
    catch (error) { if (command !== "status") throw error; }
    if (command === "prepare") {
      if (!values.receipt) throw new ConfigError("prepare 需要 --receipt 持久文件路径。");
      const configured = findAccount(readPack(sourcesFile).pack.sources, target);
      result = await prepare(target, values.base!, env.RSS_TOKEN || "", path.resolve(values.receipt), values["add-missing"]);
      if (configured && configured.config.feedId !== (result as Receipt).feedId) throw new ConfigError("上游 feedId 与清单冲突；未写清单或数据库。");
    } else {
      const { accountStatus, applyAccount } = await import("./source-registration.ts");
      const { closeDb } = await import("@aihot/backend/db");
      try {
        result = command === "apply" ? await applyAccount(readPack(sourcesFile).pack.sources, target, values.base!, env.RSS_TOKEN || "") : await accountStatus(readPack(sourcesFile).pack.sources, target, values.base!, env.RSS_TOKEN || "");
      } finally { await closeDb(); }
    }
  }
  if (command === "status") {
    const status = result as { configuration: Record<string, unknown>; upstream: Record<string, unknown>; database: Record<string, unknown> };
    if ([status.configuration, status.upstream, status.database].some(part => ["unverified", "conflict", "missing"].includes(String(part.state)))) process.exitCode = 2;
    if (!values.json) {
      const labels: Record<string, string> = { present: "已配置", subscribed: "已订阅", registered: "已登记", missing: "缺失", conflict: "身份冲突", unverified: "未核实", pending: "等待首次采集", paused: "已暂停", ok_zero_new: "最近采集成功，零新增", ingested: "最近采集有新增", running: "采集中", failed: "最近采集失败", skipped: "最近采集已跳过", not_registered: "尚未登记" };
      console.log(`${target.name}（${target.bizId}）状态检查${process.exitCode === 2 ? "存在缺项或未核实项" : "完成"}。`);
      for (const [name, part] of [["来源配置", status.configuration], ["上游订阅", status.upstream], ["数据库登记", status.database]] as const) console.log(`${name}：${labels[String(part.state)] || part.state}${part.reason ? `；${part.reason}` : ""}`);
      if (status.upstream.state === "subscribed") console.log(`上游暂停：${status.upstream.paused === null ? "未提供" : status.upstream.paused ? "是" : "否"}`);
      if (status.database.collection) console.log(`采集：${labels[String(status.database.collection)] || status.database.collection}`);
      if (status.database.stored_articles !== undefined) console.log(`已入库 ${status.database.stored_articles} 篇；公开精选 ${status.database.selected_public_articles} 篇（两者不是同一阶段）。`);
      console.log("缺订阅先用原回执 prepare；缺配置用 config 并发布部署；缺登记用 apply。采集未完成查看正常 worker 的 fetch_runs，暂停状态不会被本命令修改。");
    }
  } else if (!values.json) {
    const action = result as { added?: boolean; inserted?: boolean; paused?: boolean; upstream_paused?: boolean; source?: { id: string }; database?: { enabled: boolean } };
    if (command === "prepare") console.log(`${target.name}（${target.bizId}）订阅已确认，${action.added ? "本次发送一次添加请求" : "复用已有订阅，未刷新"}；上游暂停${action.paused === undefined ? "状态未提供" : action.paused ? "保留" : "未开启"}。回执已保存，下一步 config；本阶段未执行数据库登记，也未核实数据库或采集状态。`);
    if (command === "config") console.log(`${target.name} 来源配置${action.inserted ? "已加入" : "已存在，保持原样"}。下一步按项目流程审查、提交、发布和部署，再 apply；本命令未发布或修改数据库。`);
    if (command === "apply") console.log(`${target.name} 数据库来源${action.inserted ? "已登记" : "已存在，保留配置、暂停与游标"}，当前${action.database?.enabled ? "启用" : "暂停"}。未主动采集或运行模型，下一步 status 观察正常 worker 的采集与入库；登记不代表已精选。`);
  }
  if (values.json) console.log(JSON.stringify({ command, ...target, result }));
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Do not await module evaluation: the DB-only phase imports this module's pure helpers.
  void main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof ConfigError ? error.message : "本阶段未完成；已有订阅、回执、配置与数据库记录保留。检查参数/文件/服务后从本阶段续跑，勿盲重试添加。");
    process.exitCode = 1;
  });
}
