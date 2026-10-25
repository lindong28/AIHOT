import { parseArgs } from "node:util";
import { closeDb } from "../packages/backend/src/db.ts";
import { stopBoss } from "../packages/backend/src/jobs/queue.ts";
import { previewArticleContinuation, continueCorrectedArticle, stopPolicyBlockedArticle } from "../packages/backend/src/admin/receipt-continuation.ts";

const {values}=parseArgs({options:{receipt:{type:'string'},apply:{type:'boolean'},snapshot:{type:'string'},note:{type:'string'},'accept-duplicate-charge':{type:'boolean'},'stop-policy-blocked':{type:'boolean'},attempt:{type:'string'}}});
try {
  const id=Number(values.receipt);
  if(!Number.isSafeInteger(id)||id<1) throw new Error('必须指定 --receipt <回执ID>');
  if(values['stop-policy-blocked']) {
    const attempt=Number(values.attempt);
    if(!values.apply || !Number.isSafeInteger(attempt)||attempt<1) throw new Error('停止依赖阻断须 --apply --attempt <当前次数>');
    console.log(JSON.stringify(await stopPolicyBlockedArticle(id,attempt,'receipt-continuation-cli')));
  } else if(values.apply) {
    if(!values.snapshot) throw new Error('须先预览，再传 --snapshot <snapshotHash>，核对具体修正和完整业务调用预算');
    console.log(JSON.stringify(await continueCorrectedArticle(id,{snapshotHash:values.snapshot,note:values.note??'',acceptDuplicateCharge:values['accept-duplicate-charge']===true},'receipt-continuation-cli')));
  } else {
    const preview=await previewArticleContinuation(id);
    console.log(JSON.stringify({mode:'preview',...preview,notice:'未修改数据、未调用模型。received仅在logicalKey完全相同时复用；写作及后续业务阶段仍受原流水线预算。历史费用未知保留。'}));
  }
} catch(error) { console.error(error instanceof Error?error.message:'回执处置失败'); process.exitCode=1; }
finally { await stopBoss(); await closeDb(); }
