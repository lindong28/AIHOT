import { sql } from "../db.ts";
import { BAILIAN_QWEN_FALLBACK } from "./context.ts";
import { bindingsSchema } from "./gateway.ts";

/** Expand only the approved recovery policy; primary bindings and receipts stay frozen. */
export async function enableBailianFallback(id: string) {
  return sql.begin(async (tx) => {
    const [lock] = await tx`SELECT pg_try_advisory_xact_lock(hashtext(${'backfill:' + id})) AS locked`;
    if (!lock!.locked) throw new Error("Wait for the active executor to exit before enabling fallback");
    const [r] = await tx`SELECT * FROM backfill_runs WHERE id=${id} FOR UPDATE`;
    if (!r) throw new Error("Backfill batch not found");
    if (r.state !== "paused") throw new Error("Pause the batch before enabling fallback");
    const models = bindingsSchema.parse(r.models);
    for (const role of ["prefilter", "structure"] as const) {
      const b = models[role];
      if (b.model !== "qwen3.8-flash" || !("routes" in b)) throw new Error("Fallback requires an existing Qwen 3.8 Flash routes binding");
      b.fallbackRoutes = [{ ...BAILIAN_QWEN_FALLBACK }];
    }
    bindingsSchema.parse(models);
    await tx`UPDATE backfill_runs SET models=${tx.json(models)} WHERE id=${id}`;
  });
}
