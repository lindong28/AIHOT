import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { credential } from "@aihot/backend/config";
import { withSearchCapacity, SearchBusyError } from "@aihot/backend/publication/pool";
import { listArticles, listSources, readArticle, resolveArticle, articleMarkdown, ResearchInputError, rankSemanticArticles } from "@aihot/backend/research/read";
import { submitSemanticQuery, getSemanticJob, semanticTaskView, checkQueryIdentity, queryReceipt, SemanticError, type SemanticOutput } from "@aihot/backend/research/semantic";
import { sql } from "@aihot/backend/db";
import { validSemanticVector } from "@aihot/backend/providers/embeddings";
import { listGroups } from "@aihot/backend/research/catalog";
import { researchOpenApi, researchOpenApiV2, researchOpenApiV3 } from "@aihot/contracts/research";

const paging = {limit:z.coerce.number().int().min(1).max(100).default(40),cursor:z.string().max(2048).optional()};
const selector = z.string().trim().min(1).max(200);
const selectors = z.union([selector,z.array(selector).min(1).max(100)]).transform(v=>typeof v==="string"?[v]:v).optional();
const articleQuery = z.object({...paging,source:selectors,group:selectors,timeField:z.enum(["effective","published","discovered","updated"]).optional(),q:z.string().max(256).optional(),
  from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional(),
  selected:z.enum(["true","false"]).transform(v=>v==="true").optional()}).strict().refine(q=>!q.from||!q.to||Date.parse(q.from)<Date.parse(q.to));
const sourceQuery = z.object({...paging,q:z.string().max(256).optional(),kind:z.string().max(80).optional()}).strict();
const format = z.enum(["json","markdown"]).default("json");

export function registerResearch(app: FastifyInstance) {
  for (const version of [1,2,3] as const) app.register(async privateApi => {
    function project<T extends {readingUrl: string | null}>(item: T) {
      if (version >= 2) return item;
      const {readingUrl: _readingUrl,...v1} = item;
      return v1;
    }
    const keys = new WeakMap<object,string>();
    privateApi.addHook("onRequest",async(req,reply)=>{
      reply.header("Cache-Control","no-store").header("Vary","Authorization").header("X-Content-Type-Options","nosniff");
      const configured = credential("auth","RESEARCH_TOKEN_SHA256");
      const digests = configured?.split(",").map(v=>v.trim()) ?? [];
      if (!digests.length || digests.some(v=>! /^[a-f0-9]{64}$/.test(v))) return reply.code(404).send({error:"not_found"});
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ") || auth.length>1031) return reply.code(401).send({error:"unauthorized"});
      const digest = createHash("sha256").update(auth.slice(7)).digest();
      // Compare every configured digest; never accept admin/ingest sessions as research access.
      let accepted = false;
      for (const value of digests) accepted = timingSafeEqual(digest,Buffer.from(value,"hex")) || accepted;
      if (!accepted) return reply.code(401).send({error:"unauthorized"});
      keys.set(req,digest.toString("hex"));
    });
    privateApi.setErrorHandler((error,req,reply)=>{
      if (error instanceof SemanticError) return reply.code(error.httpStatus).send({error:error.code,reason:error.code});
      if (error instanceof ResearchInputError && error.selector !== undefined) return reply.code(400).send({error:error.message,selector:error.selector,candidates:error.candidates});
      if (error instanceof z.ZodError || error instanceof ResearchInputError) return reply.code(400).send({error:"invalid_request"});
      if (error instanceof SearchBusyError) return reply.header("Retry-After",String(error.retryAfter)).code(503).send({error:"busy"});
      // Database errors may contain stored text or parameters. Log no error object or request URL.
      req.log.error({requestId:req.id},"private research unavailable");
      return reply.code(503).send({error:"unavailable"});
    });
    async function read<T>(fn: Parameters<typeof withSearchCapacity<T>>[0]) {
      return withSearchCapacity(async db=>{
        await db`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
        const [state] = await db`SELECT articles_complete AND materials_complete AS ready FROM research_index_state`;
        if (!state?.ready) return {error:"index_not_ready"} as const;
        return fn(db);
      });
    }
    const unavailable = (v: unknown): v is {error:string} => typeof v==="object" && v!==null && "error" in v;
    if (version===3) {
      privateApi.post("/semantic-queries",{bodyLimit:16384},async(req,reply)=>{
        const out=await submitSemanticQuery(keys.get(req)!,req.body);
        const job=await getSemanticJob(keys.get(req)!,out.id);
        const output=job.output as SemanticOutput | null;
        const status=job.state==="completed" ? output?.status??"failed" : job.state==="active" ? "running" : ["failed","cancelled"].includes(job.state) ? "failed" : "queued";
        // POST acknowledges identity; GET supplies the live result even after an idempotent replay.
        return reply.code(out.reused?200:202).send(semanticTaskView(out.id,out.job,status,await queryReceipt(sql,out.id),output?.status==="failed"?output.reason:undefined));
      });
      privateApi.get("/semantic-queries/:id",async(req,reply)=>{
        const {id}=z.object({id:z.uuid()}).parse(req.params);
        z.object({}).strict().parse(req.query);
        const job=await getSemanticJob(keys.get(req)!,id),data=job.data,receipt=await queryReceipt(sql,id);
        if (Date.parse(data.expiresAt)<=Date.now()) return reply.code(410).send(semanticTaskView(id,data,"expired",receipt,"query_expired"));
        checkQueryIdentity(data);
        const output=job.output as SemanticOutput | null;
        if (job.state==="completed" && output?.status==="ready") {
          if (!validSemanticVector(output.vector,data.embedding.dimensions))
            return reply.send(semanticTaskView(id,data,"failed",receipt,"query_vector_invalid"));
          const result=await read(db=>rankSemanticArticles(db,data.query,output.vector,data.embedding.model));
          if (unavailable(result)) return reply.code(503).send(result);
          return {...semanticTaskView(id,data,"ready",receipt),result};
        }
        const failed=["failed","cancelled","completed"].includes(job.state);
        return semanticTaskView(id,data,failed?"failed":job.state==="active"?"running":"queued",receipt,
          failed ? output?.status==="failed"?output.reason:"query_execution_failed" : undefined);
      });
    }
    privateApi.get("/groups",async(req,reply)=>{
      z.object({}).strict().parse(req.query);
      const out = await read(db=>listGroups(db));
      return reply.code(unavailable(out)?503:200).send(out);
    });
    privateApi.get("/sources",async(req,reply)=>{
      const q = sourceQuery.parse(req.query);
      const out = await read(db=>listSources(db,q,keys.get(req)!));
      return reply.code(unavailable(out)?503:200).send(out);
    });
    privateApi.get("/articles",async(req,reply)=>{
      const q = articleQuery.parse(req.query);
      const out = await read(db=>listArticles(db,q,keys.get(req)!));
      return reply.code(unavailable(out)?503:200).send(unavailable(out) ? out : {...out,items:out.items.map(project)});
    });
    privateApi.get("/articles/resolve",async(req,reply)=>{
      const q = z.object({url:z.url().max(4096),format}).strict().parse(req.query);
      const out = await read(db=>resolveArticle(db,q.url));
      if (unavailable(out)) return reply.code(503).send(out);
      if (!out) return reply.code(404).send({error:"not_found"});
      return q.format==="markdown" ? reply.type("text/markdown; charset=utf-8").send(articleMarkdown(out,version>=2)) : project(out);
    });
    privateApi.get("/articles/:id",async(req,reply)=>{
      const {id} = z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)}).parse(req.params);
      const q = z.object({format}).strict().parse(req.query);
      const out = await read(db=>readArticle(db,id));
      if (unavailable(out)) return reply.code(503).send(out);
      if (!out) return reply.code(404).send({error:"not_found"});
      return q.format==="markdown" ? reply.type("text/markdown; charset=utf-8").send(articleMarkdown(out,version>=2)) : project(out);
    });
    privateApi.get("/openapi.json",async()=>version===3 ? researchOpenApiV3 : version===2 ? researchOpenApiV2 : researchOpenApi);
    privateApi.all("/*",async(_req,reply)=>reply.code(404).send({error:"not_found"}));
  },{prefix:`/api/private/v${version}`});
}
