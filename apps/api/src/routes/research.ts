import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { credential } from "@aihot/backend/config";
import { withSearchCapacity, SearchBusyError } from "@aihot/backend/publication/pool";
import { listArticles, listSources, readArticle, resolveArticle, articleMarkdown, ResearchInputError } from "@aihot/backend/research/read";
import { researchOpenApi } from "@aihot/contracts/research";

const paging = {limit:z.coerce.number().int().min(1).max(100).default(40),cursor:z.string().max(2048).optional()};
const articleQuery = z.object({...paging,source:z.string().min(1).max(200).optional(),q:z.string().max(256).optional(),
  from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional(),
  selected:z.enum(["true","false"]).transform(v=>v==="true").optional()}).strict().refine(q=>!q.from||!q.to||Date.parse(q.from)<Date.parse(q.to));
const sourceQuery = z.object({...paging,q:z.string().max(256).optional(),kind:z.string().max(80).optional()}).strict();
const format = z.enum(["json","markdown"]).default("json");

export function registerResearch(app: FastifyInstance) {
  app.register(async privateApi => {
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
    privateApi.get("/sources",async(req,reply)=>{
      const q = sourceQuery.parse(req.query);
      const out = await read(db=>listSources(db,q,keys.get(req)!));
      return reply.code(unavailable(out)?503:200).send(out);
    });
    privateApi.get("/articles",async(req,reply)=>{
      const q = articleQuery.parse(req.query);
      const out = await read(db=>listArticles(db,q,keys.get(req)!));
      return reply.code(unavailable(out)?503:200).send(out);
    });
    privateApi.get("/articles/resolve",async(req,reply)=>{
      const q = z.object({url:z.url().max(4096),format}).strict().parse(req.query);
      const out = await read(db=>resolveArticle(db,q.url));
      if (unavailable(out)) return reply.code(503).send(out);
      if (!out) return reply.code(404).send({error:"not_found"});
      return q.format==="markdown" ? reply.type("text/markdown; charset=utf-8").send(articleMarkdown(out)) : out;
    });
    privateApi.get("/articles/:id",async(req,reply)=>{
      const {id} = z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)}).parse(req.params);
      const q = z.object({format}).strict().parse(req.query);
      const out = await read(db=>readArticle(db,id));
      if (unavailable(out)) return reply.code(503).send(out);
      if (!out) return reply.code(404).send({error:"not_found"});
      return q.format==="markdown" ? reply.type("text/markdown; charset=utf-8").send(articleMarkdown(out)) : out;
    });
    privateApi.get("/openapi.json",async()=>researchOpenApi);
    privateApi.all("/*",async(_req,reply)=>reply.code(404).send({error:"not_found"}));
  },{prefix:"/api/private/v1"});
}
