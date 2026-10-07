import type { TopicEvent, TopicKind, TopicMonth } from "@aihot/contracts/site";
import { beijingDate, isValidDate } from "@aihot/contracts/time";
import { CHRONICLE_FORMS, CHRONICLE_KINDS, chronicleKind } from "@aihot/industry/chronicle";
import { ENTITIES } from "@aihot/industry/taxonomy";

export interface ChronicleTopic { slug: string; grp: "company" | "field" | "genre"; entity_id: string | null; tags: string[] }
export interface ChronicleReport {
  id: string; title: string; category: string | null; tags: string[]; score: number;
  sourceId: string; firstParty: boolean; publishedAt: Date | string | null; timelineAt: Date | string;
  factId: string | null; storyPublicId: string | null;
  subject: string | null; action: string | null; object: string | null; occurredAt: Date | string | null;
  subjects: string[]; itemType: string | null;
}

export const chronicleKinds: Record<string, TopicKind> = Object.fromEntries(Object.entries(CHRONICLE_KINDS)
  .map(([key, { label, above, launch }]) => [key, { label, ...(above && { above }), ...(launch && { launch }) }]));
const normalized = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

/** Reject impossible calendar dates before Date.parse can silently roll them into the next month. */
export function chronicleDate(value: Date | string | null): Date | null {
  if (!value) return null;
  if (typeof value === "string") {
    if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) || !isValidDate(value.slice(0, 10))) return null;
    if (value.length === 10) value += "T00:00:00+08:00";
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function chronicleStart(now: Date): Date {
  const [year, month] = beijingDate(now).split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 12, 1) - 8 * 3600_000);
}

function entity(subject: string): string | null {
  const key = normalized(subject).replace(/^entity:/, "");
  return Object.entries(ENTITIES).find(([id, e]) => [id, e.name, ...e.aliases].some(n => normalized(n) === key))?.[0] ?? null;
}

function owns(topic: ChronicleTopic, report: ChronicleReport): boolean {
  if (!topic.entity_id) return false;
  if (report.subject?.trim()) return entity(report.subject) === topic.entity_id;
  if (report.subjects.length) return report.subjects.some(s => entity(s) === topic.entity_id);
  const owners = [...new Set(report.tags.filter(t => t.startsWith("entity:")).map(t => t.slice(7)))];
  return owners.length === 1 && owners[0] === topic.entity_id;
}

/** Story is a navigation container, never an occurrence identity. */
function eventKey(r: ChronicleReport): string {
  if (r.factId) return `fact:${r.factId}`;
  const date = chronicleDate(r.occurredAt);
  if (r.subject?.trim() && r.action?.trim() && r.object?.trim() && date) {
    return `event:${JSON.stringify([normalized(r.subject), normalized(r.action), normalized(r.object), beijingDate(date)])}`;
  }
  return `article:${r.id}`;
}

/** All input reports must already meet public eligibility. This function never writes or calls a model. */
export function selectTopicChronicle(topic: ChronicleTopic, reports: ChronicleReport[], now: Date, through?: string): TopicMonth[] {
  const form = CHRONICLE_FORMS[topic.slug];
  if (topic.grp === "genre" && !form) return [];
  const match = topic.entity_id ? [`entity:${topic.entity_id}`] : topic.tags;
  const groups = new Map<string, ChronicleReport[]>();
  for (const r of reports) {
    if (!r.tags.some(tag => match.includes(tag))) continue;
    if (topic.grp === "company" && !owns(topic, r)) continue;
    const key = eventKey(r);
    const group = groups.get(key) ?? [];
    group.push(r); groups.set(key, group);
  }
  const start = chronicleStart(now).getTime();
  const candidates: Array<TopicEvent & { score: number; sources: number; firstParty: boolean }> = [];
  for (const [id, members] of groups) {
    const explicit = members.map(r => chronicleDate(r.occurredAt)).filter((d): d is Date => !!d);
    const dates = explicit.length ? explicit : members.map(r => chronicleDate(r.publishedAt) ?? chronicleDate(r.timelineAt)).filter((d): d is Date => !!d);
    if (!dates.length) continue;
    const time = Math.min(...dates.map(d => d.getTime()));
    if (time < start || time > now.getTime()) continue;
    const month = beijingDate(time).slice(0, 7);
    if (through && month <= through) continue;
    const eligible = members.map(r => ({ r, kind: chronicleKind(r, topic.grp) })).filter(({ r, kind }) => {
      const rule = kind ? CHRONICLE_KINDS[kind] : undefined;
      const threshold = topic.grp === "company" ? rule?.company : rule?.other;
      return threshold && r.score >= threshold.min && (topic.grp !== "genre" || form!.kinds.includes(kind!));
    }).sort((a, b) => b.r.score - a.r.score || Number(b.r.firstParty) - Number(a.r.firstParty) || a.r.id.localeCompare(b.r.id));
    const head = eligible[0];
    if (!head) continue;
    const r = head.r;
    candidates.push({ id, title: r.title, at: new Date(time).toISOString(), kind: head.kind!,
      href: r.storyPublicId ? `/story/${r.storyPublicId}` : `/items/${r.id}`,
      score: r.score, sources: new Set(members.map(r => r.sourceId)).size, firstParty: members.some(r => r.firstParty) });
  }
  candidates.sort((a, b) => b.score - a.score || b.sources - a.sources || Number(b.firstParty) - Number(a.firstParty)
    || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const months = new Map<string, TopicEvent[]>();
  for (const { score, sources, firstParty, ...event } of candidates) {
    const month = beijingDate(event.at).slice(0, 7), picked = months.get(month) ?? [];
    const limit = topic.grp === "company" ? CHRONICLE_KINDS[event.kind]!.company!.perMonth : (form?.perMonth ?? 5);
    if ((topic.grp === "company" ? picked.filter(e => e.kind === event.kind) : picked).length >= limit) continue;
    picked.push(event); months.set(month, picked);
  }
  return [...months].sort(([a], [b]) => b.localeCompare(a)).map(([month, events]) => ({ month,
    events: events.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)) }));
}
