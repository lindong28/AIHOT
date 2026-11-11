import type { PgBoss } from "pg-boss";
import { sql } from "../db.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import { embedResearchQuery, embeddingsAvailable, embeddingService } from "../providers/embeddings.ts";
import { BudgetExceededError, completeReceipt, ReceiptBusyError, ReceiptRetryError, ReceiptUnknownError, ProviderRejectedError, ReceiptRecoveryStoppedError } from "../providers/receipts.ts";
import { checkQueryIdentity, SemanticError, queryReceipt, type SemanticJob, type SemanticOutput } from "../research/semantic.ts";

export async function executeSemanticQuery(id:string,data:SemanticJob):Promise<SemanticOutput> {
  try {
    checkQueryIdentity(data);
    if (!embeddingsAvailable()) throw new SemanticError("model_calls_unavailable");
    const [budget]=await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service=${embeddingService}`;
    if (!budget || [budget.per_minute,budget.per_hour,budget.per_day].some(n=>!Number.isFinite(n)||n<=0)) throw new SemanticError("embedding_budget_unconfigured");
    const pin=data.embedding.gateway ? {model:data.embedding.model,routes:[{provider:data.embedding.provider,...data.embedding.gateway}],registryRevision:process.env.RESEARCH_SEMANTIC_REGISTRY_REVISION} : undefined;
    const encoded=await embedResearchQuery(data.query.q,`semantic:${id}`,{owner:data.owner,requestId:data.requestId,createdAt:data.createdAt,embedding:data.embedding,providerBinding:data.providerBinding},pin);
    // Re-check permission/config after a potentially long paid call; keep its receipt either way.
    checkQueryIdentity(data);
    await completeReceipt(sql,encoded.receiptId);
    return {status:"ready",...encoded};
  } catch(error) {
    // Native retry keeps this job ID. The receipt gate prevents a second dispatch of pending work.
    if (error instanceof ReceiptBusyError || error instanceof ReceiptRetryError) throw new Error("semantic_receipt_pending");
    const receipt=await queryReceipt(sql,id);
    const reason=error instanceof SemanticError ? error.code : error instanceof BudgetExceededError ? "embedding_budget_exhausted" :
      error instanceof ReceiptUnknownError || receipt.status==="unknown" ? "receipt_unknown" : error instanceof ReceiptRecoveryStoppedError ? "receipt_recovery_stopped" :
      error instanceof ProviderRejectedError ? "embedding_provider_rejected" : "embedding_failed";
    // Provider diagnostics remain in the existing restricted receipt/attempt store.
    console.error(JSON.stringify({event:"semantic_query_failed",jobId:id,receiptId:receipt.id,reason}));
    return {status:"failed",reason,receiptId:receipt.id};
  }
}
export async function registerSemanticJobs(boss:PgBoss) {
  await ensureQueue(QUEUES.semanticQuery);
  // Shared paid-service budgets bound dispatch across processes; keep this queue's workers bounded.
  await boss.work<SemanticJob>(QUEUES.semanticQuery,{localConcurrency:2,pollingIntervalSeconds:1},async([job])=>{
    if (job) return executeSemanticQuery(job.id,job.data);
  });
}
