// Operator entrypoint; importing stages a native manifest and never calls a model.
import { readFile } from "node:fs/promises";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { backfillOverview, configureBackfill, controlBackfill, importBackfill, runBackfill } from "@aihot/backend/backfill/runs";

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "import" && args.length === 4) {
    const [file, startDay, endDay, label] = args as [string, string, string, string];
    const entries = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const r = await importBackfill({ entries, startDay, endDay, label });
    console.log(`历史批次${r.reused ? "已存在" : "已准备，默认暂停"}：${r.id}。本次未调用模型。`);
  } else if (command === "configure" && args.length === 2) {
    await configureBackfill(args[0]!, JSON.parse(await readFile(args[1]!, "utf8")));
    console.log("回填模型绑定已保存；尚未验证部署、未调用模型。运行时会核对个人 Gateway 与 self_hosted 路由。");
  } else if (["pause", "resume", "retry"].includes(command ?? "") && args.length === 1) {
    await controlBackfill(args[0]!, command as "pause" | "resume" | "retry", "backfill-cli");
    console.log(command === "pause" ? "已请求暂停；在途请求结算后停止。" : "批次已准备续跑；未启动执行器，已完成的模型回执会复用。");
  } else if (command === "run" && args.length === 3) {
    const r = await runBackfill(args[0]!, { concurrency: Number(args[1]), maxItems: Number(args[2]) });
    console.log(`本次执行结束：处理 ${r.processed} 条，批次状态 ${r.state}。详细进度与需处理的问题见 /admin/backfill。`);
    if (["waiting_models", "needs_attention"].includes(r.state)) process.exitCode = 2;
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
    console.error("用法：node scripts/backfill.ts import <native.jsonl> <起日> <止日> <名称> | configure <批次ID> <models.json> | pause/resume/retry <批次ID> | run <批次ID> <GPU容量并发> <本次最多条数> | status [--json]\n本次未导入、未调用模型。");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`历史回填操作未完成：${e instanceof Error ? e.message : String(e)}。已有进度保留；请检查后台状态再续跑。`);
  process.exitCode = 1;
} finally { await stopBoss(); await closeDb(); }
