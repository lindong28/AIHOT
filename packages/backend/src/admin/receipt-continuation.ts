// Changed-input recovery never releases the original refused request.
import { sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { describeChatRequest, MODELS } from "../providers/llm.ts";
import { logicalKeyFor } from "../providers/receipts.ts";
import { receiptOutcome } from "../providers/receipt-review.ts";
import { modelFor } from "../editorial/models.ts";
import { loadAnalyzeInput, prefilterRequest, scoreRequest, structureRequest, understandRequest } from "../editorial/analyze.ts";
import { firstImagePart } from "../editorial/input.ts";
import { analysisTag, recoverTask, type Receipt } from "./receipt-recovery.ts";
import { Conflict } from "./sources.ts";

/** Read-only preview; image recovery uses only the already stored thumbnail. */
export async function previewArticleContinuation(id: number) {
  const [r] = await sql`SELECT r.*,a.error_details,a.error AS attempt_error,a.response AS attempt_response,v.disposition
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts
    LEFT JOIN receipt_reviews v ON v.receipt_id=r.id AND v.attempt=r.attempts WHERE r.id=${id}`;
  if (!r) throw new Conflict("回执或当前 attempt 不存在");
  const match = /^article:([^@]+)@(\d+)$/.exec(r.subject ?? "");
  const opts = analysisTag(r as unknown as Receipt);
  if (!match || !opts || r.service === 'backfill') throw new Conflict("此入口仅支持普通文章分析回执");
  const article = await loadAnalyzeInput(match[1]!);
  if (!article || article.revision !== Number(match[2])) throw new Conflict("文章输入版本已改变，请重新核对");
  const [state] = await sql`SELECT processing_state,managed_backfill_id FROM articles WHERE id=${article.id}`;
  const siblings = await sql`SELECT r.id,r.purpose,r.logical_key,r.status,r.attempts,a.error_details,a.error,a.response,a.response IS NOT NULL AS has_response,a.output_validation_error
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts WHERE r.subject=${r.subject}`;
  const blockers = siblings.filter(s => receiptOutcome(s.error_details,s.error,s.response) === 'content_policy_rejected').map(s => Number(s.id));
  const models = {prefilter:await modelFor('prefilter'), score:await modelFor('score'), structure:await modelFor('structure'), understand:await modelFor('understand')};
  const requests = [
    {stage:'prefilter', request:describeChatRequest({...prefilterRequest(article),model:models.prefilter,attemptTag:opts.attemptTag})},
    {stage:'score-1', request:describeChatRequest(scoreRequest(article,models.score,1,opts))},
    {stage:'score-2', request:describeChatRequest(scoreRequest(article,models.score,2,opts))},
    {stage:'structure', request:describeChatRequest(structureRequest(article,models.structure,opts))},
  ];
  if (r.purpose === 'understand_article') {
    const image = MODELS[models.understand]?.vision === false ? null : await firstImagePart(article,{cacheOnly:true});
    requests.push({stage:'understand',request:describeChatRequest(understandRequest(article,models.understand,image,opts))});
    if (image) requests.push({stage:'understand-text',request:describeChatRequest(understandRequest(article,models.understand,null,opts))});
  }
  const stages = requests.map(({stage,request}) => {
    const key = logicalKeyFor(request);
    const found = siblings.find(s => s.logical_key === key);
    return {stage,logicalKey:key,userHash:String(request.requestSummary!.userHash),model:request.model,
      receiptId:found ? Number(found.id) : null, reusable:!!found && ['received','completed'].includes(found.status) && found.has_response && !found.output_validation_error};
  });
  const stage = r.purpose === 'score_article' ? (r.logical_key.endsWith(':score-1') ? 'score-1' : 'score-2') : r.purpose.replace('_article','');
  const target = stages.find(s => s.stage === stage);
  const outcome = receiptOutcome(r.error_details,r.attempt_error,r.attempt_response);
  const changed = !!target && target.userHash !== r.request?.userHash && target.logicalKey !== r.logical_key;
  const eligible = outcome === 'invalid_request' && changed && !blockers.length && state?.processing_state === 'failed' && !state.managed_backfill_id
    && !['stopped','superseded'].includes(r.disposition) && ['unknown','failed'].includes(r.status);
  const snapshot = {id:Number(r.id),attempt:Number(r.attempts),articleId:article.id,revision:article.revision,oldKey:r.logical_key,
    oldUserHash:r.request?.userHash ?? null,rootAttemptTag:opts.attemptTag ?? null,targetLogicalKey:target?.logicalKey ?? null,outcome,blockers,stages,eligible,changed};
  return {...snapshot, snapshotHash:sha256(stableJson(snapshot))};
}

export async function continueCorrectedArticle(id: number, input: {snapshotHash:string; note:string; acceptDuplicateCharge:boolean},actor:string) {
  if (!input.note?.trim() || input.note.length>2000 || input.acceptDuplicateCharge!==true) throw new Conflict("须说明具体修正依据并确认新请求可能再次计费");
  const plan = await previewArticleContinuation(id);
  if (plan.snapshotHash !== input.snapshotHash || !plan.eligible) throw new Conflict("修正预览已变化或不满足续跑条件；不能原样重放拒绝请求");
  return sql.begin(async tx => {
    const [r] = await tx`SELECT * FROM receipts WHERE id=${id} FOR UPDATE`;
    const [a] = await tx`SELECT * FROM articles WHERE id=${plan.articleId} FOR UPDATE`;
    if (!r || r.attempts!==plan.attempt || r.logical_key!==plan.oldKey || a?.revision!==plan.revision || a.processing_state!=='failed' || a.managed_backfill_id) throw new Conflict("回执或文章已变化");
    const [closed] = await tx`SELECT 1 FROM receipt_reviews WHERE receipt_id=${id} AND attempt=${plan.attempt} AND disposition<>'open'`;
    if (closed) throw new Conflict("已停止或结案，不能续跑");
    const blockers = await tx`SELECT r.id,a.error_details,a.error,a.response FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts WHERE r.subject=${r.subject}`;
    if (blockers.some(b=>receiptOutcome(b.error_details,b.error,b.response)==='content_policy_rejected')) throw new Conflict("同篇文章存在审核拒绝，不能间接重放");
    const evidence = {correction:input.note.trim(),snapshotHash:plan.snapshotHash,plannedRequests:plan.stages,oldUserHash:plan.oldUserHash,
      rootAttemptTag:plan.rootAttemptTag,targetLogicalKey:plan.targetLogicalKey};
    await tx`INSERT INTO receipt_reviews(receipt_id,attempt,outcome,disposition,note,actor,evidence)
      VALUES (${id},${plan.attempt},'invalid_request','open',${input.note.trim()},${actor},${tx.json(evidence)})
      ON CONFLICT(receipt_id,attempt) DO UPDATE SET evidence=excluded.evidence,note=excluded.note,actor=excluded.actor,updated_at=now()`;
    const recovery = await recoverTask(tx,r as unknown as Receipt);
    if (!recovery.requeued) throw new Conflict("文章未成功入队，修正授权未保存");
    await tx`INSERT INTO audit_log(actor,action,subject,reason,after) VALUES(${actor},'receipt.correct',${`receipt:${id}`},${input.note.trim()},${tx.json({attempt:plan.attempt,...evidence,...recovery})})`;
    return {id,attempt:plan.attempt,...recovery};
  });
}

/** A policy-refused dependency stops this article, preserving all paid facts and valid stages. */
export async function stopPolicyBlockedArticle(id:number,expectedAttempt:number,actor:string) {
  return sql.begin(async tx=>{
    const [r] = await tx`SELECT * FROM receipts WHERE id=${id} FOR UPDATE`;
    if (!r || r.attempts!==expectedAttempt || r.status==='pending') throw new Conflict("回执已变化或仍在调用");
    const match = /^article:([^@]+)@(\d+)$/.exec(r.subject ?? '');
    if (!match) throw new Conflict("不是文章分析回执");
    const [article] = await tx`SELECT * FROM articles WHERE id=${match[1]!} FOR UPDATE`;
    if (!article || article.revision!==Number(match[2]) || article.managed_backfill_id || !['failed','blocked'].includes(article.processing_state)) throw new Conflict("文章状态或版本已变化");
    const related = await tx`SELECT r.id,r.attempts,a.error_details,a.error,a.response FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts WHERE r.subject=${r.subject}`;
    const blockers=related.filter(x=>receiptOutcome(x.error_details,x.error,x.response)==='content_policy_rejected').map(x=>Number(x.id));
    if (!blockers.length) throw new Conflict("没有明确的审核拒绝依据");
    const note='同篇文章的必要阶段被内容审核拒绝；停止业务恢复，历史费用保留待核';
    await tx`INSERT INTO receipt_reviews(receipt_id,attempt,outcome,disposition,note,actor,evidence)
      VALUES(${id},${expectedAttempt},${receiptOutcome(related.find(x=>x.id===r.id)?.error_details,related.find(x=>x.id===r.id)?.error,related.find(x=>x.id===r.id)?.response)},'stopped',${note},${actor},${tx.json({blockers,articleId:article.id,revision:article.revision})})
      ON CONFLICT(receipt_id,attempt) DO UPDATE SET disposition='stopped',note=excluded.note,evidence=excluded.evidence,updated_at=now()`;
    await tx`UPDATE articles SET processing_state='blocked',processing_retry_at=NULL,processing_error=${note} WHERE id=${article.id}`;
    await tx`INSERT INTO audit_log(actor,action,subject,reason,after) VALUES(${actor},'receipt.stop_dependency',${`receipt:${id}`},${note},${tx.json({attempt:expectedAttempt,blockers})})`;
    return {id,attempt:expectedAttempt,articleId:article.id,blockers,state:'blocked'};
  });
}
