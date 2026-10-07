import type { TopicMilestone, TopicMonth } from "@aihot/contracts/site";
import { beijingDate, isValidDate } from "@aihot/contracts/time";
import { CHRONICLE_KINDS } from "@aihot/industry/chronicle";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../config.ts";
import type { ChronicleTopic } from "./topic-chronicle.ts";

const date = z.string().regex(/^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/)
  .refine(d => d.length < 10 || isValidDate(d), "invalid calendar date");
const entry = z.strictObject({
  date, kind: z.string().refine(k => Object.hasOwn(CHRONICLE_KINDS, k), "unknown kind"),
  title: z.string().trim().min(1).max(60), summary: z.string().trim().min(1).max(80).optional(),
  major: z.boolean().optional(), story: z.uuid().optional(), item: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  url: z.url({ protocol: /^https$/ }).optional(),
}).refine(e => [e.story, e.item, e.url].filter(Boolean).length <= 1, "at most one link");
const file = z.strictObject({
  topic: z.string(), through: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/), events: z.array(entry).min(1),
}).refine(f => f.events.every(e => e.date.slice(0, 7) <= f.through), "event after curated month");
export type CuratedChronicle = z.infer<typeof file>;

export function parseChronicle(json: unknown, topic: ChronicleTopic): CuratedChronicle {
  const data = file.parse(json);
  if (data.topic !== topic.slug || topic.grp !== "company") throw new Error(`Invalid company chronicle: ${topic.slug}`);
  return data;
}

/** Read just this topic's file; a broken unrelated file cannot poison every topic. */
export async function readCuratedChronicle(topic: ChronicleTopic): Promise<CuratedChronicle | undefined> {
  if (topic.grp !== "company" || !/^[a-z0-9-]+$/.test(topic.slug)) return undefined;
  let text: string;
  try { text = await readFile(path.join(REPO_ROOT, "industry/chronicles", `${topic.slug}.json`), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return parseChronicle(JSON.parse(text), topic);
}

/** Callers remove unpublished internal references before composing the public response. */
export function companyMilestones(curated: CuratedChronicle | undefined, months: TopicMonth[], now: Date): TopicMilestone[] {
  const history = (curated?.events ?? []).filter(e => e.date <= beijingDate(now).slice(0, e.date.length)).map(e => ({
    date: e.date, kind: e.kind, title: e.title, summary: e.summary ?? null,
    href: e.story ? `/story/${e.story}` : e.item ? `/items/${e.item}` : (e.url ?? null),
    external: !!e.url, major: e.major ?? false,
  }));
  const automatic = months.flatMap(m => m.events).map(e => ({
    date: beijingDate(e.at), kind: e.kind, title: e.title, summary: null,
    href: e.href, external: false, major: false,
  }));
  return [...history, ...automatic].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}
