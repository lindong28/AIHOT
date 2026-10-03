// One-time offline conversion. Source archives remain read-only; no DB or model calls.
import { readFile, mkdir, open, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { jsonLines, historyFileHash, validateCandidate, type HistoryCandidate, type HistoryVersion } from "../packages/backend/src/backfill/history-input.ts";
import { identityKeyForUrl } from "../packages/backend/src/lib/url.ts";
import { sha256 } from "../packages/backend/src/lib/ids.ts";
import { manifestEntry, materialHash, type ManifestEntry } from "../packages/backend/src/backfill/manifest.ts";
import { durableJson } from "../packages/backend/src/backfill/preparation-prefilter.ts";

const files = {
  originals: "prepared-v2/original-versions.jsonl.gz", coverage: "full-prefilter-input/coverage.jsonl",
  prefilter: "full-prefilter-input/input.jsonl", rebuilt: "full-x/rebuilt.jsonl.gz", inventory: "full-non-x/inventory.jsonl",
  approved: "import-ready-v1/approved-all.jsonl", sourceMap: "source-map-flat.json", archival: "archive-source-registration.json",
} as const;
export async function freezeHistory(options: { root: string; output: string; startDay: string; endDay: string }) {
  const inputHashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k,v]) => [k, await historyFileHash(join(options.root,v))])));
  const mapping = { ...JSON.parse(await readFile(join(options.root, files.archival), "utf8")).old_to_proposed_native,
    ...JSON.parse(await readFile(join(options.root, files.sourceMap), "utf8")) } as Record<string,string>;
  const coverage = new Map<string, any>(), prefilter = new Map<string, HistoryVersion["prefilter"]>(), rebuilt = new Map<string, any>(), inventory = new Map<string, string[]>();
  for await (const { value: r } of jsonLines(join(options.root, files.coverage))) {
    if (coverage.has(r.key)) throw new Error("Duplicate coverage key"); coverage.set(r.key, r.identity ?? null);
  }
  for await (const { value: r, line } of jsonLines(join(options.root, files.prefilter))) {
    if (prefilter.has(r.key)) throw new Error("Duplicate prefilter key"); prefilter.set(r.key, { row: r, inputHash: sha256(line) });
  }
  for await (const { value: r } of jsonLines(join(options.root, files.rebuilt))) {
    const key = `${r.provenance.id}:${r.provenance.legacyContentHash}`;
    if (rebuilt.has(key)) throw new Error("Duplicate rebuilt X key");
    rebuilt.set(key, { identity: r.identity, material: r.material, context: { kind: "x", format: r.format, gaps: r.gaps, quoteAlternatives: r.quoteAlternatives, quoteProvenance: r.quoteProvenance, domPartition: r.domPartition } });
  }
  for await (const { value: r } of jsonLines(join(options.root, files.inventory))) inventory.set(`${r.origin.id}:${r.origin.legacyContentHash}`, r.targetUrls);
  const approved = new Map<string, ManifestEntry>();
  for await (const { value } of jsonLines(join(options.root, files.approved))) {
    const e = manifestEntry.parse(value), key = identityKeyForUrl(e.material.url)!;
    if (e.quality.state !== 'complete' || materialHash(e.material) !== e.quality.contentHash || approved.has(key)) throw new Error("Invalid/duplicate approved identity");
    approved.set(key, e);
  }
  const candidates = new Map<string, HistoryCandidate>(), seen = new Set<string>();
  for await (const { value: r, line, ordinal } of jsonLines(join(options.root, files.originals))) {
    const key = `${r.id}:${r.legacyContentHash}`;
    if (seen.has(key)) throw new Error(`Duplicate archive key ${key}`); seen.add(key);
    const x = rebuilt.get(key);
    const identity = x?.material ? identityKeyForUrl(x.material.url) : x?.identity ?? identityKeyForUrl(r.url);
    if (!coverage.has(key) || coverage.get(key) !== identity) throw new Error(`Coverage identity mismatch at ${key}`);
    const identityKey = identity ?? `invalid:${key}`;
    const date = new Date(r.publishedAt), day = Number.isFinite(date.getTime()) ? date.toISOString().slice(0,10) : null;
    const sourceId = mapping[r.sourceId];
    if (identity && !sourceId) throw new Error(`Source mapping missing: ${r.sourceId}`);
    const material = !identity ? null : x?.material ? { ...x.material, sourceId } : {
      sourceId, url: r.url, title: r.title || r.url, author: r.author ?? null, publishedAt: r.publishedAt,
      bodyText: r.bodyText || r.title || r.url, bodyHtml: r.bodyHtml ?? null,
    };
    const version: HistoryVersion = { key, day, provenance: { file: files.originals, fileHash: inputHashes.originals, line: ordinal,
      rawHash: sha256(line), archive: r.archive, id: r.id, legacyContentHash: r.legacyContentHash, sourceId: r.sourceId, sourceKind: r.sourceKind, url: r.url, publishedAt: r.publishedAt },
      prefilter: prefilter.get(key) ?? null, material, targetUrls: inventory.get(key) ?? [], context: x?.context ?? { kind: 'article', originalFulltextEvidence: null } };
    // Keep raw provenance; the reviewed material is an exact separate version, never a new raw count.
    const approval = approved.get(identityKey);
    if (approval) {
      version.material = approval.material; version.approved = approval.quality;
      version.context = { ...version.context, approvedFile: files.approved, approvedFileHash: inputHashes.approved };
      approved.delete(identityKey);
    }
    const item = candidates.get(identityKey) ?? { identityKey, day, dayBasis: 'earliest_version_utc', error: null, versions: [] };
    item.versions.push(version);
    if (day && (!item.day || day < item.day)) item.day = day;
    if (!identity) item.error = 'invalid_original_url';
    else if (!day) item.error = 'invalid_original_date';
    candidates.set(identityKey, item);
    prefilter.delete(key); rebuilt.delete(key); inventory.delete(key);
  }
  if (seen.size !== coverage.size || prefilter.size || rebuilt.size || inventory.size || approved.size) throw new Error("Frozen inventory coverage mismatch: unassigned input remains");
  await mkdir(options.output, { recursive: true });
  const output = join(options.output, 'candidates.jsonl'), temporary = output + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  const days: Record<string, number> = {}; let errors = 0, crossDayIdentities = 0;
  try {
    for (const c of [...candidates.values()].sort((a,b) => a.identityKey.localeCompare(b.identityKey))) {
      c.versions.sort((a,b) => a.key.localeCompare(b.key));
      if (c.day && (c.day < options.startDay || c.day > options.endDay)) c.error = 'outside_frozen_range';
      validateCandidate(c, options.startDay, options.endDay);
      if (c.error) errors++;
      if (new Set(c.versions.map(v => v.day)).size > 1) crossDayIdentities++;
      days[c.day ?? 'unknown'] = (days[c.day ?? 'unknown'] ?? 0) + 1;
      await handle.write(JSON.stringify(c) + '\n');
    }
    await handle.sync();
  } finally { await handle.close(); }
  for (const [k,v] of Object.entries(files)) if (await historyFileHash(join(options.root,v)) !== inputHashes[k]) throw new Error("Source archive changed during freeze");
  // Never replace a previously frozen input with a changed snapshot.
  const hash = await historyFileHash(temporary);
  try { if (await historyFileHash(output) !== hash) throw new Error("Output already contains a different frozen history input"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await rename(temporary, output);
  const summary = { format: 1, startDay: options.startDay, endDay: options.endDay, rawVersions: seen.size, candidates: candidates.size,
    exceptions: errors, crossDayIdentities, days, inputHashes, candidatesSha256: hash };
  await durableJson(join(options.output, 'manifest.json'), summary);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, output, startDay, endDay] = process.argv.slice(2);
  try {
    if (!root || !output || !startDay || !endDay || process.argv.length !== 6) throw new Error('Usage: node scripts/backfill-freeze-history.ts <archive-root> <output-directory> <start-day> <end-day>');
    const r = await freezeHistory({ root, output, startDay, endDay });
    console.log(`历史输入已冻结：${r.rawVersions} 个原始版本归属 ${r.candidates} 条新闻，${r.exceptions} 条输入异常，${r.crossDayIdentities} 个身份跨日。未导入、未调用模型；明细见 ${join(output,'manifest.json')}。`);
  } catch (e) { console.error(`历史输入未完成：${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
}
