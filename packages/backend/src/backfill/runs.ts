import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";
import { audit } from "../admin/auth.ts";
import { upsertMaterial } from "../content/materials.ts";
import { processArticle } from "../jobs/content.ts";
import { publishArticle } from "../publication/publish.ts";
import { backfillContext, BackfillPaused } from "./context.ts";
import { bindingsSchema, preflightBackfill } from "./gateway.ts";
import { entryIdentity, validateManifest, type ManifestEntry } from "./manifest.ts";
import { prepareHistoryItem, preparationIdentity, retryablePreparationError } from "./preparation.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { stableJson } from "../lib/ids.ts";
import { loadPreparation, storePreparation } from "./history-input.ts";

export async function importBackfill(input: { label: string; startDay: string; endDay: string; entries: unknown[] }) {
  if (!input.label.trim()) throw new Error("A batch label is required");
  const { entries, hash } = validateManifest(input.entries, input.startDay, input.endDay);
  return sql.begin(async (tx) => {
    const [old] = await tx`SELECT id FROM backfill_runs WHERE manifest_hash = ${hash}`;
    if (old) return { id: old.id as string, reused: true };
    const sources = new Set((await tx`SELECT id FROM sources`).map((s) => s.id));
    for (const e of entries) if (!sources.has(e.material.sourceId)) throw new Error(`Missing native source ${e.material.sourceId}; map or register it before import`);
    const id = randomUUID();
    await tx`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day) VALUES (${id},${input.label},${hash},${input.startDay},${input.endDay})`;
    // The raw manifest is staged first; articles enter the native pipeline only when claimed.
    for (const e of entries) {
      const day = new Date(e.material.publishedAt).toISOString().slice(0, 10);
      const inRange = day >= input.startDay && day <= input.endDay;
      const eligible = inRange && e.quality.state === "complete";
      await tx`INSERT INTO backfill_items(run_id,identity_key,day,material,content_hash,evidence,state,reason)
        VALUES (${id},${entryIdentity(e)},${day},${tx.json(e.material)},${e.quality.contentHash},${e.quality.evidence},${eligible ? "pending" : "excluded"},${!inRange ? "outside_range" : eligible ? null : e.quality.state})`;
    }
    return { id, reused: false };
  });
}

export async function configureBackfill(id: string, input: unknown) {
  const models = bindingsSchema.parse(input);
  return sql.begin(async (tx) => {
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext(${'backfill:' + id})) AS locked`;
    if (!lock!.locked) throw new Error("Wait for the active executor to exit before changing model bindings");
    const [r] = await tx`SELECT * FROM backfill_runs WHERE id=${id} FOR UPDATE`;
    if (!r) throw new Error("Backfill batch not found");
    const [used] = await tx`SELECT 1 FROM backfill_items WHERE run_id=${id} AND attempts>0 LIMIT 1`;
    if (used || !["paused", "waiting_models"].includes(r.state)) throw new Error("Model bindings are immutable after execution starts; use a new batch");
    await tx`UPDATE backfill_runs SET models=${tx.json(models)},preparation_identity=${r.scope === 'history' ? tx.json(preparationIdentity(models) as never) : null},error=NULL WHERE id=${id}`;
  });
}

export async function controlBackfill(id: string, action: "pause" | "resume" | "retry", actor: string) {
  if (!["pause", "resume", "retry"].includes(action)) throw new Error("Unknown backfill action");
  await sql.begin(async (tx) => {
    const [r] = await tx`SELECT * FROM backfill_runs WHERE id=${id} FOR UPDATE`;
    if (!r) throw new Error("Backfill batch not found");
    if (action !== "pause" && r.state === "running") throw new Error("Pause the active executor before resuming or retrying");
    if (action === "retry") {
      // Same article/prompt/model identity: received receipts are reused; unknown ones remain blocked.
      const failed = await tx`SELECT identity_key FROM backfill_items WHERE run_id=${id} AND state='failed' AND day IS NOT NULL`;
      for (const i of failed) {
        const [row] = await tx`SELECT preparation FROM backfill_items WHERE run_id=${id} AND identity_key=${i.identity_key}`;
        if (row?.preparation) {
          const preparation = loadPreparation(row.preparation);
          for (const result of Object.values(preparation.results)) delete result.error;
          await tx`UPDATE backfill_items SET preparation=${tx.json(storePreparation(preparation))} WHERE run_id=${id} AND identity_key=${i.identity_key}`;
        }
      }
      await tx`UPDATE backfill_items SET state='pending',reason=NULL,retry_after=NULL,updated_at=now() WHERE run_id=${id} AND state='failed' AND day IS NOT NULL`;
    }
    if (r.state !== "complete" || action === "retry") {
      await tx`UPDATE backfill_runs SET state=${action === "pause" ? "paused" : "ready"},error=NULL WHERE id=${id}`;
    }
  });
  await audit(actor, `backfill.${action}`, id, null, null, { action });
  return { ok: true };
}

export async function backfillOverview() {
  const runs = await sql`SELECT r.*,r.start_day::text AS start_day,r.end_day::text AS end_day FROM backfill_runs r ORDER BY created_at DESC`;
  const days = await sql`SELECT run_id,day::text AS day,count(*)::int AS total,
    count(*) FILTER(WHERE state IN ('published','filtered','existing'))::int AS done,
    count(*) FILTER(WHERE state='published')::int AS published,
    count(*) FILTER(WHERE state='filtered')::int AS filtered,
    count(*) FILTER(WHERE state='existing')::int AS existing,
    count(*) FILTER(WHERE state='failed')::int AS failed,
    count(*) FILTER(WHERE state='pending')::int AS pending,
    count(*) FILTER(WHERE state='running')::int AS running
    FROM backfill_items WHERE state<>'excluded' GROUP BY run_id,day ORDER BY day`;
  const excluded = await sql`SELECT run_id,reason,count(*)::int AS n FROM backfill_items WHERE state='excluded' GROUP BY run_id,reason`;
  const activeRows = await sql`SELECT i.run_id,i.identity_key,i.article_id,i.day::text AS day,i.stage,i.model,i.state,i.reason,i.updated_at,
    i.material->>'url' AS url,i.preparation->>'dataJson' AS preparation_json
    FROM backfill_items i WHERE state IN ('running','failed') ORDER BY updated_at DESC LIMIT 100`;
  const active = activeRows.map(({ preparation_json, ...i }) => {
    const v = preparation_json ? loadPreparation({ dataJson: preparation_json }).versions[0] : null;
    return { ...i, run_id: String(i.run_id), url: i.url ?? v?.material?.url ?? null, provenance: v?.provenance ?? null };
  });
  return { checkedAt: new Date().toISOString(), runs: runs.map((r) => {
    const own = days.filter(d => d.run_id === r.id);
    const totals = Object.fromEntries(['total','done','published','filtered','existing','pending','running','failed'].map(k => [k, own.reduce((n,d) => n + Number(d[k]), 0)]));
    return { ...r, id: String(r.id), scope: String(r.scope), totals, days: own, excluded: excluded.filter((d) => d.run_id === r.id), active: active.filter((d) => d.run_id === r.id) };
  }) };
}

async function articleFor(runId: string, key: string) {
  return sql.begin(async (tx) => {
    const [i] = await tx`SELECT * FROM backfill_items WHERE run_id=${runId} AND identity_key=${key} FOR UPDATE`;
    if (!i) throw new Error("Backfill item not found");
    const prepared = i.preparation ? loadPreparation(i.preparation) : null;
    if (prepared && (!prepared.selected || prepared.selected.hash !== i.content_hash)) throw new Error("Historical material has not passed completeness verification");
    if (i.article_id) return String(i.article_id);
    const m = i.material as ManifestEntry["material"];
    const result = await upsertMaterial({ ...m, publishedAt: new Date(m.publishedAt), bodyStatus: "ok", via: "import", insertOnly: true,
      discoveredAt: new Date(), backfill: `managed:${runId}` }, tx);
    if (!result.created) {
      await tx`UPDATE backfill_items SET state='existing',article_id=${result.articleId},reason='native_identity_exists',updated_at=now() WHERE run_id=${runId} AND identity_key=${key}`;
      return null;
    }
    const [a] = await tx`UPDATE articles SET managed_backfill_id=${runId} WHERE id=${result.articleId} RETURNING revision,content_hash`;
    await tx`UPDATE backfill_items SET article_id=${result.articleId},article_revision=${a!.revision},article_hash=${a!.content_hash} WHERE run_id=${runId} AND identity_key=${key}`;
    return result.articleId;
  });
}

/** A bounded drain, not a new daemon. Concurrency is supplied from the deployed GPU capacity. */
export async function runBackfill(id: string, options: { concurrency: number; maxItems: number; signal?: AbortSignal; skipLocked?: boolean }) {
  if (![options.concurrency, options.maxItems].every((n) => Number.isSafeInteger(n) && n > 0) || options.concurrency > 64) throw new Error("Supply positive maxItems and concurrency (1–64) from deployed capacity");
  const lock = await sql.reserve();
  let acquired = false;
  try {
    const [l] = await lock`SELECT pg_try_advisory_lock(hashtext(${'backfill:' + id})) AS locked`;
    acquired = !!l!.locked;
    if (!acquired) {
      if (options.skipLocked) return { state: "locked", processed: 0, claimed: 0 };
      throw new Error("This batch already has an executor");
    }
    const [run] = await sql`SELECT * FROM backfill_runs WHERE id=${id}`;
    if (!run) throw new Error("Backfill batch not found");
    if (!["ready", "waiting_models", "running"].includes(run.state) || options.signal?.aborted) return { state: String(run.state), processed: 0, claimed: 0 };
    let ready: Awaited<ReturnType<typeof preflightBackfill>>;
    try {
      if (run.scope === 'history' && stableJson(run.preparation_identity) !== stableJson(preparationIdentity(run.models))) throw new Error("Frozen preparation prompt/model identity changed; inspect before continuing");
      ready = await preflightBackfill(run.models);
    }
    catch (e) {
      await sql`UPDATE backfill_runs SET state='waiting_models',heartbeat_at=now(),error=${String(e).slice(0,500)} WHERE id=${id} AND state IN ('ready','waiting_models','running')`;
      const [last] = await sql`SELECT state FROM backfill_runs WHERE id=${id}`;
      return { state: String(last!.state), processed: 0, claimed: 0 };
    }
    // Acquiring the session lock proves the former executor is gone; reuse settled receipts.
    await sql`UPDATE backfill_items SET state='pending' WHERE run_id=${id} AND state='running'`;
    await sql`UPDATE backfill_runs SET state='running',heartbeat_at=now(),error=NULL WHERE id=${id} AND state<>'paused'`;
    let reserved = 0, claimed = 0, processed = 0;
    async function work() {
      while (reserved < options.maxItems && !options.signal?.aborted) {
        reserved++;
        const item = await sql.begin(async (tx) => {
          const [r] = await tx`SELECT state FROM backfill_runs WHERE id=${id} FOR UPDATE`;
          if (r?.state !== "running" || options.signal?.aborted) return null;
          const [i] = await tx`SELECT identity_key FROM backfill_items WHERE run_id=${id} AND state='pending' AND (retry_after IS NULL OR retry_after<=now()) ORDER BY day,identity_key LIMIT 1 FOR UPDATE SKIP LOCKED`;
          if (!i || options.signal?.aborted) return null;
          await tx`UPDATE backfill_items SET state='running',attempts=attempts+1,updated_at=now() WHERE run_id=${id} AND identity_key=${i.identity_key}`;
          return i;
        });
        if (!item) return;
        claimed++;
        const key = String(item.identity_key);
        try {
          const beforeStage = async (stage: string, model: string) => {
            if (options.signal?.aborted) throw new BackfillPaused("Executor stopping; settled receipts will be reused");
            await ready.check();
            if (options.signal?.aborted) throw new BackfillPaused("Executor stopping; settled receipts will be reused");
            const [r] = await sql`SELECT state FROM backfill_runs WHERE id=${id}`;
            if (r?.state !== "running") throw new BackfillPaused("Backfill paused; settled receipts will be reused");
            await sql`UPDATE backfill_items SET stage=${stage},model=${model},updated_at=now() WHERE run_id=${id} AND identity_key=${key}`;
            await sql`UPDATE backfill_runs SET heartbeat_at=now() WHERE id=${id}`;
          };
          await beforeStage('preparation', '');
          const prepared = await backfillContext.run({ runId: id, models: ready.models, beforeCall: beforeStage }, () => prepareHistoryItem(id, key, run.models));
          if (prepared === 'terminal') { processed++; continue; }
          await beforeStage('import', '');
          const articleId = await articleFor(id, key);
          if (!articleId) { processed++; continue; }
          const beforeCall = async (stage: string, model: string) => {
            await beforeStage(stage, model);
            const [i] = await sql`SELECT 1 FROM backfill_items i JOIN articles a ON a.id=i.article_id
              WHERE i.run_id=${id} AND i.identity_key=${key} AND a.managed_backfill_id=${id} AND a.revision=i.article_revision AND a.content_hash=i.article_hash`;
            if (!i) throw new Error("Reviewed article revision changed; inspect before retrying");
          };
          await beforeCall("analyze", "");
          const [a] = await sql`SELECT processing_state FROM articles WHERE id=${articleId}`;
          let state: string;
          if (["analyzed", "blocked", "skipped"].includes(a!.processing_state)) {
            const [analysis] = await sql`SELECT relevance FROM analyses WHERE article_id=${articleId}
              AND input_revision=(SELECT revision FROM articles WHERE id=${articleId}) ORDER BY id DESC LIMIT 1`;
            state = a!.processing_state === "skipped" ? "skipped" : analysis?.relevance ?? "missing-analysis";
            if (!["pass", "block", "unknown", "skipped"].includes(state)) throw new Error(`Analysis not complete: ${state}`);
            await publishArticle(articleId);
          } else {
            ({ state } = await backfillContext.run({ runId: id, models: ready.models, beforeCall }, () => processArticle(articleId)));
          }
          // Native content checks may leave unusable copy as unknown; that is a filtered result,
          // not an executor failure. Exceptions and missing analyses still require attention.
          if (!["pass", "block", "unknown", "skipped"].includes(state)) throw new Error(`Analysis not complete: ${state}`);
          await beforeCall("finished", "");
          const [p] = await sql`SELECT visibility,eligible FROM publications WHERE article_id=${articleId}`;
          await sql`UPDATE backfill_items SET state=${p?.visibility === "public" && p.eligible ? "published" : "filtered"},stage='finished',reason=${state === "unknown" ? "analysis_unknown" : null},updated_at=now() WHERE run_id=${id} AND identity_key=${key}`;
          processed++;
        } catch (e) {
          const retry = retryablePreparationError(e);
          const retryAt = retry && !(e instanceof BackfillPaused) ? new Date(Date.now() + (e instanceof BudgetExceededError ? e.retryAfterSeconds : 60) * 1000) : null;
          await sql`UPDATE backfill_items SET state=${retry ? "pending" : "failed"},retry_after=${retryAt},reason=${String(e).slice(0,500)},updated_at=now() WHERE run_id=${id} AND identity_key=${key}`;
          if (e instanceof BackfillPaused) return;
        }
      }
    }
    // Never release the batch lock while a sibling is still settling a receipt.
    const workers = await Promise.allSettled(Array.from({ length: options.concurrency }, work));
    const failure = workers.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const [counts] = await sql`SELECT count(*) FILTER(WHERE state IN ('pending','running'))::int AS pending,count(*) FILTER(WHERE state='failed')::int AS failed FROM backfill_items WHERE run_id=${id}`;
    const next = counts!.pending ? "ready" : counts!.failed ? "needs_attention" : "complete";
    await sql`UPDATE backfill_runs SET state=${next},heartbeat_at=now() WHERE id=${id} AND state='running'`;
    const [last] = await sql`SELECT state FROM backfill_runs WHERE id=${id}`;
    return { state: String(last!.state), processed, claimed };
  } finally {
    try { if (acquired) await lock`SELECT pg_advisory_unlock(hashtext(${'backfill:' + id}))`; }
    finally { lock.release(); }
  }
}

/** Visit each eligible batch at most once, sharing the item budget across the whole drain. */
export async function drainBackfills(options: { concurrency: number; maxItems: number; maxRuns: number; signal?: AbortSignal }) {
  if (![options.concurrency, options.maxItems, options.maxRuns].every((n) => Number.isSafeInteger(n) && n > 0) || options.concurrency > 64) throw new Error("Supply positive maxItems, maxRuns and concurrency (1–64) from deployed capacity");
  const candidates = await sql`SELECT id FROM backfill_runs WHERE state IN ('ready','waiting_models','running')
    ORDER BY heartbeat_at ASC NULLS FIRST,created_at,id LIMIT ${options.maxRuns}`;
  const runs: Array<{ id: string; state: string; processed: number; claimed: number }> = [];
  let claimed = 0;
  for (const row of candidates) {
    if (claimed >= options.maxItems || options.signal?.aborted) break;
    const result = await runBackfill(String(row.id), { ...options, maxItems: options.maxItems - claimed, skipLocked: true });
    claimed += result.claimed;
    runs.push({ id: String(row.id), ...result });
  }
  return { stopped: !!options.signal?.aborted, runs };
}
