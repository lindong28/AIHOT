import type { TopicChronicle } from "@aihot/contracts/site";
import { beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { listedCondition, selectedCondition } from "./items.ts";
import { chronicleKinds, chronicleStart, selectTopicChronicle, type ChronicleReport, type ChronicleTopic } from "./topic-chronicle.ts";
import { companyMilestones, readCuratedChronicle, type CuratedChronicle } from "./chronicles.ts";
import { resolveStory } from "./stories.ts";

export async function publicCuratedChronicle(curated: CuratedChronicle, now: Date): Promise<CuratedChronicle> {
  const items = curated.events.flatMap(e => e.item ? [e.item] : []);
  const stories = [...new Set(curated.events.flatMap(e => e.story ? [e.story] : []))];
  const resolutions = new Map<string, number>();
  // Bound DB concurrency for authored histories with many links.
  for (let offset = 0; offset < stories.length; offset += 8) {
    await Promise.all(stories.slice(offset, offset + 8).map(async publicId => {
      let result = await resolveStory(publicId);
      if (result.kind === "merged") result = await resolveStory(result.target);
      if (result.kind === "found") resolutions.set(publicId, result.storyId);
    }));
  }
  const [publicItems, publicStories] = await Promise.all([
    items.length ? sql<{ id: string }[]>`SELECT p.article_id AS id FROM publications p JOIN sources s ON s.id=p.source_id
      WHERE ${listedCondition(now)} AND p.eligible AND s.participation_mode='editorial' AND p.article_id = ANY(${items}::text[])` : [],
    resolutions.size ? sql<{ id: number }[]>`SELECT DISTINCT f.story_id AS id FROM facts f
      JOIN fact_articles fa ON fa.fact_id=f.id JOIN publications p ON p.article_id=fa.article_id JOIN sources s ON s.id=p.source_id
      WHERE ${listedCondition(now)} AND p.eligible AND s.participation_mode='editorial' AND f.story_id = ANY(${[...resolutions.values()]}::bigint[])` : [],
  ]);
  const allowedItems = new Set(publicItems.map(r => r.id)), allowedStories = new Set(publicStories.map(r => r.id));
  return { ...curated, events: curated.events.filter(e => e.item ? allowedItems.has(e.item)
    : e.story ? allowedStories.has(resolutions.get(e.story)!) : true) };
}

export async function loadTopicChronicle(topic: ChronicleTopic, now: Date): Promise<TopicChronicle> {
  const match = topic.entity_id ? [`entity:${topic.entity_id}`] : topic.tags;
  const start = chronicleStart(now);
  const [curated, rows] = await Promise.all([
    readCuratedChronicle(topic),
    sql<Array<ChronicleReport & { output: Record<string, unknown> | null }>>`
      SELECT p.article_id AS id, p.title, p.category, p.tags, coalesce(p.score,0) AS score,
        p.source_id AS "sourceId", p.first_party AS "firstParty",
        coalesce(anchor.first_at,p.published_at) AS "publishedAt", p.timeline_at AS "timelineAt",
        f.public_id AS "factId", st.public_id::text AS "storyPublicId",
        f.subject, f.action, f.object, f.occurred_at AS "occurredAt", an.subjects, an.output
      FROM publications p JOIN sources s ON s.id=p.source_id LEFT JOIN analyses an ON an.id=p.analysis_id
      LEFT JOIN facts f ON f.id=p.fact_id AND EXISTS (SELECT 1 FROM fact_articles fa
        WHERE fa.fact_id=f.id AND fa.article_id=p.article_id AND fa.role <> 'mention')
      LEFT JOIN stories st ON st.id=f.story_id AND st.merged_into IS NULL
      LEFT JOIN LATERAL (
        SELECT min(coalesce(p2.published_at,p2.timeline_at)) AS first_at FROM publications p2
        JOIN sources s2 ON s2.id=p2.source_id JOIN fact_articles fa2 ON fa2.article_id=p2.article_id AND fa2.fact_id=f.id AND fa2.role <> 'mention'
        WHERE p2.fact_id=f.id AND p2.visibility='public' AND p2.selected AND p2.eligible AND p2.visible_after <= ${now}
          AND s2.participation_mode='editorial' AND p2.tags && ${match}::text[]
      ) anchor ON f.id IS NOT NULL AND f.occurred_at IS NULL
      WHERE ${selectedCondition(now)} AND p.eligible AND s.participation_mode='editorial' AND p.tags && ${match}::text[]
        AND (coalesce(f.occurred_at,anchor.first_at,p.published_at,p.timeline_at) >= ${start}
          OR (f.id IS NULL AND an.output->'fact'->>'occurredAt' >= ${beijingDate(start)}))`,
  ]);
  const reports = rows.map(row => {
    const raw = row.output?.fact;
    const fact = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const string = (value: unknown) => typeof value === "string" ? value : null;
    return { ...row, subjects: row.subjects ?? [], itemType: string(row.output?.itemType),
      subject: row.factId ? row.subject : string(fact.subject), action: row.factId ? row.action : string(fact.action),
      object: row.factId ? row.object : string(fact.object), occurredAt: row.factId ? row.occurredAt : string(fact.occurredAt) };
  });
  const months = selectTopicChronicle(topic, reports, now, curated?.through);
  const publicHistory = curated ? await publicCuratedChronicle(curated, now) : undefined;
  return { kinds: chronicleKinds, months,
    milestones: topic.grp === "company" ? companyMilestones(publicHistory, months, now) : [],
    curated: !!publicHistory?.events.length };
}
