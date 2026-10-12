// node --env-file=/path/app.env scripts/repair-wechat-fulltext.ts audit|enable|apply [manifest.json]
import { readFile, writeFile } from "node:fs/promises";
import { auditWechatBodies, enableWechatFulltext, repairWechatBody, repairSchema } from "@aihot/backend/content/wechat-repair";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
const [command,file] = process.argv.slice(2);
try {
  if (command === "audit" && file) {
    const report = await auditWechatBodies();
    await writeFile(file,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
    console.log(`已检查 ${report.total} 篇公众号文章；${report.siteDisabled} 篇来源关闭本站全文，${report.gaps.length} 篇需核对。清单：${file}。此检查不证明逐篇原文完整。`);
  } else if (command === "enable") {
    const r = await enableWechatFulltext();
    console.log(`已更新 ${r.changed}/${r.sources} 个公众号来源，重建 ${r.rebuilt} 篇公开投影。未调用模型；请核对站点正文和残缺清单。`);
  } else if (command === "apply" && file) {
    const rows: unknown = JSON.parse(await readFile(file,"utf8"));
    if (!Array.isArray(rows) || !rows.length) throw new Error("Manifest must be a nonempty array");
    const repairs = rows.map(r=>repairSchema.parse(r));
    for(const repair of repairs) {
      const r = await repairWechatBody(repair);
      console.log(`${r.articleId}：${r.reused ? "已应用，未重放" : r.textChanged ? "正文已修复，等待重新分析" : "HTML 已修复，分析保留"}${r.runId ? `；${r.reused ? "关联" : "待启动"}批次 ${r.runId}` : ""}`);
    }
    console.log("清单应用结束。请通过关联批次状态和文章入口核对；待重新分析项尚未完成发布复核。");
  } else throw new Error("Usage: repair-wechat-fulltext.ts audit <new-report.json> | enable | apply <manifest.json>");
} catch(error) {
  console.error(`公众号正文操作未完成：${error instanceof Error ? error.message : String(error)}。此前已提交项保留；核对 audit 后可用同一清单续跑。`);
  process.exitCode=1;
} finally { await stopBoss(); await closeDb(); }
