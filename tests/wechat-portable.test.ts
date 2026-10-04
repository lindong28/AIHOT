import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { parseEnv } from "node:util";
import { configure } from "../deploy/wechat2rss/configure.ts";
import { restore } from "../deploy/wechat2rss/restore-subscriptions.ts";
import { authorizeProbe, prepareProbe, updateCron } from "../deploy/wechat2rss/probe-install.ts";

const keys = ["LIC_EMAIL", "LIC_CODE", "RSS_TOKEN", "RSS_SECRET", "RSS_PROXY_SECRET"];
const secrets = Object.fromEntries(keys.map((k) => [`WECHAT2RSS_${k}`, `fixture-$(${k})`]));
test("central Wechat2RSS credentials produce private config and preserve app settings and runtime data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-config-"));
  try {
    const root = path.join(dir, "service"); const app = path.join(dir, "app.env");
    fs.writeFileSync(app, "OTHER=keep\nWECHAT2RSS_BASE_URL=http://127.0.0.1:39033\nWECHAT2RSS_RSS_TOKEN=old\n");
    assert.throws(() => configure({}, root, app), /WECHAT2RSS_LIC_EMAIL/);
    assert.equal(fs.existsSync(root), false);
    configure(secrets, root, app);
    const service = parseEnv(fs.readFileSync(path.join(root, "service.env"), "utf8"));
    for (const k of keys) assert.equal(service[k], secrets[`WECHAT2RSS_${k}`]);
    assert.equal(service.RSS_ENC_FEED_ID, "1");
    assert.equal(parseEnv(fs.readFileSync(app, "utf8")).OTHER, "keep");
    assert.equal(parseEnv(fs.readFileSync(app, "utf8")).WECHAT2RSS_RSS_TOKEN, secrets.WECHAT2RSS_RSS_TOKEN);
    assert.equal(fs.statSync(app).mode & 0o777, 0o600);
    const db = path.join(root, "data/res.db"); fs.writeFileSync(db, "existing login and data");
    configure(secrets, root, app); assert.equal(fs.readFileSync(db, "utf8"), "existing login and data");
    fs.appendFileSync(app, "WECHAT2RSS_RSS_TOKEN=duplicate\n");
    assert.throws(() => configure(secrets, root, app), /重复定义/);
    const alias = path.join(dir, "current");
    fs.symlinkSync(path.resolve(import.meta.dirname, "../deploy/wechat2rss"), alias);
    const input = path.join(dir, "fixture.env");
    fs.writeFileSync(input, Object.entries(secrets).map(([k, v]) => `${k}='${v}'`).join("\n"));
    const target = path.join(dir, "via-current");
    execFileSync(process.execPath, [path.join(alias, "configure.ts"), "--secrets", input, "--root", target], { stdio: "pipe" });
    assert.equal(parseEnv(fs.readFileSync(path.join(target, "service.env"), "utf8")).RSS_TOKEN, secrets.WECHAT2RSS_RSS_TOKEN);
    for (const script of ["probe-install.ts", "restore-subscriptions.ts"]) {
      assert.throws(() => execFileSync(process.execPath, [path.join(alias, script), "--invalid-option"], { stdio: "pipe" }), (error: any) => error.status === 1);
    }
    for (const script of ["configure.ts", "probe-install.ts", "restore-subscriptions.ts"]) {
      execFileSync(process.execPath, ["--input-type=module", "-"], { input: `await import(${JSON.stringify(path.join(alias, script))});`, stdio: ["pipe", "pipe", "pipe"] });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("subscription restore reads every page, adds only missing accounts, preserves pauses and rejects identity drift", async () => {
  const rows = [{ id: 101, link: "http://127.0.0.1/feed/first.xml", paused: true }, { id: 102, link: "http://127.0.0.1/feed/second.xml", paused: false }];
  const accounts = [101, 102, 103].map((biz, i) => ({ id: `mp-${biz}`, kind: "mp_account", enabled: true, config: { provider: "wechat2rss", bizId: String(biz), feedId: ["first", "second", "third"][i] } }));
  const added: string[] = []; let broken = false;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://localhost");
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/list") {
      const page = Number(u.searchParams.get("page"));
      res.end(JSON.stringify({ err: "", data: broken && page === 2 ? [] : rows.slice(page - 1, page), meta: { total: rows.length } }));
    } else if (u.pathname.startsWith("/add/")) {
      added.push(u.pathname); rows.push({ id: 103, link: "http://127.0.0.1/feed/third.xml", paused: false });
      res.end(JSON.stringify({ err: "", data: "http://127.0.0.1/feed/third.xml" }));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    await assert.rejects(restore(accounts, base, "fixture-token", false), /缺少 1/);
    assert.deepEqual(added, []);
    broken = true;
    await assert.rejects(restore(accounts, base, "fixture-token", true), /分页不完整/);
    assert.deepEqual(added, []); broken = false;
    assert.deepEqual(await restore(accounts, base, "fixture-token", true), { checked: 3, added: 1, paused: 1 });
    assert.deepEqual(added, ["/add/103"]);
    assert.deepEqual(await restore(accounts, base, "fixture-token", true), { checked: 3, added: 0, paused: 1 });
    accounts[0]!.config.feedId = "wrong";
    await assert.rejects(restore(accounts, base, "fixture-token", true), /feedId 不匹配/);
    assert.deepEqual(added, ["/add/103"]);
    await assert.rejects(restore([], base, "fixture-token", false), /没有启用/);
    await assert.rejects(restore(accounts, "https://public.example", "fixture-token", true), /回环/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("probe restores a dedicated identity and installs only its own cron and forced SSH command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-probe-portable-"));
  const previous = process.env.IM_NOTIFY_BIN;
  try {
    const key = path.join(dir, "key");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", key], { stdio: "ignore" });
    const pub = fs.readFileSync(key + ".pub", "utf8");
    const env = { WECHAT2RSS_PROBE_SSH_TARGET: "ubuntu@fixture.example", WECHAT2RSS_PROBE_SSH_PRIVATE_KEY_B64: fs.readFileSync(key).toString("base64"), WECHAT2RSS_PROBE_SSH_KNOWN_HOSTS_B64: Buffer.from("fixture.example " + pub).toString("base64"), FEISHU_GENERAL_ALERT_WEBHOOK: "fixture-only" };
    process.env.IM_NOTIFY_BIN = "/usr/bin/true";
    const root = path.join(dir, "runtime");
    const repo = path.resolve(import.meta.dirname, "..");
    const entry = prepareProbe(env, root, repo);
    assert.equal(fs.statSync(path.join(root, "probe-key")).mode & 0o777, 0o600);
    const runner = fs.readFileSync(path.join(root, "probe.sh"), "utf8");
    assert.ok(!runner.includes(env.WECHAT2RSS_PROBE_SSH_PRIVATE_KEY_B64));
    assert.match(runner, /WECHAT2RSS_SSH_KEY_FILE/);
    assert.match(runner, /if \[\[ -z "\$\{IM_NOTIFY_BIN:-\}" \]\]/);
    const fixtureRepo = path.join(dir, "fixture-repo");
    fs.mkdirSync(path.join(fixtureRepo, "deploy/wechat2rss"), { recursive: true });
    fs.writeFileSync(path.join(fixtureRepo, "deploy/wechat2rss/healthcheck.sh"), '#!/bin/bash\n[[ "$IM_NOTIFY_BIN" == /usr/bin/true ]]\n');
    process.env.IM_NOTIFY_BIN = "/usr/bin/false";
    prepareProbe(env, path.join(dir, "override-runtime"), fixtureRepo);
    execFileSync("/bin/bash", [path.join(dir, "override-runtime/probe.sh")], { env: { ...process.env, IM_NOTIFY_BIN: "/usr/bin/true" }, stdio: "pipe" });
    const unrelated = "* * * * * /other/job\n";
    const old = unrelated + "11,31,51 * * * * /old/wechat2rss/healthcheck.sh >/dev/null 2>&1\n";
    const cron = updateCron(old, entry);
    assert.equal(cron, unrelated + entry + "\n");
    assert.equal(updateCron(cron, entry), cron);
    const auth = path.join(dir, "authorized_keys"); fs.writeFileSync(auth, "existing-user-key\n");
    authorizeProbe(pub, "/home/ubuntu/aihot", auth, "/usr/local/bin/node");
    const content = fs.readFileSync(auth, "utf8");
    assert.ok(content.startsWith("existing-user-key\nrestrict,command=\"/usr/local/bin/node --env-file="));
    assert.match(content, /login-status\.ts" ssh-ed25519/);
    authorizeProbe(pub, "/home/ubuntu/aihot", auth, "/usr/local/bin/node");
    assert.equal(fs.readFileSync(auth, "utf8"), content);
    assert.throws(() => authorizeProbe(pub, "/different", auth, "/usr/local/bin/node"), /已有不同/);
  } finally {
    if (previous === undefined) delete process.env.IM_NOTIFY_BIN; else process.env.IM_NOTIFY_BIN = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot supports the Tencent Python and service.env paths while retaining the legacy env name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-snapshot-"));
  try {
    const bin = path.join(dir, "bin"); const source = path.join(dir, "source");
    fs.mkdirSync(bin); fs.mkdirSync(path.join(source, "data"), { recursive: true });
    const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(bin, "ssh"), "#!/usr/bin/env python3\nimport os, shlex, sys\na=shlex.split(sys.argv[-1]); os.execvp(a[0],a)\n", { mode: 0o700 });
    execFileSync(python, ["-c", "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.executescript('CREATE TABLE rsses(id); INSERT INTO rsses VALUES(1); CREATE TABLE articles(id); INSERT INTO articles VALUES(1),(2);'); d.close()", path.join(source, "data/res.db")]);
    for (const name of [".env", "service.env"]) {
      fs.writeFileSync(path.join(source, name), "RSS_TOKEN=fixture-only\n");
      const destination = path.join(dir, name === ".env" ? "legacy" : "tencent");
      const output = execFileSync(python, [path.resolve(import.meta.dirname, "../deploy/wechat2rss/snapshot.py"), "fixture-host", source, destination, "--remote-python", python, ...(name === ".env" ? [] : ["--env-name", name])], { encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
      assert.match(output, /1 个订阅、2 篇文章/);
      assert.equal(fs.readFileSync(path.join(destination, ".env"), "utf8"), "RSS_TOKEN=fixture-only\n");
      assert.equal(fs.statSync(path.join(destination, "res.db")).mode & 0o777, 0o600);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
