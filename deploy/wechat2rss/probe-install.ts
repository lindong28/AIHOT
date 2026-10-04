// Install the existing external probe without relying on another repo's SSH configuration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ConfigError, privateFile, readSecrets, required } from "./configure.ts";

const marker = "# aihot-wechat2rss-probe";
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function decode(env: Record<string, string | undefined>, key: string) {
  const value = required(env, key);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new ConfigError(`${key} 不是有效 base64。`);
  return Buffer.from(value, "base64").toString("utf8");
}
export function prepareProbe(env: Record<string, string | undefined>, root: string, repo: string) {
  root = path.resolve(root); repo = path.resolve(repo);
  if (/[\r\n\0%]/.test(root + repo)) throw new ConfigError("探针路径含 cron 不支持的字符。");
  const target = required(env, "WECHAT2RSS_PROBE_SSH_TARGET");
  if (!/^[a-zA-Z0-9_-]+@[a-zA-Z0-9.-]+$/.test(target)) throw new ConfigError("探针 SSH 目标必须为 user@hostname（不使用 ~/.ssh/config 别名）。");
  const key = decode(env, "WECHAT2RSS_PROBE_SSH_PRIVATE_KEY_B64");
  const known = decode(env, "WECHAT2RSS_PROBE_SSH_KNOWN_HOSTS_B64");
  const notify = process.env.IM_NOTIFY_BIN || path.join(os.homedir(), ".local/bin/im-notify");
  if (!fs.existsSync(notify)) throw new ConfigError("未安装 im-notify；先从 ai-agent-config 运行 bash im-notify/install.sh。");
  required(env, "FEISHU_GENERAL_ALERT_WEBHOOK");
  if (!fs.existsSync(path.join(repo, "deploy/wechat2rss/healthcheck.sh"))) throw new ConfigError("AIHOT checkout 缺少健康探针。");
  // Validate in a private staging directory before replacing an active probe identity.
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(root, ".probe-"));
  let pub: string;
  try {
    privateFile(path.join(stage, "key"), key);
    privateFile(path.join(stage, "known_hosts"), known);
    pub = execFileSync("ssh-keygen", ["-y", "-P", "", "-f", path.join(stage, "key")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!pub.startsWith("ssh-ed25519 ")) throw new ConfigError("探针必须使用专用 ed25519 key。");
    execFileSync("ssh-keygen", ["-F", target.split("@")[1]!, "-f", path.join(stage, "known_hosts")], { stdio: "pipe" });
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  privateFile(path.join(root, "probe-key"), key);
  privateFile(path.join(root, "known_hosts"), known);
  privateFile(path.join(root, "probe-key.pub"), pub + "\n");
  const exports = {
    PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    WECHAT2RSS_SSH_HOST: target,
    WECHAT2RSS_SSH_KEY_FILE: path.join(root, "probe-key"),
    WECHAT2RSS_SSH_KNOWN_HOSTS_FILE: path.join(root, "known_hosts"),
    WECHAT2RSS_STATE_FILE: path.join(root, "healthcheck.state"),
  };
  const script = ["#!/usr/bin/env bash", "set -eu", ...Object.entries(exports).map(([k, v]) => `export ${k}=${shellQuote(v)}`), `if [[ -z "\${IM_NOTIFY_BIN:-}" ]]; then export IM_NOTIFY_BIN=${shellQuote(notify)}; fi`, `exec /bin/bash ${shellQuote(path.join(repo, "deploy/wechat2rss/healthcheck.sh"))}`, ""].join("\n");
  privateFile(path.join(root, "probe.sh"), script, 0o700);
  return `11,31,51 * * * * /bin/bash ${shellQuote(path.join(root, "probe.sh"))} >/dev/null 2>&1 ${marker}`;
}
export function updateCron(current: string, entry: string) {
  // Only this probe's documented legacy job and our own marked job belong to this installer.
  const lines = current.split("\n").filter((line) => !line.endsWith(marker) && !/^11,31,51 \* \* \* \* .*\/wechat2rss\/healthcheck\.sh(?:'| )/.test(line));
  return lines.join("\n").replace(/\n*$/, "\n") + entry + "\n";
}
export function authorizeProbe(publicKey: string, serverRoot: string, authorizedKeys: string, node: string) {
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?:\s[^\r\n]*)?$/.test(publicKey.trim())) throw new ConfigError("需要 ed25519 公钥文件。");
  if (![serverRoot, node].every((s) => /^\/[a-zA-Z0-9_./-]+$/.test(s))) throw new ConfigError("服务根目录与 Node 路径须为无空格的绝对路径。");
  const [type, blob] = publicKey.trim().split(/\s+/);
  const command = `${node} --env-file=${serverRoot}/shared/wechat2rss/service.env ${serverRoot}/current/deploy/wechat2rss/login-status.ts`;
  const line = `restrict,command="${command}" ${type} ${blob} aihot-wechat2rss-probe`;
  const old = fs.existsSync(authorizedKeys) ? fs.readFileSync(authorizedKeys, "utf8") : "";
  const existing = old.split("\n").filter((s) => s.endsWith(" aihot-wechat2rss-probe") || s.split(/\s+/).includes(blob!));
  if (existing.length) {
    if (existing.length === 1 && existing[0] === line) return;
    throw new ConfigError("目标已有不同的探针授权或同一 key 的其他授权；未覆盖，请先核查归属。");
  }
  privateFile(authorizedKeys, old.replace(/\n*$/, "\n") + line + "\n");
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      secrets: { type: "string" }, root: { type: "string" }, repo: { type: "string" }, install: { type: "boolean" },
      "authorize-key": { type: "string" }, "server-root": { type: "string" },
    } });
    if (values["authorize-key"]) {
      authorizeProbe(fs.readFileSync(values["authorize-key"], "utf8"), values["server-root"] || "/home/ubuntu/aihot", path.join(os.homedir(), ".ssh/authorized_keys"), process.execPath);
      console.log("Wechat2RSS 专用公钥已登记，仅允许读取登录健康；未改变其他 SSH 授权。");
    } else {
      const root = values.root || path.join(os.homedir(), ".local/share/aihot/wechat2rss");
      const repo = values.repo || fileURLToPath(new URL("../../", import.meta.url));
      const entry = prepareProbe(readSecrets(values.secrets), root, repo);
      if (values.install) {
        let old: string;
        try { old = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
        catch (e: any) { if (e.status === 1 && /no crontab for/.test(String(e.stderr))) old = ""; else throw e; }
        execFileSync("crontab", ["-"], { input: updateCron(old, entry), stdio: ["pipe", "pipe", "pipe"] });
      }
      console.log(`Wechat2RSS 探针运行配置已生成${values.install ? "，cron 已安装" : "，尚未安装 cron（加 --install）"}；尚未验证远端公钥授权或通知投递。`);
    }
  } catch (e) { console.error(e instanceof ConfigError ? e.message : "探针配置未完成；检查中央 env、专用 SSH key、主机信任、工具安装和文件权限。未输出凭据。"); process.exitCode = 1; }
}
