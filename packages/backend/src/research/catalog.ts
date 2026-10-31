import { type Db } from "../db.ts";

export class ResearchInputError extends Error {
  readonly selector?: string;
  readonly candidates?: {id:string;name:string}[];
  constructor(message: string, selector?: string, candidates?: {id:string;name:string}[]) {
    super(message); this.selector=selector; this.candidates=candidates;
  }
}

// Names and aliases are explicit identities, never fuzzy guesses. ID wins over display names.
export async function resolveSources(db: Db, sources: string[] = [], groups: string[] = []): Promise<string[] | null> {
  if (!sources.length && !groups.length) return null;
  const result = new Set<string>();
  for (const selector of new Set(sources)) {
    const exact = await db`SELECT id,name FROM sources WHERE id=${selector}`;
    const matches = exact.length ? exact : await db`SELECT s.id,s.name FROM sources s WHERE lower(s.name)=lower(${selector})
      OR EXISTS (SELECT 1 FROM research_source_aliases a WHERE a.source_id=s.id AND lower(a.alias)=lower(${selector})) ORDER BY s.id`;
    if (matches.length !== 1) throw new ResearchInputError(matches.length ? "ambiguous_source" : "unknown_source",selector,matches.map(r=>({id:r.id,name:r.name})));
    result.add(matches[0]!.id);
  }
  for (const selector of new Set(groups)) {
    const exact = await db`SELECT id,name FROM research_groups WHERE id=${selector}`;
    const matches = exact.length ? exact : await db`SELECT id,name FROM research_groups WHERE lower(name)=lower(${selector}) ORDER BY id`;
    if (matches.length !== 1) throw new ResearchInputError(matches.length ? "ambiguous_group" : "unknown_group",selector,matches.map(r=>({id:r.id,name:r.name})));
    for (const row of await db`SELECT source_id FROM research_group_sources WHERE group_id=${matches[0]!.id}`) result.add(row.source_id);
  }
  return [...result].sort();
}

export async function listGroups(db: Db) {
  const rows = await db`SELECT g.id,g.name,coalesce(array_agg(m.source_id ORDER BY m.source_id) FILTER (WHERE m.source_id IS NOT NULL),'{}') AS "sourceIds"
    FROM research_groups g LEFT JOIN research_group_sources m ON m.group_id=g.id GROUP BY g.id ORDER BY g.id`;
  return {items:rows,nextCursor:null,consistency:"live",asOf:new Date().toISOString(),changedSinceStart:false};
}

export async function setGroup(db: Db, id: string, name: string, sources: string[]) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !name.trim() || name.trim().length>200 || sources.length>100)
    throw new ResearchInputError("invalid_group");
  const ids = await resolveSources(db,sources);
  await db`INSERT INTO research_groups(id,name) VALUES(${id},${name.trim()}) ON CONFLICT(id) DO UPDATE SET name=excluded.name`;
  // Caller provides a transaction: replacement is never observable halfway through.
  await db`DELETE FROM research_group_sources WHERE group_id=${id}`;
  for (const source of ids ?? []) await db`INSERT INTO research_group_sources(group_id,source_id) VALUES(${id},${source})`;
}

export async function setAlias(db: Db, source: string, alias: string) {
  if (!alias.trim() || alias.trim().length>200) throw new ResearchInputError("invalid_alias");
  const ids = await resolveSources(db,[source]);
  await db`INSERT INTO research_source_aliases(source_id,alias) VALUES(${ids![0]!},${alias.trim()}) ON CONFLICT DO NOTHING`;
}
