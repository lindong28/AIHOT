import './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { getBoss, drainBoss, stopBoss, stageWorkerRegistrations } from '@aihot/backend/jobs/queue';
import { closeDb } from '@aihot/backend/db';

const boss = await getBoss();
const prefix = `test-deploy-${Date.now()}`;
const queues = [`${prefix}.preview`, `${prefix}.serial`, `cron.${prefix}`];
let release: () => void = () => {};
after(async () => { release(); await drainBoss(); for (const name of queues) await boss.deleteQueue(name); await stopBoss(); await closeDb(); });
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw Error('worker did not reach expected phase'); await delay(10); }
}

test('candidate preview runs alone, activation starts deferred queues, drain preserves in-flight results and leaves later work queued', { timeout: 15000 }, async () => {
  for (const queue of queues) await boss.createQueue(queue, { expireInSeconds: 60 });
  const staged = stageWorkerRegistrations(boss, queues[0]!);
  const seen: string[] = [];
  const held = new Promise<void>(resolve => { release = resolve; });
  for (const name of queues) await staged.boss.work(name, { pollingIntervalSeconds: 0.5 }, async () => { seen.push(name); await held; return { settled: true }; });
  const first: Array<{ name: string; id: string }> = [];
  const next: Array<{ name: string; id: string }> = [];
  for (const name of queues) {
    first.push({ name, id: (await boss.send(name, { first: true }))! });
    next.push({ name, id: (await boss.send(name, { next: true }))! });
  }
  await until(() => seen.length === 1);
  assert.deepEqual(seen, [queues[0]]);
  assert.deepEqual(boss.getWipData().map(w => w.name), [queues[0]]);
  await staged.activate(); await until(() => seen.length === 3);
  let drained = false;
  const draining = drainBoss().then(() => { drained = true; });
  await delay(100); assert.equal(drained, false, 'held callbacks remain owned until completion');
  release(); await draining;
  assert.equal(boss.getWipData().length, 0);
  for (const job of first) assert.equal((await boss.getJobById(job.name, job.id))!.state, 'completed');
  for (const job of next) assert.equal((await boss.getJobById(job.name, job.id))!.state, 'created');
  assert.equal(seen.length, 3);
});
