import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { manifestEntry, materialHash, type ManifestEntry } from "./manifest.ts";

export interface HistoryVersion {
  key: string;
  day: string | null;
  provenance: Record<string, unknown>;
  prefilter: { row: { key: string; article: any; provenance: unknown }; inputHash: string } | null;
  material: ManifestEntry["material"] | null;
  targetUrls: string[];
  context: Record<string, unknown>;
  approved?: ManifestEntry["quality"];
}
export interface HistoryCandidate {
  identityKey: string;
  day: string | null;
  dayBasis: "earliest_version_utc";
  error: string | null;
  versions: HistoryVersion[];
}
export interface PreparationState {
  versions: HistoryVersion[];
  dayBasis: HistoryCandidate["dayBasis"];
  results: Record<string, { prefilter?: any; fetched?: any; quality?: any; error?: string }>;
  selected?: { key: string; hash: string; evidence: string };
}
// PostgreSQL JSONB rejects NUL and lone surrogates found in real archived text.
// Keep the JSON-encoded payload as a string so every original code unit survives.
export function storePreparation(state: PreparationState) { return { dataJson: JSON.stringify(state) }; }
export function loadPreparation(value: { dataJson: string }): PreparationState { return JSON.parse(value.dataJson); }

export async function* jsonLines(file: string): AsyncGenerator<{ line: string; value: any; ordinal: number }> {
  const input = createReadStream(file), stream = file.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  let pending = "", ordinal = 0;
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    pending += chunk;
    let at: number;
    while ((at = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      if (line.trim()) yield { line, value: JSON.parse(line), ordinal: ++ordinal };
    }
  }
  if (pending.trim()) yield { line: pending, value: JSON.parse(pending), ordinal: ++ordinal };
}
export async function historyFileHash(file: string): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}

export function validateCandidate(c: HistoryCandidate, start: string, end: string): void {
  if (!c.versions.length || c.dayBasis !== "earliest_version_utc") throw new Error("History candidate has no frozen versions/day basis");
  const days = c.versions.map(v => v.day).filter((d): d is string => d !== null).sort();
  if (c.day !== (days[0] ?? null)) throw new Error("Frozen ownership day must be the earliest raw version UTC day");
  const keys = new Set<string>();
  for (const v of c.versions) {
    if (!v.key || keys.has(v.key)) throw new Error("Duplicate raw version key");
    keys.add(v.key);
    if (v.day && (!/^\d{4}-\d{2}-\d{2}$/.test(v.day) || new Date(v.day).toISOString().slice(0, 10) !== v.day)) throw new Error("Invalid version day");
    if (v.material) {
      const identity = identityKeyForUrl(v.material.url);
      if (identity !== c.identityKey || (v.material.xPost && identity !== `x:${v.material.xPost.tweetId}`)) throw new Error("Version canonical identity mismatch");
      if (v.approved) {
        const e = manifestEntry.parse({ material: v.material, quality: v.approved });
        if (e.quality.state !== "complete" || materialHash(e.material) !== e.quality.contentHash) throw new Error("Approval hash mismatch");
      }
    }
    if (v.prefilter && v.prefilter.row.key !== v.key) throw new Error("Prefilter version key mismatch");
  }
  if (!c.error && (!c.day || c.day < start || c.day > end || !c.versions.some(v => v.material))) throw new Error("Runnable history candidate must have a valid date and material");
  if (!c.identityKey.startsWith("invalid:") && !c.versions.some(v => v.material && identityKeyForUrl(v.material.url) === c.identityKey)) throw new Error("Missing canonical identity witness");
}

/** Freeze once, then stream into the existing durable item list in one transaction. */
export async function importHistory(input: { file: string; label: string; startDay: string; endDay: string }) {
  const day = z.iso.date(); day.parse(input.startDay); day.parse(input.endDay);
  if (!input.label.trim() || input.endDay < input.startDay || Date.parse(input.endDay) + 86400000 > Date.now() - 48 * 3600000) throw new Error("Invalid historical interval/label");
  const fileHash = await historyFileHash(input.file);
  const hash = sha256(stableJson({ format: 1, startDay: input.startDay, endDay: input.endDay, fileHash }));
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'history-import:' + hash}))`;
    const [old] = await tx`SELECT id FROM backfill_runs WHERE manifest_hash=${hash}`;
    if (old) return { id: String(old.id), reused: true };
    const id = randomUUID(), sources = new Set((await tx`SELECT id FROM sources`).map(s => s.id));
    await tx`INSERT INTO backfill_runs(id,label,manifest_hash,start_day,end_day,scope) VALUES(${id},${input.label},${hash},${input.startDay},${input.endDay},'history')`;
    const keys = new Set<string>(); let count = 0;
    for await (const { value } of jsonLines(input.file)) {
      const c = value as HistoryCandidate; validateCandidate(c, input.startDay, input.endDay);
      for (const v of c.versions) {
        if (keys.has(v.key)) throw new Error(`Version belongs to multiple candidates: ${v.key}`);
        keys.add(v.key);
        if (v.material && !sources.has(v.material.sourceId)) throw new Error(`Missing native source ${v.material.sourceId}`);
      }
      const preparation: PreparationState = { versions: c.versions, dayBasis: c.dayBasis, results: {} };
      const canTriageInvalidUrl = c.error === 'invalid_original_url' && c.versions.some(v => v.prefilter);
      await tx`INSERT INTO backfill_items(run_id,identity_key,day,material,content_hash,evidence,state,reason,preparation)
        VALUES(${id},${c.identityKey},${c.day},'{}','', 'awaiting_preparation',${c.error && !canTriageInvalidUrl ? 'failed' : 'pending'},${c.error},${tx.json(storePreparation(preparation))})`;
      count++;
    }
    if (!count || await historyFileHash(input.file) !== fileHash) throw new Error("Frozen history file empty or changed while importing");
    return { id, reused: false };
  });
}
