// Local preparation cache only. Extraction never approves completeness or writes articles.
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { randomUUID, createHash } from "node:crypto";
import { guardedFetch } from "../packages/backend/src/lib/http-fetch.ts";
import { readable } from "../packages/backend/src/content/extract.ts";
import { sha256, stableJson } from "../packages/backend/src/lib/ids.ts";
import { config } from "../packages/backend/src/config.ts";

interface Options { preparation: string; inventory: string; queue: string; output: string; maxItems: number; seconds: number; concurrency?: number; signal?: AbortSignal }
interface Runtime { fetch: typeof guardedFetch; extract: typeof readable; now: () => number }
interface Inventory { origin: { id: string; legacyContentHash: string }; sourceKind: string; targetUrls: string[]; classification: string }
interface Item { key: string; provenance: unknown; state: string; reason: string; url?: string; cache?: string }
async function* lines(file: string) {
  let buffer = "";
  for await (const part of createReadStream(file, { encoding: "utf8" })) {
    buffer += part; let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.trim()) yield line; }
  }
  if (buffer.trim()) yield buffer;
}
async function hashFile(file: string) { const h = createHash("sha256"); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest("hex"); }
async function json(file: string) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function save(file: string, value: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value) + "\n", { mode: 0o600 }); await rename(temp, file);
}
function publicPage(url: string) {
  try { const u = new URL(url); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !/(^|\.)(x\.com|twitter\.com|nitter\.[^/]+)$/i.test(u.hostname); }
  catch { return false; }
}

export async function fetchOriginals(options: Options, overrides: Partial<Runtime> = {}) {
  const concurrency = options.concurrency ?? 8;
  if (![concurrency, options.maxItems, options.seconds].every(n => Number.isSafeInteger(n) && n > 0) || concurrency > 8 || options.seconds > 1500) throw new Error("Require concurrency 1–8, positive maxItems, seconds 1–1500");
  if (!overrides.fetch && config.allowPrivateNetworkFetch) throw new Error("Private-network fetch must be disabled");
  const runtime = { fetch: guardedFetch, extract: readable, now: Date.now, ...overrides };
  const output = resolve(options.output); await mkdir(output, { recursive: true });
  const lockPath = join(output, "fetch.lock"), lock = await open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const manifest = await json(join(options.preparation, "manifest.json"));
    if (!manifest || await hashFile(join(options.preparation, "input.jsonl")) !== manifest.inputSha256) throw new Error("Preparation snapshot mismatch");
    const manifestHash = sha256(stableJson(manifest));
    const frozen = { format: 1, preparationManifestHash: manifestHash, inventoryHash: await hashFile(options.inventory), queueHash: await hashFile(options.queue) };
    const prior = await json(join(output, "manifest.json"));
    if (prior && stableJson(prior) !== stableJson(frozen)) throw new Error("Fetch input changed; use another output directory");
    if (!prior) await save(join(output, "manifest.json"), frozen);
    const inventory = new Map<string, Inventory>();
    for await (const line of lines(options.inventory)) { const r: Inventory = JSON.parse(line); const key = `${r.origin.id}:${r.origin.legacyContentHash}`; if (inventory.has(key)) throw new Error("Duplicate inventory version"); inventory.set(key, { origin: r.origin, sourceKind: r.sourceKind, targetUrls: r.targetUrls, classification: r.classification }); }
    const queued = new Map<string, Set<string>>();
    for await (const line of lines(options.queue)) { const r = JSON.parse(line); const keys = queued.get(r.url) ?? new Set<string>(); for (const p of r.requesters) keys.add(`${p.id}:${p.legacyContentHash}`); queued.set(r.url, keys); }
    const items: Item[] = [], jobs = new Map<string, Item[]>(), seen = new Set<string>();
    for await (const line of lines(join(options.preparation, "input.jsonl"))) {
      const row = JSON.parse(line); if (seen.has(row.key)) throw new Error("Duplicate preparation key"); seen.add(row.key);
      const item: Item = { key: row.key, provenance: row.provenance, state: "todo", reason: "preparation_pending" }; items.push(item);
      const r = await json(join(options.preparation, "results", sha256(row.key) + ".json"));
      if (!r) continue;
      if (r.key !== row.key || r.inputHash !== sha256(line) || r.manifestHash !== manifestHash) throw new Error("Preparation result mismatch");
      // A model label is not a settled preparation decision: settlement may have failed afterwards.
      if (r.state === "error" || (r.receiptId !== null && r.receiptId !== undefined && r.receiptCompleted !== true)) { item.reason = "preparation_unresolved"; continue; }
      if (r.state === "filtered" && r.label === "BLOCK") { item.state = "skipped"; item.reason = "model_block"; continue; }
      if (r.state !== "needs_original" || r.label === "BLOCK") { item.reason = "preparation_unresolved"; continue; }
      if (row.provenance?.sourceKind === "x" || row.article?.xPost) { item.reason = "x_requires_native_material"; continue; }
      const inv = inventory.get(row.key);
      if (!inv) { item.reason = "missing_inventory"; continue; }
      if (inv.sourceKind === "x") { item.reason = "x_requires_native_material"; continue; }
      if (inv.classification !== "fetch_required") { item.reason = inv.classification; continue; }
      if (inv.targetUrls.length !== 1) { item.reason = "target_selection_required"; continue; }
      const url = inv.targetUrls[0]!;
      if (!queued.get(url)?.has(row.key) || !publicPage(url)) { item.reason = "target_not_fetchable_or_not_queued"; continue; }
      item.url = url; item.reason = "not_claimed";
      const group = jobs.get(url) ?? []; group.push(item); jobs.set(url, group);
    }
    if (manifest.total !== items.length) throw new Error("Preparation row count mismatch");
    await mkdir(join(output, "responses"), { recursive: true });
    let claimed = 0, reused = 0, index = 0;
    const urls = [...jobs.keys()];
    let deadline: number | undefined;
    async function worker() {
      while (index < urls.length) {
        const url = urls[index++]!, stem = sha256(url), cache = join(output, "responses", stem + ".json");
        let result = await json(cache);
        if (result) {
          if (result.sourceUrl !== url || result.quality !== "unconfirmed") throw new Error("Cache identity mismatch");
          if (result.rawPath && sha256(gunzipSync(await readFile(join(output, result.rawPath)))) !== result.rawSha256) throw new Error("Cached response hash mismatch");
          reused++;
        } else {
          if (claimed >= options.maxItems || options.signal?.aborted) continue;
          // Cached-prefix verification must not exhaust every resumed claiming window.
          const now = runtime.now();
          deadline ??= now + options.seconds * 1000;
          if (now >= deadline) continue;
          claimed++;
          const fetchedAt = new Date(now).toISOString();
          result = { sourceUrl: url, finalUrl: null, fetchedAt, status: null, quality: "unconfirmed", state: "fetch_error", errorKind: null, extracted: null };
          try {
            const response = await runtime.fetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024, maxRedirects: 5 });
            const rawPath = `responses/${stem}.response.gz`;
            await writeFile(join(output, rawPath), gzipSync(response.body), { mode: 0o600 });
            Object.assign(result, { finalUrl: response.url, status: response.status, contentType: response.headers.get("content-type"), rawPath, rawSha256: sha256(response.body), state: "needs_review" });
            if (response.status === 200 && /html/i.test(response.headers.get("content-type") ?? "")) result.extracted = runtime.extract(response.text(), response.url);
            if (response.status !== 200) result.state = "http_error";
            else if (!result.extracted) result.state = "extraction_unconfirmed";
          } catch (e) { result.state = result.rawPath ? "extraction_error" : "fetch_error"; result.errorKind = e instanceof Error ? e.constructor.name : "UnknownError"; }
          await save(cache, result);
        }
        for (const item of jobs.get(url)!) { item.state = result.state; item.reason = result.state; item.cache = `responses/${stem}.json`; }
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: concurrency }, worker));
    const failed = workers.find(r => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const temp = join(output, `items.${randomUUID()}.tmp`), handle = await open(temp, "wx", 0o600);
    try { for (const item of items) await handle.write(JSON.stringify(item) + "\n"); } finally { await handle.close(); }
    await rename(temp, join(output, "items.jsonl"));
    const states: Record<string, number> = {}; for (const item of items) states[item.reason] = (states[item.reason] ?? 0) + 1;
    const summary = { total: items.length, distinctTargets: jobs.size, claimed, reused, states, quality: "unconfirmed", updatedAt: new Date().toISOString() };
    await save(join(output, "summary.json"), summary); return summary;
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [preparation, inventory, queue, output, maxItems, seconds] = process.argv.slice(2);
  const controller = new AbortController(), stop = () => controller.abort();
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    if (!preparation || !inventory || !queue || !output || !maxItems || !seconds || process.argv.length !== 8) throw new Error("Arguments required");
    const summary = await fetchOriginals({ preparation, inventory, queue, output, maxItems: Number(maxItems), seconds: Number(seconds), signal: controller.signal });
    console.log(JSON.stringify(summary));
    console.log("仅生成本机原始响应与待核验提取；不代表原文完整。错误缓存保留且不自动重试。到领取上限停止，DNS、重定向和响应体共用20秒网络预算（提取、磁盘及输入扫描另计）；items.jsonl保留逐项待办。");
  } catch (e) {
    console.error(`抓取未完成（${e instanceof Error ? e.constructor.name : "UnknownError"}）。用法：node scripts/backfill-fetch-originals.ts <preparation目录> <inventory.jsonl> <fetch-queue.jsonl> <本机.data输出目录> <max-items> <领取秒数1–1500>。已缓存结果保留；fetch.lock冲突时先确认原执行器状态。`); process.exitCode = 1;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
