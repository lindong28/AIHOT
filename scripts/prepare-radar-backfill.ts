// One-time RADAR adapter. The backend consumes only the resulting native JSONL.
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { materialHash, entryIdentity, manifestEntry, type ManifestEntry } from "@aihot/backend/backfill/manifest";
import { sanitizeBody } from "@aihot/backend/content/sanitize";

const [sourceMapPath, reviewsPath, outputPath, ...inputs] = process.argv.slice(2);
if (!sourceMapPath || !reviewsPath || !outputPath || !inputs.length) {
  console.error("用法：node scripts/prepare-radar-backfill.ts <source-map.json> <reviews.json> <native.jsonl> <raw.jsonl[.gz]> ...\n只转换原始材料，不调用模型或写数据库。reviews 为空对象时所有材料待审核。");
  process.exit(2);
}
const sourceMap = JSON.parse(await readFile(sourceMapPath, "utf8")) as Record<string, string>;
// Review keys are canonical identities; hash selects the exact reviewed version.
const reviews = JSON.parse(await readFile(reviewsPath, "utf8")) as Record<string, { contentHash: string; state: "complete" | "incomplete"; evidence: string; xPost?: ManifestEntry["material"]["xPost"] }>;
const candidates = new Map<string, Map<string, ManifestEntry>>();
const rejected: Record<string, number> = {};
const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };
let read = 0;
for (const file of inputs) {
  const stream = createReadStream(file);
  const lines = createInterface({ input: file.endsWith(".gz") ? stream.pipe(createGunzip()) : stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line); read++;
    if (!sourceMap[row.source_id]) { reject("unmapped_source"); continue; }
    const date = new Date(row.published_at);
    if (!row.published_at || !Number.isFinite(date.getTime())) { reject("invalid_date"); continue; }
    if (!String(row.content_text ?? "").trim()) { reject("missing_body"); continue; }
    const m = { sourceId: sourceMap[row.source_id]!, url: row.url, title: row.title, author: row.author ?? null,
      publishedAt: date.toISOString(), bodyText: row.content_text, bodyHtml: sanitizeBody(row.content_html ?? "", row.url) };
    let e: ManifestEntry;
    try {
      e = manifestEntry.parse({ material: m, quality: { state: "unverified", evidence: "原文完整性尚未审核", contentHash: materialHash(m) } });
      const key = entryIdentity(e);
      // X native structure must be reconstructed and reviewed with the exact material. Never infer missing quote/image context.
      if (reviews[key]?.xPost) e.material.xPost = reviews[key]!.xPost;
      e.quality.contentHash = materialHash(e.material);
      const versions = candidates.get(key) ?? new Map();
      versions.set(e.quality.contentHash, e); candidates.set(key, versions);
    } catch { reject("invalid_material"); }
  }
}
const output = createWriteStream(outputPath, { flags: "wx" });
const states: Record<string, number> = {}, days = new Set<string>();
for (const [key, versions] of candidates) {
  const review = reviews[key];
  let e = (review && versions.get(review.contentHash)) || [...versions.values()].sort((a,b) => a.quality.contentHash.localeCompare(b.quality.contentHash))[0]!;
  if (review && versions.has(review.contentHash)) {
    if (key.startsWith("x:") && !e.material.xPost) {
      e.quality = { ...e.quality, evidence: "X 原生正文、引用和媒体上下文尚未重建审核" };
    } else e.quality = { ...review, contentHash: e.quality.contentHash };
  } else if (review) e.quality.evidence = "审核 hash 与原文版本不匹配，需重新核对";
  else if (versions.size > 1) e.quality.evidence = `有 ${versions.size} 个原文版本，尚未选择审核版本`;
  states[e.quality.state] = (states[e.quality.state] ?? 0) + 1;
  if (e.quality.state === "complete") days.add(e.material.publishedAt.slice(0,10));
  if (!output.write(JSON.stringify(manifestEntry.parse(e)) + "\n")) await once(output, "drain");
}
output.end(); await once(output, "finish");
const intervals: Array<{ start: string; end: string; days: number }> = [];
for (const day of [...days].sort()) {
  const last = intervals.at(-1);
  if (last && Date.parse(day) - Date.parse(last.end) === 86400000) { last.end = day; last.days++; }
  else intervals.push({ start: day, end: day, days: 1 });
}
await writeFile(`${outputPath}.summary.json`, JSON.stringify({ read, identities: candidates.size, states, rejected, intervals }, null, 2));
console.log(`原始转换完成：读取 ${read} 行，输出 ${candidates.size} 个身份；完整 ${states.complete ?? 0}、待审核 ${states.unverified ?? 0}、不完整 ${states.incomplete ?? 0}。\n原生清单：${outputPath}\n连续区间及排除原因：${outputPath}.summary.json\n未写数据库，未调用模型；只有审核后的连续区间可以创建执行批次。`);
