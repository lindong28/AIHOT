// Operator entrypoint; importing stages a native manifest and never calls a model.
import { readFile } from "node:fs/promises";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { backfillOverview, configureBackfill, controlBackfill, drainBackfills, importBackfill, runBackfill } from "@aihot/backend/backfill/runs";
import { importHistory } from "@aihot/backend/backfill/history-input";

const [command, ...args] = process.argv.slice(2);
const shutdown = new AbortController();
const stop = () => { shutdown.abort(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  if (command === "import-history" && args.length === 4) {
    const [file, startDay, endDay, label] = args as [string,string,string,string];
    const r = await importHistory({ file, startDay, endDay, label });
    console.log(`全量历史清单${r.reused ? '已存在' : '已导入，默认暂停'}：${r.id}。统一进度见 /admin/backfill；尚未调用模型或批准原文。`);
  } else if (command === "import" && args.length === 4) {
    const [file, startDay, endDay, label] = args as [string, string, string, string];
    const entries = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const r = await importBackfill({ entries, startDay, endDay, label });
    console.log(`历史批次${r.reused ? "已存在" : "已准备，默认暂停"}：${r.id}。本次未调用模型。`);
  } else if (command === "configure" && args.length === 2) {
    await configureBackfill(args[0]!, JSON.parse(await readFile(args[1]!, "utf8")));
    console.log("回填模型绑定已保存；尚未验证部署、未调用模型。运行时会核对个人 Gateway 与批准的候选路由。");
  } else if (["pause", "resume", "retry"].includes(command ?? "") && args.length === 1) {
    await controlBackfill(args[0]!, command as "pause" | "resume" | "retry", "backfill-cli");
    console.log(command === "pause" ? "已请求暂停；在途请求结算后停止。" : "批次已准备续跑；未启动执行器，已完成的模型回执会复用。");
  } else if (command === "run" && args.length === 3) {
    const r = await runBackfill(args[0]!, { concurrency: Number(args[1]), maxItems: Number(args[2]), signal: shutdown.signal });
    console.log(`本次执行结束：处理 ${r.processed} 条，批次状态 ${r.state}。详细进度与需处理的问题见 /admin/backfill。`);
    if (["waiting_models", "needs_attention"].includes(r.state)) process.exitCode = 2;
  } else if (command === "drain" && (args.length === 0 || args.length === 3)) {
    const concurrency = Number(args[0] ?? process.env.BACKFILL_CONCURRENCY);
    const maxItems = Number(args[1] ?? process.env.BACKFILL_MAX_ITEMS);
    const maxRuns = Number(args[2] ?? process.env.BACKFILL_MAX_RUNS);
    const seconds = Number(process.env.BACKFILL_DRAIN_SECONDS);
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 1500) throw new Error("BACKFILL_DRAIN_SECONDS must be explicitly set to 1–1500 seconds");
    deadline = setTimeout(stop, seconds * 1000);
    const result = await drainBackfills({ concurrency, maxItems, maxRuns, signal: shutdown.signal });
    const claimed = result.runs.reduce((n, r) => n + r.claimed, 0);
    const processed = result.runs.reduce((n, r) => n + r.processed, 0);
    console.log(`本轮回填${result.stopped ? "已停止领取并结算在途请求" : "执行结束"}：检查 ${result.runs.length} 个批次，领取 ${claimed}/${maxItems} 条，完成 ${processed} 条。暂停和需人工处理的批次不会自动重试。`);
    for (const r of result.runs) console.log(`${r.id} · ${r.state} · 完成 ${r.processed}/${r.claimed} 条`);
    // Waiting models / needs_attention are batch outcomes, not a crashed runner.
    console.log("批次状态与处理入口：/admin/backfill；本轮退出不代表全部历史回填完成。");
  } else if (command === "status") {
    const report = await backfillOverview();
    if (args.includes("--json")) console.log(JSON.stringify(report));
    else {
      if (!report.runs.length) console.log("尚无历史回填批次；未启动回填。");
      for (const r of report.runs as any[]) {
        const total = r.days.reduce((s: number, d: any) => s + d.total, 0);
        const done = r.days.reduce((s: number, d: any) => s + d.done, 0);
        console.log(`${r.label} · ${r.id}\n${r.start_day} 至 ${r.end_day}（UTC）· ${done}/${total} 条 · ${r.state}${r.error ? '\n需处理：' + r.error : ''}`);
      }
    }
  } else {
    console.error("用法：node scripts/backfill.ts import/import-history <输入.jsonl> <起日> <止日> <名称> | configure <批次ID> <models.json> | pause/resume/retry <批次ID> | run <批次ID> <容量并发> <本次最多条数> | drain [<容量并发> <整轮最多条数> <最多批次>] | status [--json]\ndrain 需显式配置 BACKFILL_DRAIN_SECONDS；省略参数时从 BACKFILL_CONCURRENCY/MAX_ITEMS/MAX_RUNS 读取。全量历史执行还需 BACKFILL_ORIGINAL_CACHE，可指定 BACKFILL_PREFILTER_CACHE 与 BACKFILL_NOT_DISPATCHED_AUDIT。本次未导入、未调用模型。");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`历史回填操作未完成：${e instanceof Error ? e.message : String(e)}。已有进度保留；请检查后台状态再续跑。`);
  process.exitCode = 1;
} finally {
  if (deadline) clearTimeout(deadline);
  await stopBoss(); await closeDb();
  process.off("SIGTERM", stop); process.off("SIGINT", stop);
}
