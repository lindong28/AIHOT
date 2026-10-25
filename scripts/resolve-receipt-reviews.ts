// Evidence-only disposition; this tool never dispatches or queues a paid request.
import { parseArgs } from "node:util";
import { closeDb } from "@aihot/backend/db";
import { settleReceiptReviews } from "@aihot/backend/admin/receipt-reviews";
const { values } = parseArgs({ options: { apply: { type: "boolean" } } });
try {
  const result = await settleReceiptReviews({ dryRun: !values.apply });
  console.error(`${values.apply ? "已记录处置" : "仅预览，未写入"}：分类 ${result.classified}，业务结案 ${result.superseded}；原费用保留，未派发或排队付费请求。`);
  console.log(JSON.stringify({ mode: values.apply ? "applied" : "preview", ...result, dispatched: 0, billingChanged: false }));
} catch {
  console.error("回执处置未完成；成功事务会保留，可重新预览后续跑。未触发付费调用。");
  process.exitCode = 1;
} finally { await closeDb(); }
