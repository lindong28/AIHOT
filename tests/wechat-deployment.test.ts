import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("login probe distinguishes healthy, invalid login, API errors and transport failures without secrets", async () => {
  let body: unknown = { data: [{ available: true, needCheck: false, name: "private-name" }] };
  let status = 200;
  const server = http.createServer((_req, res) => { res.writeHead(status); res.end(JSON.stringify(body)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { ...process.env, RSS_TOKEN: "fixture-secret", WECHAT2RSS_BASE_URL: base };
  const probe = () => run(process.execPath, ["deploy/wechat2rss/login-status.ts"], { cwd: root, env });
  try {
    let result = await probe();
    assert.equal(JSON.parse(result.stdout).data[0].available, true);
    assert.ok(!result.stdout.includes("private-name"));
    body = { data: [{ available: false, needCheck: true }] };
    result = await probe();
    assert.equal(JSON.parse(result.stdout).data[0].available, false);
    await assert.rejects(run(process.execPath, ["deploy/wechat2rss/login-status.ts", "--summary"], { cwd: root, env }), { code: 1 });
    body = { err: "fixture-secret" };
    result = await probe();
    assert.ok(JSON.parse(result.stdout).err);
    assert.ok(!result.stdout.includes("fixture-secret"));
    status = 503;
    await assert.rejects(probe(), (e: any) => e.code === 1 && !`${e.stdout}${e.stderr}`.includes("fixture-secret"));
    await assert.rejects(run(process.execPath, ["deploy/wechat2rss/login-status.ts"], { cwd: root, env: { ...env, RSS_TOKEN: "" } }), { code: 1 });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("external probe preserves incident keys and closes recovery without sending real notifications", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aihot-wechat-probe-"));
  const response = path.join(dir, "response.json"), state = path.join(dir, "state"), log = path.join(dir, "notify.log");
  const notify = path.join(dir, "im-notify");
  await writeFile(notify, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NOTIFY_LOG"\n', { mode: 0o700 });
  const env = { ...process.env, RESPONSE: response, NOTIFY_LOG: log, IM_NOTIFY_BIN: notify, WECHAT2RSS_STATE_FILE: state, WECHAT2RSS_SSH_HOST: "fixture" };
  const script = 'ssh() { cat "$RESPONSE"; }; export -f ssh; bash "$1"';
  const probe = () => run("bash", ["-c", script, "test", path.join(root, "deploy/wechat2rss/healthcheck.sh")], { env });
  try {
    for (const [kind, data] of [
      ["apierr", { err: "fixture error" }], ["noaccount", { data: [] }],
      ["login", { data: [{ available: false }] }], ["riskctl", { data: [{ available: true, needCheck: true }] }],
    ] as const) {
      await writeFile(response, JSON.stringify(data));
      await assert.rejects(probe(), { code: 1 });
      assert.match(await readFile(state, "utf8"), new RegExp(`^firing ${kind} `));
      assert.ok((await readFile(log, "utf8")).includes(`--dedup-key wechat2rss-${kind}`));
    }
    await writeFile(response, JSON.stringify({ data: [{ available: true, needCheck: false }] }));
    await probe();
    assert.equal(await readFile(state, "utf8"), "healthy\n");
    const notifications = await readFile(log, "utf8");
    assert.match(notifications, /--dedup-clear wechat2rss-unreachable/);
    assert.match(notifications, /--dedup-key wechat2rss-recovered/);
    assert.match(notifications, /fetch_runs/);
    await rm(response);
    await assert.rejects(probe(), { code: 1 });
    assert.match(await readFile(state, "utf8"), /^firing unreachable /);
    assert.match(await readFile(log, "utf8"), /健康未核实/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("production start and stop include configured Wechat2RSS in dependency order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aihot-wechat-lifecycle-"));
  const log = path.join(dir, "calls"), settings = path.join(dir, "compose.env");
  const script = 'systemctl() { if [[ "$1" == show ]]; then echo loaded; fi; }; sudo() { printf "%s\\n" "$*" >> "$CALL_LOG"; }; export -f systemctl sudo; bash "$1" "$2"';
  const env = { ...process.env, CALL_LOG: log, WECHAT2RSS_COMPOSE_ENV: settings };
  const lifecycle = (action: string) => run("bash", ["-c", script, "test", path.join(root, "deploy/production/service.sh"), action], { env });
  try {
    await writeFile(settings, "# fixture\n");
    await lifecycle("start");
    let calls = await readFile(log, "utf8");
    assert.ok(calls.indexOf("up -d --wait") < calls.indexOf("systemctl start aihot-api"));
    assert.match(calls, /--project-name aihot-wechat2rss/);
    await writeFile(log, "");
    await lifecycle("stop");
    calls = await readFile(log, "utf8");
    assert.ok(calls.indexOf("systemctl stop aihot-api") < calls.indexOf("compose --project-name"));
    await writeFile(log, "");
    await rm(settings);
    const result = await lifecycle("start");
    assert.match(result.stdout, /本机实例未配置/);
    assert.ok(!(await readFile(log, "utf8")).includes("docker compose"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
