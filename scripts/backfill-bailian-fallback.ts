import { closeDb } from "@aihot/backend/db";
import { enableBailianFallback } from "../packages/backend/src/backfill/fallback.ts";

try {
  const [id, ...extra] = process.argv.slice(2);
  if (!id || extra.length) throw new Error("用法：node scripts/backfill-bailian-fallback.ts <暂停批次ID>");
  await enableBailianFallback(id);
  console.log("已加入个人百炼订阅备用路线；原模型绑定和回执身份保留，未调用模型、未重试失败条目。续跑前仍会验证 Gateway 路线与订阅归属。");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await closeDb();
}
