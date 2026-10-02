// Privileged operator tool: evidence must be generated from the trusted personal Gateway ledger.
// stdout is JSON for the export/apply pipeline; stderr is the complete human summary.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { GatewayEvidenceSchema, releaseUnknownReceipt } from "@aihot/backend/admin/receipt-recovery";

const { values } = parseArgs({ options: { snapshot: { type: "boolean" }, evidence: { type: "string" }, apply: { type: "boolean" } } });
try {
  if (values.snapshot && !values.evidence && !values.apply) {
    const receipts = await sql`SELECT id AS "receiptId", request_id AS "requestId" FROM receipts
      WHERE status = 'unknown' AND request ? 'gateway' AND request_id IS NOT NULL ORDER BY id`;
    console.log(JSON.stringify({ version: 1, receipts }));
    console.error(`已导出 ${receipts.length} 条 Gateway 未知回执的身份；未修改数据。请在个人 Gateway 主机用 export-gateway-receipts.py 核对账本。`);
  } else if (values.evidence && !values.snapshot) {
    const evidence = z.object({ version: z.literal(1), capturedAt: z.string().datetime({ offset: true }), entries: z.array(GatewayEvidenceSchema) })
      .parse(JSON.parse(await readFile(values.evidence, "utf8")));
    const age = Date.now() - Date.parse(evidence.capturedAt);
    if (age < -60_000 || age > 15 * 60_000) throw new Error("核对快照超过 15 分钟或来自未来，请重新导出；未应用本批次");
    if (new Set(evidence.entries.map((e) => e.receiptId)).size !== evidence.entries.length) throw new Error("证据含重复回执；未应用本批次");
    const results: unknown[] = [];
    // Four transactions share the application DB pool and the queue's four-connection pool.
    for (let i = 0; i < evidence.entries.length; i += 4) {
      const entries = evidence.entries.slice(i, i + 4);
      const batch = await Promise.allSettled(entries.map(async (entry) => {
        const result = await releaseUnknownReceipt(entry.receiptId, {
          evidence: entry, dryRun: !values.apply, actor: "gateway.reconcile", billed: false,
          error: `Gateway 账本核对：该请求在任何模型 attempt 前被拒绝；request ${entry.requestId}`,
          note: `只读账本快照 ${evidence.capturedAt}；仅恢复未派发请求`,
        });
        return result ?? { id: entry.receiptId, status: "unchanged", requeued: false, recovery: "receipt_not_unknown" };
      }));
      let failed = false;
      for (const [index, settled] of batch.entries()) {
        if (settled.status === "fulfilled") {
          results.push(settled.value);
          console.log(JSON.stringify(settled.value));
        } else {
          failed = true;
          console.log(JSON.stringify({ id: entries[index]!.receiptId, status: "apply_error", requeued: false, recovery: String(settled.reason) }));
        }
      }
      if (failed) throw new Error("本组至少一个事务失败；本组全部终态已输出，未开始后续组");
    }
    const rows = results as Array<{ status: string; requeued: boolean; recovery: string }>;
    const released = rows.filter((r) => r.status === "failed").length;
    const eligible = rows.filter((r) => r.recovery === "eligible_not_dispatched").length;
    console.error(values.apply
      ? `核对 ${rows.length} 条：已放行 ${released} 条，实际新排队 ${rows.filter((r) => r.requeued).length} 个任务；其余保留原状态。未核实费用的请求没有自动重试，明细见 stdout。`
      : `预览 ${rows.length} 条：${eligible} 条满足未派发条件；未更改任何回执或任务。确认可信账本后使用同一命令加 --apply，其他结果继续核对。`);
  } else {
    throw new Error("用法：--snapshot，或 --evidence <可信账本核对文件> [--apply]；默认只预览");
  }
} catch (error) {
  console.error(`回执核对未完成：${String(error)}。如为应用模式，前面已输出的成功事务保留，可重新导出后续跑。`);
  process.exitCode = 1;
} finally {
  await stopBoss();
  await closeDb();
}
