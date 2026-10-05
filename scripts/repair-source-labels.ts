// Dry-run by default. This command never invokes models or sends notifications.
import { closeDb } from "@aihot/backend/db";
import { repairHotSourceLabels } from "../packages/backend/src/events/hot-read.ts";
import { sourceLabelCandidates, repairSourceLabel, repairReportSourceLabels } from "../packages/backend/src/publication/repair-source-labels.ts";

const args = process.argv.slice(2);
if (args.some(a => !["--apply", "--json"].includes(a))) throw new Error("Usage: node scripts/repair-source-labels.ts [--apply] [--json]");
const apply = args.includes("--apply");
const result = { mode: apply ? "apply" : "dry-run", scanned: 0, candidates: 0, updated: 0, reports: 0, hotRankings: 0,
  bySource: {} as Record<string, number>, examples: [] as Array<{ articleId: string; before: string; after: string }> };
try {
  let after = "";
  for (;;) {
    const batch = await sourceLabelCandidates(after);
    if (!batch.length) break;
    for (const row of batch) {
      result.scanned++;
      if (row.before === row.after) continue;
      result.candidates++;
      result.bySource[row.sourceId] = (result.bySource[row.sourceId] ?? 0) + 1;
      if (result.examples.length < 10) result.examples.push({ articleId: row.articleId, before: row.before, after: row.after });
      // Selected corrections share the global ordered ledger; serial commits preserve its ordering.
      if (apply && await repairSourceLabel(row.articleId)) result.updated++;
    }
    after = batch.at(-1)!.articleId;
  }
  result.reports = await repairReportSourceLabels(apply);
  if (apply) result.hotRankings = await repairHotSourceLabels();
  if (args.includes("--json")) console.log(JSON.stringify(result));
  else {
    console.log(apply ? `来源修复完成：扫描 ${result.scanned} 篇，更新 ${result.updated} 篇、${result.reports} 份刊物、${result.hotRankings} 份热榜展示。`
      : `预览完成：扫描 ${result.scanned} 篇，${result.candidates} 篇来源待修复；未写入数据。使用 --apply 执行。`);
    for (const row of result.examples) console.log(`${row.articleId}: ${row.before} → ${row.after}`);
    console.log("仅修复来源展示和搜索/引用元数据；原文、采集身份、入选状态与正文权限保持原值。未调用模型或发送通知。");
  }
} finally { await closeDb(); }
