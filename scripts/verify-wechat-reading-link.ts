// Import already obtained browser evidence; this command deliberately performs no upstream request.
import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { closeDb } from "@aihot/backend/db";
import { associateWechatReadingEvidence } from "@aihot/backend/content/wechat-reading-ops";

let stage = "arguments";
try {
  const {values} = parseArgs({options:{article:{type:"string"},"identity-key":{type:"string"},evidence:{type:"string"},
    operator:{type:"string"},apply:{type:"boolean",default:false},json:{type:"boolean",default:false},help:{type:"boolean",default:false}},strict:true});
  if (values.help) {
    console.log("用法：node scripts/verify-wechat-reading-link.ts (--article ID | --identity-key KEY) --evidence FILE --operator SOURCE [--apply] [--json]");
    console.log("默认只校验证据与现存归属；--apply 才登记并回读。证据来自已取得的真实正文页面，observedAt 必须是实际取证时间。此命令不访问微信。");
  } else {
    if (!values.evidence || !values.operator || Boolean(values.article) === Boolean(values["identity-key"])) throw new Error("Invalid arguments");
    stage = "read_evidence";
    if ((await stat(values.evidence)).size > 64 * 1024) throw new Error("Evidence exceeds 64 KiB");
    const observation: unknown = JSON.parse(await readFile(values.evidence,"utf8"));
    stage = "validate_and_associate";
    const result = await associateWechatReadingEvidence({articleId:values.article,identityKey:values["identity-key"],
      observation,operator:values.operator,apply:values.apply});
    if (values.json) console.log(JSON.stringify(result));
    else {
      console.log(values.apply ? "阅读链接关联已提交并回读；相同映射可重复执行。" : "阅读链接证据与现存归属校验通过；尚未写入，使用 --apply 登记。");
      console.log(`资料：${result.articleId ?? result.identityKey}\n阅读链接：${result.readingUrl}\n观测时间：${result.observedAt}`);
      console.log("采集地址、正文、identity 与 docId 保留。结果表示已有证据通过一致性核对，不代表刚刚重新访问或保证未来可打开；请继续核对项目 API 和页面。");
    }
  }
} catch {
  // DB/parser failures can include parameters. Keep the stage, never echo credentials or raw evidence.
  console.error(`阅读链接关联未取得成功回执（阶段：${stage}）。检查参数、证据四参数及声明一致性、目标归属冲突和数据库连接；若使用过 --apply，先用同一证据不带 --apply 预览核对已有映射，再决定是否重试。`);
  process.exitCode = 1;
} finally { await closeDb(); }
