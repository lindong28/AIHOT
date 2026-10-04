// Materialize only this service's secrets; never execute the shared env as shell code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export class ConfigError extends Error {}
export function readSecrets(file = path.join(os.homedir(), ".claude/.env")) {
  return parseEnv(fs.readFileSync(file, "utf8"));
}
export function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value || /[\r\n\0']/.test(value)) throw new ConfigError(`缺少或不支持的配置：${key}（须非空、单行且不含单引号）。`);
  return value;
}
export function envLine(key: string, value: string) { return `${key}='${value}'`; }
export function privateFile(file: string, content: string, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new ConfigError("运行配置目标不得是符号链接。");
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
export function configure(env: Record<string, string | undefined>, root: string, appEnv?: string) {
  root = path.resolve(root);
  if (/[\r\n\0']/.test(root)) throw new ConfigError("运行目录含不支持的字符。");
  const keys = ["LIC_EMAIL", "LIC_CODE", "RSS_TOKEN", "RSS_SECRET", "RSS_PROXY_SECRET"];
  const native = Object.fromEntries(keys.map((k) => [k, required(env, `WECHAT2RSS_${k}`)]));
  const service = [...keys.map((k) => envLine(k, native[k]!)), "RSS_ENC_FEED_ID=1", "RSS_HOST=127.0.0.1:18480", ""].join("\n");
  const origin = "http://127.0.0.1:18480";
  const updates = { WECHAT2RSS_BASE_URL: origin, WECHAT2RSS_RSS_TOKEN: native.RSS_TOKEN! };
  let app: string | undefined;
  if (appEnv) {
    // The AIHOT app owns its other configuration; don't create a partial app.env.
    const old = fs.readFileSync(appEnv, "utf8");
    const lines = old.split("\n");
    for (const [key, value] of Object.entries(updates)) {
      const indices = lines.flatMap((line, i) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line) ? [i] : []);
      if (indices.length > 1) throw new ConfigError(`目标文件重复定义 ${key}；未写入配置。`);
      if (indices.length) lines[indices[0]!] = envLine(key, value); else lines.push(envLine(key, value));
    }
    app = lines.join("\n").replace(/\n*$/, "\n");
  }
  fs.mkdirSync(path.join(root, "data"), { recursive: true, mode: 0o700 });
  privateFile(path.join(root, "service.env"), service);
  privateFile(path.join(root, "compose.env"), [
    envLine("WECHAT2RSS_ENV_FILE", path.join(root, "service.env")),
    envLine("WECHAT2RSS_DATA_DIR", path.join(root, "data")), "WECHAT2RSS_BOT_WEBHOOK_URL=", "",
  ].join("\n"));
  privateFile(path.join(root, "app.env.fragment"), Object.entries(updates).map(([k, v]) => envLine(k, v)).join("\n") + "\n");
  if (appEnv && app !== undefined) privateFile(appEnv, app);
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { secrets: { type: "string" }, root: { type: "string" }, "app-env": { type: "string" } } });
    if (!values.root) throw new ConfigError("用法：node deploy/wechat2rss/configure.ts --root <目标运行目录> [--secrets ~/.claude/.env] [--app-env <已有app.env>]。");
    configure(readSecrets(values.secrets), values.root, values["app-env"]);
    console.log("Wechat2RSS 私有运行配置已生成（0600），数据库与登录态保留。尚未启停服务；将配置放到目标机器后运行生产 install/restart，再检查登录与采集。");
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : "Wechat2RSS 配置未完成；检查中央 env、目标路径和文件权限。未输出凭据。");
    process.exitCode = 1;
  }
}
