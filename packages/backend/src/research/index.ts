import { sql } from "../db.ts";
import { loadPreparation,storePreparation } from "../backfill/history-input.ts";

/** One resumable batch, never called from an HTTP read. A row lock serializes builders. */
export async function buildResearchBatch(limit = 100): Promise<{done:boolean; indexed:number}> {
  if (!Number.isInteger(limit) || limit<1 || limit>1000) throw Error("batch must be 1..1000");
  return sql.begin(async tx=>{
    const [state] = await tx`SELECT * FROM research_index_state WHERE singleton FOR UPDATE`;
    if (!state) throw Error("research migration missing");
    if (state.articles_complete && state.materials_complete) return {done:true,indexed:0};
    const articles = !state.articles_complete;
    // Keyset traversal uses the articles unique identity index / backfill identity index.
    const rows = articles
      ? await tx`SELECT identity_key FROM articles WHERE identity_key>${state.article_cursor??""} ORDER BY identity_key LIMIT ${limit}`
      : await tx`SELECT DISTINCT identity_key FROM backfill_items WHERE identity_key>${state.material_cursor??""} ORDER BY identity_key LIMIT ${limit}`;
    for (const r of rows) {
      if (!articles) {
        const old = await tx`SELECT run_id,preparation FROM backfill_items WHERE identity_key=${r.identity_key}
          AND content_discarded_at IS NULL AND preparation->>'dataJson' IS NOT NULL AND NOT (preparation ? 'research') FOR UPDATE`;
        for (const b of old) await tx`UPDATE backfill_items SET preparation=${tx.json(storePreparation(loadPreparation(b.preparation)))}
          WHERE run_id=${b.run_id} AND identity_key=${r.identity_key}`;
      }
      await tx`SELECT research_refresh(${r.identity_key})`;
    }
    const last = rows.at(-1)?.identity_key;
    if (articles) await tx`UPDATE research_index_state SET article_cursor=${last??state.article_cursor},articles_complete=${rows.length<limit}`;
    else await tx`UPDATE research_index_state SET material_cursor=${last??state.material_cursor},materials_complete=${rows.length<limit}`;
    return {done:!articles && rows.length<limit,indexed:rows.length};
  }) as Promise<{done:boolean;indexed:number}>;
}
