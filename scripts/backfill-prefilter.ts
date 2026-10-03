// Preparation queue only: no article insert, score, understanding, writing or publication.
import { readFile } from "node:fs/promises";
import { runPreparationPrefilter } from "@aihot/backend/backfill/preparation-prefilter";
import { closeDb } from "@aihot/backend/db";

const json = process.argv.includes("--json");
const args = process.argv.slice(2).filter(a => a !== "--json");
const stop = new AbortController();
const shutdown = () => stop.abort();
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
try {
  if (args.length !== 6) {
    console.error("用法：node scripts/backfill-prefilter.ts <input.jsonl> <models.json> <输出目录> <并发1–32> <本轮最多条数> <领取窗口秒数1–1500> [--json]\n仅执行历史准备初筛；本次未调用模型。窗口从首个待处理项开始，前缀扫描不计入；到时停止领取并结算在途请求，不是总运行时限。");
    process.exitCode = 2;
  } else {
    const [input, modelsFile, output, concurrency, maxItems, seconds] = args;
    const result = await runPreparationPrefilter({ input, output, models: JSON.parse(await readFile(modelsFile, "utf8")),
      concurrency: Number(concurrency), maxItems: Number(maxItems), seconds: Number(seconds), signal: stop.signal });
    if (json) console.log(JSON.stringify(result));
    else {
      console.log(`历史准备初筛：${result.status}。累计筛除 ${result.filtered}，待补原文 ${result.needsOriginal}，未解决错误 ${result.unresolvedErrors}；本轮领取 ${result.claimed}，复用已有结果 ${result.skippedExisting}，输入共 ${result.total} 条。`);
      console.log("未执行原文抓取、评分、写作或文章导入；PASS/UNKNOWN不代表原文完整。结果与累计状态保存在输出目录的 results/ 和 summary.json。");
      if (result.status === "waiting_budget") console.log(`预算已耗尽，未领取项保留；${result.retryAfterSeconds ?? 0} 秒后可用相同命令续跑，不会自动重发未知回执。`);
      else if (result.status === "locked") console.log("同目录已有执行器，本次未领取；等待该执行器结束后续跑。");
      else if (result.status === "bounded") console.log("本轮达到边界；可用相同命令继续，已持久化结果不会新增模型请求。");
      if (result.unresolvedErrors) console.log("错误结果保持，不会自动重试；请按 errorKind 和 receiptId 核对回执后另行处理。");
    }
    if (result.unresolvedErrors || result.status === "runtime_error") process.exitCode = 2;
  }
} catch (error) {
  // Provider messages may contain request data. Operator logs only disclose the class.
  console.error(`历史准备初筛未完成（${error instanceof Error ? error.constructor.name : "UnknownError"}）；已有结果保留，未解决项需检查输入冻结信息和回执状态。`);
  process.exitCode = 1;
} finally {
  process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown); await closeDb();
}
