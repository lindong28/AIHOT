import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";
import { sql, closeDb } from "../packages/backend/src/db.ts";
import { stopBoss } from "../packages/backend/src/jobs/queue.ts";
import { previewReceiptRecovery, createReceiptRecoveryBatch, advanceReceiptRecoveryBatch, settleReceiptRecoveryBatch, receiptRecoveryStatus } from "../packages/backend/src/admin/receipt-batch-recovery.ts";

const { values } = parseArgs({ options: {
  batch: { type: "string" }, apply: { type: "boolean", default: false }, note: { type: "string" },
  status: { type: "boolean", default: false }, json: { type: "boolean", default: false },
  limit: { type: "string", default: "4" }, "wait-seconds": { type: "string", default: "0" },
} });
let lock: Awaited<ReturnType<typeof sql.reserve>> | undefined;
try {
  const limit = Number(values.limit), wait = Number(values["wait-seconds"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(wait) || wait < 0 || wait > 86400) throw new Error("limit 须为 1..100，wait-seconds 须为 0..86400");
  if (!values.apply && !values.status) {
    const rows = await previewReceiptRecovery();
    if (values.json) console.log(JSON.stringify({ mode: "preview", receipts: rows }));
    else console.log(`预览：${rows.length} 条旧异常，${new Set(rows.map(r => JSON.stringify(r.target))).size} 个业务目标；${rows.filter(r => r.target.kind === 'unsupported').length} 条暂不支持自动恢复。未修改数据、未调用模型。\n执行时指定 --apply --batch <批次名> --note <授权说明>；重放可能再次计费，原费用未知仍保留。`);
  } else {
    if (!values.batch) throw new Error("必须指定 --batch；沿用同一批次名才能幂等续跑");
    lock = await sql.reserve();
    const [held] = await lock`SELECT pg_try_advisory_lock(hashtext('receipt-recovery-script')) AS locked`;
    if (!held?.locked) throw new Error("已有恢复脚本运行，请等待该进程结束");
    if (values.apply) {
      if (!values.note) throw new Error("--apply 必须提供 --note，说明这批重放已获授权，可能再次计费");
      await createReceiptRecoveryBatch(values.batch, values.note);
    }
    const deadline = Date.now() + wait * 1000;
    let result;
    do {
      if (values.apply) await advanceReceiptRecoveryBatch(values.batch, limit);
      else await settleReceiptRecoveryBatch(values.batch);
      result = await receiptRecoveryStatus(values.batch);
      if (!result.counts.planned && !result.counts.queued || Date.now() >= deadline) break;
      if (!values.json) console.log(`批次 ${values.batch}：已恢复 ${result.counts.recovered ?? 0}，待排队 ${result.counts.planned ?? 0}，处理中 ${result.counts.queued ?? 0}，未解决 ${result.counts.blocked ?? 0}。`);
      await setTimeout(Math.min(15_000, Math.max(0, deadline-Date.now())));
    } while (Date.now() <= deadline);
    if (values.json) console.log(JSON.stringify(result));
    else console.log(`批次 ${values.batch}：已恢复 ${result!.counts.recovered ?? 0}，待排队 ${result!.counts.planned ?? 0}，处理中 ${result!.counts.queued ?? 0}，未解决 ${result!.counts.blocked ?? 0}。历史调用及费用记录保留。${result!.outstanding.length ? '\n本批尚未全部结案；同一命令可续跑，--status --json 可查看剩余目标。新失败不会被自动再次放行。' : '\n本批全部结案，重复执行不会重新调用模型。'}`);
    if (result!.outstanding.length) process.exitCode = 2;
  }
} catch (e) {
  console.error(`回执恢复未完成：${String(e)}`);
  process.exitCode = 1;
} finally {
  if (lock) { await lock`SELECT pg_advisory_unlock(hashtext('receipt-recovery-script'))`; lock.release(); }
  await stopBoss();
  await closeDb();
}
