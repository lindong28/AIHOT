// Worker process: queues and schedules for collection, processing, events, reports, monitors and ops.
import { assertProductionSecrets } from "@aihot/backend/config";
import { FEATURES } from "@aihot/industry/features";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss, drainBoss, stageWorkerRegistrations } from "@aihot/backend/jobs/queue";
import { access, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { registerContentJobs } from "@aihot/backend/jobs/content";
import { registerSourceJobs } from "@aihot/backend/jobs/sources";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { registerSemanticJobs } from "@aihot/backend/jobs/semantic";
import { registerNotifyJobs } from "@aihot/backend/jobs/notify";
import { registerPublicationJobs } from "@aihot/backend/jobs/publication";
import { registerSchedules } from "./schedules.ts";
import { ensureContentTargets } from "@aihot/backend/notify/deliver";
import { startHeartbeat } from "@aihot/backend/operations/heartbeat";

assertProductionSecrets([["auth", "IMG_PROXY_SIGN_SECRET"]]);

const readyFile = process.env.AIHOT_WORKER_READY_FILE;
const gateFile = process.env.AIHOT_WORKER_GATE_FILE;
async function readiness(state: "standby" | "ready" | "draining") {
  if (!readyFile) return;
  await writeFile(`${readyFile}.next`, JSON.stringify({ state, pid: process.pid, release: process.env.AIHOT_RELEASE ?? "dev" }), { mode: 0o600 });
  await rename(`${readyFile}.next`, readyFile);
}

await ensureContentTargets();
const activeBoss = await getBoss();
let heartbeat: NodeJS.Timeout | undefined;
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "worker stopping" }));
  clearInterval(heartbeat);
  await readiness("draining");
  await drainBoss();
  await stopBoss();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// Prepare all queue registrations without competing with the old process's serial group handler.
// Scheduling/queue definitions keep their existing shared, idempotent pg-boss behavior.
const staged = gateFile ? stageWorkerRegistrations(activeBoss, "research.semantic-query") : null;
const boss = staged?.boss ?? activeBoss;
await registerContentJobs(boss);
if (process.env.COLLECT_ENABLED !== "false") await registerSourceJobs(boss);
await registerEventJobs(boss);
await registerSemanticJobs(boss);
await registerNotifyJobs(boss);
await registerPublicationJobs(boss);
await registerSchedules(boss);
if (gateFile) {
  await readiness("standby");
  // This is a service standby state, not a release-operation wait. SIGTERM before activation has
  // no business callback to interrupt; the deploy command itself has a bounded wait and resume ID.
  while (!(await access(gateFile).then(() => true, () => false))) await delay(500);
  if (stopping) throw new Error("worker stopped before deployment activation");
  await staged!.activate();
}
// A new site has no leaderboard until the first scheduled round: compute one now.
if (FEATURES.leaderboard) {
  const [published] = await sql`SELECT 1 FROM lb_runs WHERE status = 'published' LIMIT 1`;
  if (!published) await boss.send("cron.leaderboard.round", {}, { singletonKey: "first-round" });
}
heartbeat = startHeartbeat("worker");
await readiness("ready");
console.log(JSON.stringify({ level: "info", msg: "worker started", pid: process.pid }));
