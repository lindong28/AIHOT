// Durable short-lived query identities live in pg-boss; articles and access policy remain live.
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { credential } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { ensureQueue, enqueue, getBoss, QUEUES } from "../jobs/queue.ts";
import { EMBEDDING_MODEL, EMBEDDING_DIMS, embeddingRuntimeIdentity } from "../providers/embeddings.ts";
import { gatewayConfigured } from "../providers/gateway.ts";
import { stableJson } from "../lib/ids.ts";
import { resolveSources } from "./catalog.ts";

const selectors = z.array(z.string().trim().min(1).max(200)).min(1).max(100).optional();
export const semanticEnvelope = z.object({
  requestId:z.uuid(),createdAt:z.iso.datetime({offset:true}),
  query:z.object({q:z.string().trim().min(1).max(2000),source:selectors,group:selectors,
    timeField:z.enum(["effective","published","discovered","updated"]).default("effective"),
    from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional(),
    selected:z.boolean().optional(),limit:z.number().int().min(1).max(100).default(40)}).strict()
    .refine(q=>!q.from||!q.to||Date.parse(q.from)<Date.parse(q.to)),
}).strict();
export type SemanticEnvelope = z.infer<typeof semanticEnvelope>;
export type EmbeddingProfile = {model:string;dimensions:number;profile:string;provider:string;gateway?:{route:string;actualModel:string}};
export type SemanticJob = SemanticEnvelope & {owner:string;embedding:EmbeddingProfile;providerBinding:string;expiresAt:string;fingerprint:string};
export type SemanticOutput = {status:"ready";vector:number[];receiptId:number} | {status:"failed";reason:string;receiptId:number|null};
export const QUERY_TTL_MS = 86400_000;
export class SemanticError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code:string,httpStatus=503) {super(code);this.code=code;this.httpStatus=httpStatus;}
}
export function tokenAllowed(owner:string,name="RESEARCH_SEMANTIC_TOKEN_SHA256") {
  const values = credential("auth",name)?.split(",").map(s=>s.trim()) ?? [];
  if (!values.length || values.some(v=>!/^[a-f0-9]{64}$/.test(v)) || !/^[a-f0-9]{64}$/.test(owner)) return false;
  let allowed=false;
  for (const value of values) allowed=timingSafeEqual(Buffer.from(owner,"hex"),Buffer.from(value,"hex")) || allowed;
  return allowed;
}
export function semanticProfile(): EmbeddingProfile {
  const model=process.env.RESEARCH_SEMANTIC_MODEL;
  const dimensions=Number(process.env.RESEARCH_SEMANTIC_DIMS);
  const profile=process.env.RESEARCH_SEMANTIC_PROFILE;
  const provider=process.env.RESEARCH_SEMANTIC_PROVIDER;
  // Operator attestation is deliberate: stored vectors have no provider provenance column.
  if (!model || model!==EMBEDDING_MODEL || dimensions!==EMBEDDING_DIMS || !Number.isInteger(dimensions) || dimensions<1 || dimensions>8192 || profile!=="title-summary-v1" || !provider?.trim() || provider.length>200)
    throw new SemanticError("embedding_profile_unverified");
  if (gatewayConfigured()) {
    const route=process.env.RESEARCH_SEMANTIC_ROUTE?.trim(),actualModel=process.env.RESEARCH_SEMANTIC_ACTUAL_MODEL?.trim();
    if (!route || !actualModel || !/^[a-f0-9]{64}$/.test(process.env.RESEARCH_SEMANTIC_REGISTRY_REVISION??"")) throw new SemanticError("embedding_profile_unverified");
    return {model,dimensions,profile,provider,gateway:{route,actualModel}};
  }
  return {model,dimensions,profile,provider};
}
export function assertSemanticAccess(owner:string) {
  if (!tokenAllowed(owner,"RESEARCH_TOKEN_SHA256")) throw new SemanticError("unauthorized",401);
  if (!tokenAllowed(owner)) throw new SemanticError("semantic_forbidden",403);
}
export function checkQueryIdentity(job:SemanticJob) {
  assertSemanticAccess(job.owner);
  if (Date.parse(job.expiresAt)<=Date.now()) throw new SemanticError("query_expired",410);
  if (stableJson(job.embedding)!==stableJson(semanticProfile())) throw new SemanticError("embedding_profile_changed",409);
  if (job.providerBinding!==embeddingRuntimeIdentity()) throw new SemanticError("embedding_provider_changed",409);
}
function jobId(owner:string,requestId:string) {
  const h=createHash("sha256").update(`${owner}:${requestId.toLowerCase()}`).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
export async function submitSemanticQuery(owner:string,raw:unknown) {
  assertSemanticAccess(owner);
  const envelope=semanticEnvelope.parse(raw),now=Date.now(),created=Date.parse(envelope.createdAt);
  if (created+QUERY_TTL_MS<=now) throw new SemanticError("query_expired",410);
  if (created>now+60_000) throw new SemanticError("created_at_in_future",400);
  const embedding=semanticProfile();
  const fingerprint=createHash("sha256").update(stableJson(raw)).digest("hex");
  const id=jobId(owner,envelope.requestId);
  await ensureQueue(QUEUES.semanticQuery);
  const result=await sql.begin(async tx=>{
    // One cross-process admission lock prevents capacity overshoot and concurrent-key races.
    await tx`SELECT pg_advisory_xact_lock(hashtext('research.semantic-query.admission'))`;
    const [existing]=await tx`SELECT data FROM pgboss.job WHERE name=${QUEUES.semanticQuery} AND id=${id}::uuid`;
    if (existing) {
      const job=existing.data as SemanticJob;
      if (job.fingerprint!==fingerprint) throw new SemanticError("request_id_conflict",409);
      checkQueryIdentity(job);
      return {id,job,reused:true};
    }
    await resolveSources(tx,envelope.query.source,envelope.query.group);
    const [count]=await tx`SELECT count(*)::int AS retained,count(*) FILTER (WHERE state IN ('created','retry','active'))::int AS pending FROM pgboss.job WHERE name=${QUEUES.semanticQuery}`;
    if (count!.retained>=1000 || count!.pending>=64) throw new SemanticError("semantic_capacity_exhausted",503);
    const job:SemanticJob={...envelope,owner,embedding,providerBinding:embeddingRuntimeIdentity(),expiresAt:new Date(created+QUERY_TTL_MS).toISOString(),fingerprint};
    const sent=await enqueue(QUEUES.semanticQuery,job,{id,retentionSeconds:Math.max(1,Math.ceil((created+QUERY_TTL_MS-now)/1000))},tx);
    if (!sent) throw new SemanticError("semantic_enqueue_failed");
    return {id,job,reused:false};
  });
  return result;
}
export async function getSemanticJob(owner:string,id:string) {
  const boss=await getBoss();
  const job=await boss.getJobById<SemanticJob>(QUEUES.semanticQuery,id);
  if (!job || job.data.owner!==owner) throw new SemanticError("not_found",404);
  assertSemanticAccess(owner);
  return job;
}
export async function queryReceipt(db:Db,id:string) {
  // Subject is the opaque job identity, never the query, digest or provider error.
  const [r]=await db`SELECT id,status,usage,cost,currency,cost_basis FROM receipts WHERE purpose='research_query_embedding' AND subject=${`semantic:${id}`} ORDER BY id DESC LIMIT 1`;
  return r ? {id:r.id,status:r.status,usage:r.usage??null,cost:r.cost==null?null:{amount:r.cost,currency:r.currency,basis:r.cost_basis}} : {id:null,status:null,usage:null,cost:null};
}
export function semanticTaskView(id:string,job:SemanticJob,status:string,receipt:Awaited<ReturnType<typeof queryReceipt>>,reason?:string) {
  return {id,requestId:job.requestId,createdAt:job.createdAt,expiresAt:job.expiresAt,status,embedding:job.embedding,receipt,...(reason?{reason}:{})};
}
