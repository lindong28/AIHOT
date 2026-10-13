// Explicit operator action. Resumes the saved keyset; no collection, jobs or model calls.
import { buildResearchBatch } from "@aihot/backend/research/index";
import { closeDb } from "@aihot/backend/db";
const limit = Number(process.argv[2] ?? 100);
try {
  let indexed = 0;
  for (;;) {
    const result = await buildResearchBatch(limit);
    indexed += result.indexed;
    console.log(JSON.stringify({indexedThisRun:indexed,ready:result.done}));
    if (result.done) break;
  }
} catch {
  console.error("Research index build failed; saved batches can be resumed. Check database access and migration state.");
  process.exitCode = 1;
} finally { await closeDb(); }
