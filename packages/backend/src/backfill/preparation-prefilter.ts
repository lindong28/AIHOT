// Historical preparation, not article ingestion. Only native prefilter receipts may be created.
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "../db.ts";
import { config } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { PROMPT_VERSIONS, runPrefilter, type AnalyzeInputArticle, type AnalysisRun } from "../editorial/analyze.ts";
import { MAX_BODY_CHARS, missingEvidence } from "../editorial/writing.ts";
import { BudgetExceededError, ReceiptBusyError, ReceiptUnknownError, completeReceipt } from "../providers/receipts.ts";
import { backfillContext, BackfillPaused } from "./context.ts";
import { bindingsSchema, preflightPreparationPrefilter } from "./gateway.ts";

const record = z.record(z.string(), z.unknown());
const articleSchema = z.object({
  id: z.string(), revision: z.number().int(), title: z.string(), url: z.url(), author: z.string().nullable(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(), discoveredAt: z.iso.datetime({ offset: true }).nullable().optional(),
  bodyText: z.string().nullable(), excerpt: z.string().nullable(), bodyStatus: z.string().optional(),
  xPost: record.nullable(), media: z.array(record),
  source: z.object({ name: z.string(), kind: z.string(), tier: z.string(), firstParty: z.boolean(),
    tags: z.array(z.string()).optional(), ownerEntityId: z.string().nullable().optional(), fetchesBody: z.boolean().optional() }),
  translationZh: z.string().nullable().optional(),
});
const inputSchema = z.object({ key: z.string().min(1), article: articleSchema, provenance: z.unknown() });
type Row = z.infer<typeof inputSchema>;
export interface PreparationResult {
  key: string; inputHash: string; manifestHash: string; provenance: unknown;
  state: "filtered" | "needs_original" | "error";
  label: "PASS" | "BLOCK" | "UNKNOWN" | null; reason: string;
  model: string | null; receiptId: number | null; receiptCompleted: boolean | null; reused: boolean | null;
  nativeLabel?: string; errorKind?: string;
}
export interface PreparationOptions {
  input: string; output: string; models: unknown; concurrency: number; maxItems: number; seconds: number; signal?: AbortSignal;
}
export interface PreparationSummary {
  status: "complete" | "bounded" | "waiting_budget" | "needs_attention" | "locked" | "runtime_error";
  total: number; processed: number; filtered: number; needsOriginal: number; unresolvedErrors: number;
  skippedExisting: number; claimed: number; updatedAt: string; retryAfterSeconds?: number;
}
interface DirectoryLock { check: () => Promise<void>; release: () => Promise<void> }
export interface PreparationRuntime {
  lock: (directory: string) => Promise<DirectoryLock | null>;
  preflight: typeof preflightPreparationPrefilter;
  prefilter: (a: AnalyzeInputArticle, opts: {}) => Promise<AnalysisRun["prefilter"]>;
  settle: (receiptId: number) => Promise<void>;
  save: (path: string, value: unknown) => Promise<void>;
  promptVersion: string;
  environment: unknown;
}

/** Rename is not the durability boundary: sync the file and directory before completing a receipt. */
export async function durableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(join(path, ".."), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function jsonIfPresent(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function* lines(file: string): AsyncGenerator<string> {
  // JSONL uses ASCII LF; readline also splits Unicode separators inside valid JSON strings.
  let pending = "";
  for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
    pending += chunk;
    let at: number;
    while ((at = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, at); pending = pending.slice(at + 1); if (line.trim()) yield line; }
  }
  if (pending.trim()) yield pending;
}
async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256"); for await (const part of createReadStream(file)) hash.update(part); return hash.digest("hex");
}
async function validateInput(file: string): Promise<number> {
  const keys = new Set<string>();
  for await (const line of lines(file)) {
    const r = inputSchema.parse(JSON.parse(line));
    if (keys.has(r.key)) throw new Error("Duplicate preparation key; use distinct version keys");
    keys.add(r.key);
    if (keys.size > 170_160) throw new Error("Preparation input exceeds 170160 versions");
  }
  if (!keys.size) throw new Error("Preparation input is empty");
  return keys.size;
}
export function preparationArticle(row: Row): AnalyzeInputArticle {
  const a = row.article;
  return { ...a, id: `preparation:${sha256(row.key)}`, revision: 1,
    publishedAt: a.publishedAt ? new Date(a.publishedAt) : null,
    discoveredAt: a.discoveredAt ? new Date(a.discoveredAt) : null,
    // Existing text is evidence for triage, never a claim that the full article was fetched.
    bodyText: null, excerpt: a.bodyText?.trim() ? a.bodyText : a.excerpt, bodyStatus: "unconfirmed" };
}
const defaults: PreparationRuntime = {
  promptVersion: PROMPT_VERSIONS.prefilter,
  environment: { database: sha256(config.databaseUrl), gateway: process.env.LLM_GATEWAY_URL ?? null,
    project: process.env.LLM_GATEWAY_PROJECT ?? null, mode: process.env.LLM_GATEWAY_MODE ?? "stream" },
  preflight: preflightPreparationPrefilter, prefilter: runPrefilter, save: durableJson,
  async lock(directory) {
    const connection = await sql.reserve();
    const key = `preparation-prefilter:${directory}`;
    let acquired = false;
    try {
      const [r] = await connection`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked, pg_backend_pid() AS pid`;
      if (!r?.locked) { connection.release(); return null; }
      acquired = true;
      const check = async () => { const [p] = await connection`SELECT pg_backend_pid() AS pid`; if (p?.pid !== r.pid) throw new Error("Preparation lock connection changed"); };
      return { check, async release() {
        try { await connection`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`; }
        finally { connection.release(); }
      } };
    } catch (e) { if (!acquired) connection.release(); throw e; }
  },
  async settle(receiptId) {
    await sql.begin(async (tx) => {
      const [r] = await tx`SELECT status, service, purpose FROM receipts WHERE id=${receiptId} FOR UPDATE`;
      if (!r || r.service !== "backfill" || r.purpose !== "prefilter_article") throw new Error("Preparation receipt identity mismatch");
      if (r.status === "completed") return;
      if (r.status === "unknown") throw new ReceiptUnknownError(receiptId, "Preparation receipt requires reconciliation");
      if (r.status !== "received") throw new Error("Preparation receipt is not received");
      await completeReceipt(tx, receiptId);
    });
  },
};

/** Each drain ends after bounded claiming and then settles already dispatched calls. */
export async function runPreparationPrefilter(options: PreparationOptions, overrides: Partial<PreparationRuntime> = {}): Promise<PreparationSummary> {
  if (![options.concurrency, options.maxItems, options.seconds].every(n => Number.isSafeInteger(n) && n > 0) || options.concurrency > 32 || options.seconds > 1500) throw new Error("Supply concurrency 1–32, positive maxItems, seconds 1–1500");
  const runtime = { ...defaults, ...overrides }, models = bindingsSchema.parse(options.models);
  await mkdir(options.output, { recursive: true });
  const directory = await realpath(options.output), lock = await runtime.lock(directory);
  const summary: PreparationSummary = { status: "locked", total: 0, processed: 0, filtered: 0, needsOriginal: 0, unresolvedErrors: 0, skippedExisting: 0, claimed: 0, updatedAt: new Date().toISOString() };
  if (!lock) return summary; // The owner alone may write its summary.
  try {
    const inputSha256 = await fileHash(options.input);
    const total = await validateInput(options.input);
    const manifest = { format: 1, inputSha256, total, promptVersion: runtime.promptVersion, models: options.models, environment: runtime.environment };
    const manifestHash = sha256(stableJson(manifest)), manifestPath = join(directory, "manifest.json"), snapshot = join(directory, "input.jsonl");
    const prior = await jsonIfPresent(manifestPath);
    if (prior && stableJson(prior) !== stableJson(manifest)) throw new Error("Frozen preparation input, prompt, model bindings or environment changed; refusing reuse");
    if (!prior) {
      const temporary = join(directory, `input.${randomUUID()}.tmp`);
      await copyFile(options.input, temporary);
      if (await fileHash(temporary) !== inputSha256) { await unlink(temporary); throw new Error("Preparation input changed while freezing"); }
      const f = await open(temporary, "r+"); try { await f.sync(); } finally { await f.close(); }
      await rename(temporary, snapshot);
      await runtime.save(manifestPath, manifest);
    }
    if (await fileHash(snapshot) !== inputSha256) throw new Error("Frozen preparation snapshot changed");
    await mkdir(join(directory, "results"), { recursive: true });
    summary.total = total;
    // Completed-prefix scans must not exhaust every drain before it reaches new work.
    // seconds bounds claiming after the first pending item, not total process runtime.
    let deadline: number | null = null;
    let halt: "bounded" | "waiting_budget" | null = null, fatal: unknown;
    let ready: Promise<Awaited<ReturnType<typeof preflightPreparationPrefilter>>> | undefined;
    const stopping = () => halt || fatal || options.signal?.aborted || (deadline !== null && Date.now() >= deadline);
    async function settleResult(path: string, result: PreparationResult) {
      if (result.receiptId === null || result.receiptCompleted || result.state === "error") return;
      await lock!.check();
      try { await runtime.settle(result.receiptId); }
      catch (e) {
        if (!(e instanceof ReceiptUnknownError)) throw e;
        result.state = "error"; result.errorKind = "receipt_unknown"; result.reason = "receipt_requires_reconciliation";
        await runtime.save(path, result); return;
      }
      result.receiptCompleted = true; await runtime.save(path, result);
    }
    async function process(row: Row, path: string, inputHash: string) {
      const a = preparationArticle(row);
      const result: PreparationResult = { key: row.key, inputHash, manifestHash, provenance: row.provenance,
        state: "needs_original", label: null, reason: "missing_evidence", model: null, receiptId: null, receiptCompleted: null, reused: null };
      if (!missingEvidence(a)) {
        let response: AnalysisRun["prefilter"];
        // Readiness is a batch prerequisite, not 170160 independent model failures.
        ready ??= runtime.preflight(models);
        const checked = await ready;
        if (stopping()) return;
        try {
          response = await backfillContext.run({ runId: `preparation:${manifestHash}`, models: checked.models,
            beforeCall: async (purpose) => {
              if (purpose !== "prefilter_article") throw new Error("Preparation may only dispatch prefilter_article");
              if (stopping()) throw new BackfillPaused("Preparation stopped claiming");
              await lock!.check();
              try { await checked.check(); } catch { throw new BackfillPaused("Preparation route needs a fresh preflight"); }
              if (stopping()) throw new BackfillPaused("Preparation stopped claiming");
            } }, () => runtime.prefilter(a, {}));
        } catch (e) {
          if (e instanceof BudgetExceededError) { halt = "waiting_budget"; summary.retryAfterSeconds = e.retryAfterSeconds; return; }
          if (e instanceof BackfillPaused || e instanceof ReceiptBusyError) { halt ??= "bounded"; return; }
          result.state = "error"; result.errorKind = e instanceof ReceiptUnknownError ? "receipt_unknown" : "model_error";
          result.reason = result.errorKind; result.receiptId = e instanceof ReceiptUnknownError ? e.receiptId : null;
          await lock!.check(); await runtime.save(path, result); return;
        }
        result.label = response.label; result.reason = response.reason; result.model = response.model;
        result.receiptId = response.receiptId; result.receiptCompleted = false; result.reused = response.reused;
        const renderedBody = a.xPost ? String(a.xPost.text ?? a.title) : a.excerpt ?? "";
        if (response.label === "BLOCK" && renderedBody.length > MAX_BODY_CHARS) {
          result.nativeLabel = "BLOCK"; result.label = "UNKNOWN"; result.reason = "native_body_limit_requires_original";
        }
        result.state = result.label === "BLOCK" ? "filtered" : "needs_original";
      }
      await lock!.check(); await runtime.save(path, result); // Durable business result first.
      await settleResult(path, result);
    }
    const inflight = new Set<Promise<void>>();
    try {
      for await (const line of lines(snapshot)) {
        if (stopping()) { halt ??= "bounded"; break; }
        const row = inputSchema.parse(JSON.parse(line)), inputHash = sha256(line), path = join(directory, "results", sha256(row.key) + ".json");
        const existing = await jsonIfPresent(path) as PreparationResult | null;
        if (existing) {
          if (existing.key !== row.key || existing.inputHash !== inputHash || existing.manifestHash !== manifestHash || !["filtered", "needs_original", "error"].includes(existing.state)) throw new Error("Stored preparation result does not match frozen input");
          await settleResult(path, existing); summary.skippedExisting++; continue;
        }
        // The item cap stops admission, not workers already awaiting preflight.
        if (summary.claimed >= options.maxItems) break;
        deadline ??= Date.now() + options.seconds * 1000;
        summary.claimed++;
        const task = process(row, path, inputHash).catch(e => { fatal ??= e; }).finally(() => inflight.delete(task));
        inflight.add(task);
        if (inflight.size >= options.concurrency) await Promise.race(inflight);
      }
    } catch (e) { fatal ??= e; }
    await Promise.allSettled(inflight); // Never drop the lock while a sibling settles a receipt.
    for (const file of await readdir(join(directory, "results"))) {
      if (!file.endsWith(".json")) continue;
      const r = await jsonIfPresent(join(directory, "results", file)) as PreparationResult;
      if (r.manifestHash !== manifestHash) throw new Error("Foreign result in preparation directory");
      if (r.state === "filtered") summary.filtered++;
      else if (r.state === "needs_original") summary.needsOriginal++;
      else summary.unresolvedErrors++;
    }
    summary.processed = summary.filtered + summary.needsOriginal;
    summary.status = fatal ? "runtime_error" : summary.retryAfterSeconds !== undefined ? "waiting_budget" : summary.unresolvedErrors ? "needs_attention"
      : summary.processed === total ? "complete" : "bounded";
    summary.updatedAt = new Date().toISOString(); await runtime.save(join(directory, "summary.json"), summary);
    if (fatal) throw fatal;
    return summary;
  } finally {
    // A rejected manifest does not overwrite the prior run's summary.
    await lock.release();
  }
}
