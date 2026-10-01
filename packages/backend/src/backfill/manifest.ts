import { z } from "zod";
import { sha256, stableJson } from "../lib/ids.ts";
import { identityKeyForUrl } from "../lib/url.ts";

const media = z.object({ kind: z.enum(["image", "video"]), url: z.url(), alt: z.string().nullable().optional(), poster: z.url().nullable().optional() });
const material = z.object({
  sourceId: z.string().min(1), url: z.url(), title: z.string().min(1), author: z.string().nullable().optional(),
  language: z.string().nullable().optional(), publishedAt: z.iso.datetime({ offset: true }),
  excerpt: z.string().nullable().optional(), bodyText: z.string().min(1), bodyHtml: z.string().nullable().optional(),
  media: z.array(media).optional(),
  xPost: z.object({ tweetId: z.string(), authorName: z.string(), handle: z.string(), text: z.string(),
    media: z.array(media).optional(), lang: z.string().nullable().optional(), replyTo: z.string().nullable().optional(),
    quoted: z.object({ authorName: z.string(), handle: z.string(), text: z.string(), url: z.url(), media: z.array(media).optional() }).nullable().optional(),
  }).nullable().optional(),
});
export const manifestEntry = z.object({
  material,
  quality: z.object({ state: z.enum(["complete", "incomplete", "unverified"]), evidence: z.string().min(1), contentHash: z.string().length(64) }),
});
export type ManifestEntry = z.infer<typeof manifestEntry>;
export function materialHash(value: ManifestEntry["material"]): string { return sha256(stableJson(material.parse(value))); }
export function entryIdentity(entry: ManifestEntry): string {
  const key = identityKeyForUrl(entry.material.url);
  if (!key) throw new Error("Material needs a canonical HTTP(S) identity");
  if (entry.material.xPost && key !== `x:${entry.material.xPost.tweetId}`) throw new Error("X post identity does not match URL");
  return key;
}
export function validateManifest(input: unknown[], startDay: string, endDay: string, now = new Date()) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (![startDay, endDay].every((v) => day.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v) || endDay < startDay) throw new Error("Invalid UTC date range");
  if (Date.parse(endDay) + 86400000 > now.getTime() - 48 * 3600000) throw new Error("Backfill dates must be more than 48 hours old");
  const entries = input.map((e) => manifestEntry.parse(e));
  const identities = new Set<string>(), days = new Set<string>();
  for (const e of entries) {
    const key = entryIdentity(e);
    if (identities.has(key)) throw new Error(`Duplicate identity: ${key}; resolve versions before import`);
    identities.add(key);
    if (materialHash(e.material) !== e.quality.contentHash) throw new Error(`Completeness evidence does not match content: ${key}`);
    const d = new Date(e.material.publishedAt).toISOString().slice(0, 10);
    if (e.quality.state === "complete" && d >= startDay && d <= endDay) days.add(d);
  }
  for (let at = Date.parse(startDay); at <= Date.parse(endDay); at += 86400000) {
    const d = new Date(at).toISOString().slice(0, 10);
    if (!days.has(d)) throw new Error(`No verified complete material on ${d}; choose a continuous eligible interval`);
  }
  return { entries, hash: sha256(stableJson({ startDay, endDay, entries })) };
}
