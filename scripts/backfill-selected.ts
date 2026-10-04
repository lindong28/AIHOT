import { readFile } from "node:fs/promises";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { importSelected, selectedStatus } from "@aihot/backend/backfill/selected";

const [command, file, ...flags] = process.argv.slice(2);
try {
  if (!["preview", "apply", "status"].includes(command ?? "") || !file || flags.some((f) => f !== "--json")) {
    throw new Error("用法：node scripts/backfill-selected.ts preview|apply|status <原文清单.jsonl> [--json]");
  }
  const input = (await readFile(file, "utf8")).split("\n").filter((s) => s.trim()).map((s) => JSON.parse(s));
  const results = command === "status" ? await selectedStatus(input) : await importSelected(input, command === "apply");
  if (flags.includes("--json")) console.log(JSON.stringify({ command, results }));
  else {
    console.log(command === "apply" ? "导入结束；queued 表示已入队，尚不代表分析完成。已有文章不覆盖、不重放。" :
      command === "preview" ? "只读预览；articleId 为空表示待导入。未入队、未调用模型。" : "以下为数据库当前结果；relevance 为空表示尚无当前版本判定，不能当作非 AI。");
    for (const result of results) console.log(JSON.stringify(result));
  }
  if (command === "status" && results.some((r) => "article" in r && (!r.article || !["analyzed", "blocked", "skipped"].includes(String(r.article.processing_state))))) process.exitCode = 2;
} catch (error) {
  console.error(`指定文章操作未完成：${error instanceof Error ? error.message : String(error)}。apply 已提交的条目保留；请先 status 核对，再用同一清单续跑。`);
  process.exitCode = 1;
} finally {
  await stopBoss();
  await closeDb();
}
