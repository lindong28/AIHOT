import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import { sql } from "../db.ts";
import { config } from "../config.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { stripTags } from "../lib/text.ts";
import { readable } from "../content/extract.ts";
import { MODELS, parseChatResponse } from "../providers/llm.ts";
import { completeReceipt, logicalKeyFor, ReceiptUnknownError, ReceiptBusyError, BudgetExceededError, GatewayNotDispatchedError } from "../providers/receipts.ts";
import { PROMPT_VERSIONS, prefilterRequest, runPrefilter } from "../editorial/analyze.ts";
import { missingEvidence, MAX_BODY_CHARS } from "../editorial/writing.ts";
import { materialHash, manifestEntry, type ManifestEntry } from "./manifest.ts";
import { preparationArticle, durableJson, type PreparationResult } from "./preparation-prefilter.ts";
import { BACKFILL_PRESETS, backfillContext, BackfillPaused, bindingIdentityRoutes, bindingsIdentity, type BackfillBindings } from "./context.ts";
import { loadPreparation, storePreparation, type HistoryVersion, type PreparationState } from "./history-input.ts";

export function preparationIdentity(_models: BackfillBindings) {
  return { prefilterPrompt: PROMPT_VERSIONS.prefilter, materialPolicy: "archived-original-or-fetch-v1" };
}
async function json(file: string): Promise<any | null> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export function retryablePreparationError(e: unknown): boolean {
  return e instanceof BackfillPaused || e instanceof ReceiptBusyError || e instanceof BudgetExceededError || e instanceof GatewayNotDispatchedError;
}
export function originalPageContext(html: string) {
  const { document } = parseHTML(html), text = stripTags(html);
  return { pageContext: text.slice(0, 30000), pageContextTruncated: text.length > 30000,
    metadata: [...document.querySelectorAll('meta')].map(m => ({ name: m.getAttribute('name') ?? m.getAttribute('property'), content: m.getAttribute('content') })).filter(m => m.name && m.content),
    structuredData: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent) };
}

/** A runtime-selected old cache is a source of decisions, never another work queue. */
export async function cachedPrefilter(v: HistoryVersion, models: BackfillBindings): Promise<PreparationResult | null> {
  const directory = process.env.BACKFILL_PREFILTER_CACHE;
  if (!directory || !v.prefilter) return null;
  const m = await json(join(directory, "manifest.json"));
  if (!m || m.promptVersion !== PROMPT_VERSIONS.prefilter || !m.models || stableJson(bindingsIdentity(m.models)) !== stableJson(bindingsIdentity(models)) ||
      m.environment?.database !== sha256(config.databaseUrl) || m.environment?.gateway !== (process.env.LLM_GATEWAY_URL ?? null) ||
      m.environment?.project !== (process.env.LLM_GATEWAY_PROJECT ?? null) || m.environment?.mode !== (process.env.LLM_GATEWAY_MODE ?? "stream")) throw new Error("Old preparation cache model/prompt/environment identity mismatch");
  const r = await json(join(directory, "results", sha256(v.key) + ".json")) as PreparationResult | null;
  if (!r) return null;
  if (r.key !== v.key || r.inputHash !== v.prefilter.inputHash || r.manifestHash !== sha256(stableJson(m))) throw new Error("Old preparation result input identity mismatch");
  const article = preparationArticle(v.prefilter.row), request = prefilterRequest(article);
  if (r.receiptId === null && r.state === 'needs_original' && r.label === null && missingEvidence(article)) return r;
  if (!process.env.LLM_GATEWAY_URL) throw new Error("Old preparation receipt requires its Gateway identity");
  // Subjects identify archive versions; paidRequest deliberately shares identical requests across subjects.
  const logicalKey = logicalKeyFor({ service: 'backfill', purpose: request.purpose, model: models.prefilter.model,
    identity: { model: models.prefilter.model, promptVersion: request.promptVersion, system: sha256(request.system), user: sha256(request.user),
      temperature: request.temperature, maxTokens: request.maxTokens, extra: MODELS[BACKFILL_PRESETS.prefilter]!.extra ?? null,
      gateway: { baseUrl: new URL(process.env.LLM_GATEWAY_URL).toString().replace(/\/+$/, '').replace(/\/v1$/, ''),
        project: process.env.LLM_GATEWAY_PROJECT?.trim(), mode: process.env.LLM_GATEWAY_MODE ?? 'stream', model: models.prefilter.model,
        timeoutMs: 120_000, routes: bindingIdentityRoutes(models.prefilter) } } });
  const [receipt] = r.receiptId === null
    ? await sql`SELECT * FROM receipts WHERE logical_key=${logicalKey}`
    : await sql`SELECT * FROM receipts WHERE id=${r.receiptId}`;
  if (!receipt || receipt.logical_key !== logicalKey || receipt.service !== 'backfill' || receipt.purpose !== request.purpose || receipt.model !== models.prefilter.model) {
    throw new Error("Old preparation result receipt request identity mismatch; no-dispatch evidence cannot substitute for identity");
  }
  if (receipt.status === 'unknown') throw new ReceiptUnknownError(receipt.id, "Old preparation receipt requires reconciliation");
  if (receipt.status === 'pending') throw new ReceiptBusyError("Old preparation receipt is still in flight");
  if (r.state === "error" && receipt.status === 'failed') {
    // Explicit operator-authorized replay is distinct from proof of no dispatch. It grants
    // one attempt only; a later failed attempt cannot reuse this authorization.
    const [replay] = await sql`SELECT 1 FROM receipt_recoveries WHERE receipt_id=${receipt.id}
      AND original_attempt=${receipt.attempts} AND state='queued'`;
    if (replay) return null;
    // Only explicit whole-request zero-attempt ledger proof permits retrying an old error.
    const auditPath = process.env.BACKFILL_NOT_DISPATCHED_AUDIT;
    const audit = auditPath ? await json(auditPath) : null;
    const attempts = await sql`SELECT r.id,r.status,a.attempt,a.request_id FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id
      WHERE r.id=${receipt.id}`;
    if (!attempts.length || !attempts.every(a => a.status === 'failed' && audit?.rows?.some((p: any) =>
      p.id === a.id && p.attempt === a.attempt && p.attempt_request_id === a.request_id && p.safeNotDispatched === true &&
      p.gatewayAttempts?.length === 0 && p.logical?.length === 1 && p.logical[0].logical_request_id === a.request_id &&
      p.logical[0].canonical_project_id === process.env.LLM_GATEWAY_PROJECT && p.logical[0].request_outcome === 'local_rejected' && ['route_cooldown','no_route'].includes(p.logical[0].request_reject_reason)))) {
      throw new Error("Old preparation error lacks whole-request no-dispatch evidence");
    }
    return null;
  }
  if (!["received", "completed"].includes(receipt.status)) throw new Error("Old preparation result is not backed by its settled/received receipt");
  if (r.state !== 'error' && (!["filtered", "needs_original"].includes(r.state) || (r.state === "filtered") !== (r.label === "BLOCK"))) throw new Error("Invalid old preparation decision");
  // Reconciliation may have supplied a received response after the old error file was written.
  // Parse that response directly: this read-only path never dispatches or changes receipt status.
  const response = parseChatResponse(request, receipt.response), rendered = article.xPost ? String(article.xPost.text ?? article.title) : article.excerpt ?? '';
  const limited = response.label === 'BLOCK' && rendered.length > MAX_BODY_CHARS;
  const label = response.label === 'BLOCK' && (missingEvidence(article) || limited) ? 'UNKNOWN' : response.label;
  return { ...r, state: label === 'BLOCK' ? 'filtered' : 'needs_original', label,
    reason: limited ? 'native_body_limit_requires_original' : response.reason, model: BACKFILL_PRESETS.prefilter,
    receiptId: receipt.id, receiptCompleted: receipt.status === 'completed', reused: true,
    ...(limited ? { nativeLabel: 'BLOCK' } : {}), errorKind: undefined };
}

/** Fetch/extract retains provenance; a successful extraction does not approve completeness. */
export async function fetchHistoryOriginal(url: string) {
  if (config.allowPrivateNetworkFetch) throw new Error("Historical originals require private-network fetch disabled");
  const directory = process.env.BACKFILL_ORIGINAL_CACHE;
  if (!directory) throw new Error("BACKFILL_ORIGINAL_CACHE is required for durable original responses");
  const stem = sha256(url), path = join(directory, "responses", stem + ".json");
  let cached = await json(path);
  if (cached) {
    if (cached.sourceUrl !== url || cached.quality !== "unconfirmed") throw new Error("Original response cache identity mismatch");
    if (cached.rawPath) {
      const rawPath = resolve(directory, cached.rawPath);
      if (!rawPath.startsWith(resolve(directory) + sep)) throw new Error("Original response escaped cache directory");
      const raw = gunzipSync(await readFile(rawPath));
      if (sha256(raw) !== cached.rawSha256) throw new Error("Original response hash mismatch");
      // Old extractor rejected short originals; re-extraction is local and still unapproved.
      if (cached.status === 200 && /html/i.test(cached.contentType ?? "")) cached = { ...cached, extracted: readable(raw.toString(), cached.finalUrl, 1), ...originalPageContext(raw.toString()) };
    }
    return cached;
  }
  await mkdir(join(directory, "responses"), { recursive: true });
  const response = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024, maxRedirects: 5 });
  const rawPath = `responses/${stem}.response.gz`, raw = response.body;
  await writeFile(join(directory, rawPath), gzipSync(raw), { mode: 0o600 });
  const result = { sourceUrl: url, finalUrl: response.url, fetchedAt: new Date().toISOString(), status: response.status,
    contentType: response.headers.get("content-type"), quality: "unconfirmed", rawPath, rawSha256: sha256(raw),
    extracted: response.status === 200 && /html/i.test(response.headers.get("content-type") ?? "") ? readable(response.text(), response.url, 1) : null,
    ...originalPageContext(response.text()) };
  await durableJson(path, result); return result;
}

export function hasArchivedBody(v: HistoryVersion): boolean {
  const text = v.material?.bodyText?.trim();
  return !!text && text !== v.material?.title.trim() && text !== v.material?.url;
}

/** Reuse archived text; fetch only when the archive contains no body beyond its title/URL. */
export function historyMaterial(v: HistoryVersion, fetched?: any): { material: ManifestEntry["material"]; context: unknown } {
  if (!v.material) throw new Error("Missing native historical material");
  if (v.material.xPost) {
    const omitLegacyHtml = v.material.bodyHtml?.includes('\u0000') ?? false;
    const { bodyHtml, ...withoutHtml } = v.material;
    return { material: omitLegacyHtml ? withoutHtml : v.material,
      context: { source: v.prefilter?.row.article.source, archive: v.context, provenance: v.provenance,
        ...(omitLegacyHtml ? { representation: { omitted: 'legacy_bodyHtml', reason: 'contains_NUL', rawPreservedInPreparation: true } } : {}) } };
  }
  if (!fetched && hasArchivedBody(v)) return { material: v.material, context: { source: "archive", provenance: v.provenance } };
  if (fetched?.status !== 200) throw new Error(`Original HTTP ${fetched?.status ?? 'unknown'}`);
  if (!fetched.extracted?.text?.trim()) throw new Error("Original extraction unconfirmed");
  return { material: { ...v.material, bodyText: fetched.extracted.text, bodyHtml: fetched.extracted.html,
    media: fetched.extracted.images?.map((i: any) => ({ kind: 'image', url: i.url })) ?? [] },
    context: { source: v.prefilter?.row.article.source, provenance: v.provenance, sourceUrl: fetched.sourceUrl, finalUrl: fetched.finalUrl,
      fetchedAt: fetched.fetchedAt, status: fetched.status, contentType: fetched.contentType, rawSha256: fetched.rawSha256, extraction: fetched.extracted.via,
      pageContext: fetched.pageContext, pageContextTruncated: fetched.pageContextTruncated, metadata: fetched.metadata, structuredData: fetched.structuredData } };
}

/** Save the decision and settle its paid receipt in the same transaction. */
async function savePreparation(runId: string, key: string, state: PreparationState, receiptId?: number | null) {
  await sql.begin(async tx => {
    if (receiptId !== null && receiptId !== undefined) {
      const [r] = await tx`SELECT status,service,purpose FROM receipts WHERE id=${receiptId} FOR UPDATE`;
      if (!r || r.service !== 'backfill' || !['prefilter_article','verify_history_material'].includes(r.purpose) || !['received','completed'].includes(r.status)) throw new ReceiptUnknownError(receiptId, "Preparation receipt is not safely received");
      await completeReceipt(tx, receiptId);
    }
    await tx`UPDATE backfill_items SET preparation=${tx.json(storePreparation(state))},updated_at=now() WHERE run_id=${runId} AND identity_key=${key}`;
  });
}

export async function prepareHistoryItem(runId: string, key: string, models: BackfillBindings): Promise<"ready" | "terminal"> {
  const [item] = await sql`SELECT preparation FROM backfill_items WHERE run_id=${runId} AND identity_key=${key}`;
  if (!item?.preparation) return "ready";
  const p = loadPreparation(item.preparation);
  if (p.selected) return "ready";
  const [existing] = await sql`SELECT id FROM articles WHERE identity_key=${key}`;
  if (existing) {
    await sql`UPDATE backfill_items SET state='existing',article_id=${existing.id},reason='native_identity_exists',stage='finished',updated_at=now() WHERE run_id=${runId} AND identity_key=${key}`;
    return "terminal";
  }
  async function select(v: HistoryVersion, m: ManifestEntry["material"], evidence: string) {
    const normalized = manifestEntry.parse({ material: m, quality: { state: "complete", evidence, contentHash: materialHash(m) } });
    const selected = { key: v.key, hash: normalized.quality.contentHash, evidence };
    await sql`UPDATE backfill_items SET material=${sql.json(normalized.material as never)},content_hash=${selected.hash},evidence=${evidence},preparation=${sql.json(storePreparation({ ...p, selected }))},stage='material_ready',updated_at=now() WHERE run_id=${runId} AND identity_key=${key}`;
    p.selected = selected;
  }
  // Reuse previously approved material without another preparation call.
  for (const v of p.versions) if (v.material && v.approved?.state === "complete") {
    if (materialHash(v.material) !== v.approved.contentHash) throw new Error("Approved material changed");
    await select(v, v.material, v.approved.evidence); return "ready";
  }
  let blocked = 0;
  for (const v of p.versions) {
    const result = p.results[v.key] ??= {};
    if (result.error) continue;
    let unsettled: 'prefilter' | null = null;
    try {
      if (!result.prefilter) {
        unsettled = 'prefilter';
        await backfillContext.getStore()!.beforeCall("prepare_prefilter", models.prefilter.model);
        const cached = await cachedPrefilter(v, models);
        if (cached) result.prefilter = cached;
        else if (v.prefilter && !missingEvidence(preparationArticle(v.prefilter.row))) {
          const a = preparationArticle(v.prefilter.row), response = await runPrefilter(a, {});
          const rendered = a.xPost ? String(a.xPost.text ?? a.title) : a.excerpt ?? "";
          result.prefilter = { ...response, label: response.label === "BLOCK" && rendered.length > MAX_BODY_CHARS ? "UNKNOWN" : response.label };
        } else result.prefilter = { label: "UNKNOWN", reason: "missing_evidence", receiptId: null };
        await savePreparation(runId, key, p, result.prefilter.receiptId);
        unsettled = null;
      }
      if (result.prefilter.label === "BLOCK") { blocked++; continue; }
      if (!v.material) throw new Error("invalid_original_url: prefilter did not settle a content exclusion");
      if (!v.material.xPost && !hasArchivedBody(v)) {
        if (v.targetUrls.length !== 1) throw new Error("Original URL requires resolution");
        if (!result.fetched) {
          await backfillContext.getStore()!.beforeCall("fetch_original", "");
          result.fetched = await fetchHistoryOriginal(v.targetUrls[0]!);
          await savePreparation(runId, key, p);
        }
      }
      const fetched = hasArchivedBody(v) ? undefined : result.fetched;
      const { material } = historyMaterial(v, fetched);
      const evidence = v.material.xPost ? "Archived X original reused; per-item completeness not assessed"
        : fetched ? `Original fetched from ${fetched.finalUrl}; response ${fetched.rawSha256}`
        : "Archived original body reused; per-item completeness not assessed";
      await select(v, material, evidence); return "ready";
    } catch (e) {
      // A failed settlement must not leak a successful-looking decision into the error save.
      if (unsettled) delete result[unsettled];
      if (retryablePreparationError(e)) throw e;
      result.error = e instanceof ReceiptUnknownError ? `receipt_unknown:${e.receiptId}` : String(e).slice(0, 500);
      await savePreparation(runId, key, p);
      if (e instanceof ReceiptUnknownError) throw e;
    }
  }
  if (blocked === p.versions.length) {
    await sql`UPDATE backfill_items SET state='filtered',stage='finished',reason='all_versions_prefilter_block',updated_at=now() WHERE run_id=${runId} AND identity_key=${key}`;
    return "terminal";
  }
  throw new Error(Object.entries(p.results).filter(([,v]) => v.error).map(([k,v]) => `${k}: ${v.error}`).join('; ').slice(0, 500) || "No complete original version");
}
