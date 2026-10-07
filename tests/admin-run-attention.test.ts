import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DEV_AUTH_ROLE = "admin";
const { sql, closeDb } = await import("@aihot/backend/db");
const { buildApp } = await import("../apps/api/src/app.ts");
const { getBoss, stopBoss } = await import("@aihot/backend/jobs/queue");
await getBoss();
const app = await buildApp();
after(async () => { await app.close(); await stopBoss(); await closeDb(); });

async function get(path: string) {
  const response = await app.inject({ method: "GET", url: `/api/admin/${path}` });
  assert.equal(response.statusCode, 200);
  return response.json();
}

test("navigation and receipt issues agree without changing historical billing", async () => {
  const baseline = (await get("nav-counts")).runs;
  const cases = [
    { status: "unknown", age: 0, count: 1 },
    { status: "unknown", age: 100, count: 1 },
    { status: "failed", age: 0, count: 1 },
    { status: "failed", age: 100, count: 0 },
    { status: "pending", age: 1, count: 1 },
    { status: "pending", age: 0, count: 0 },
    { status: "received", age: 1, count: 0 },
    { status: "completed", age: 1, count: 0 },
    { status: "unknown", age: 0, recovery: "recovered", attempt: 1, count: 0 },
    { status: "failed", age: 0, recovery: "recovered", attempt: 1, count: 0 },
    { status: "unknown", age: 0, recovery: "blocked", attempt: 1, count: 1 },
    { status: "unknown", age: 0, recovery: "recovered", attempt: 2, count: 1 },
  ];
  for (const c of cases) {
    const [r] = await sql`INSERT INTO receipts(logical_key,service,purpose,status,attempts,updated_at)
      VALUES (${tag()},'test','score_article',${c.status},${c.attempt ?? 1},now()-make_interval(hours=>${c.age})) RETURNING id`;
    try {
      if (c.recovery) await sql`INSERT INTO receipt_recoveries(receipt_id,original_attempt,batch,target_key,target,state,note,original_status)
        VALUES (${r!.id},1,${tag()},${tag()},'{}',${c.recovery},'test',${c.status})`;
      assert.equal((await get("nav-counts")).runs, baseline + c.count, JSON.stringify(c));
      const listed = (await get("runs")).receipts.issues.some((x: { id: number }) => x.id === Number(r!.id));
      assert.equal(listed, Boolean(c.count), JSON.stringify(c));
      const [unchanged] = await sql`SELECT status,cost FROM receipts WHERE id=${r!.id}`;
      assert.equal(unchanged!.status, c.status);
      assert.equal(unchanged!.cost, null);
    } finally {
      await sql`DELETE FROM receipt_recoveries WHERE receipt_id=${r!.id}`;
      await sql`DELETE FROM receipts WHERE id=${r!.id}`;
    }
  }
});

test("scheduled receipt recovery is not manual attention; exhausted or overdue recovery is", async () => {
  const baseline = (await get("nav-counts")).runs;
  const [row] = await sql`INSERT INTO receipts(logical_key,service,purpose,status,retry_after)
    VALUES (${tag()},'test','score_article','unknown',now()+interval '1 minute') RETURNING id`;
  try {
    assert.equal((await get("nav-counts")).runs,baseline);
    assert.equal((await get("runs")).receipts.issues.some((r:{id:number})=>r.id===Number(row!.id)),false);
    await sql`UPDATE receipts SET recovery_exhausted=true WHERE id=${row!.id}`;
    assert.equal((await get("nav-counts")).runs,baseline+1);
    await sql`UPDATE receipts SET recovery_exhausted=false,retry_after=now()-interval '16 minutes' WHERE id=${row!.id}`;
    assert.equal((await get("nav-counts")).runs,baseline+1);
    const [unchanged] = await sql`SELECT status,cost FROM receipts WHERE id=${row!.id}`;
    assert.equal(unchanged!.status,'unknown'); assert.equal(unchanged!.cost,null);
  } finally { await sql`DELETE FROM receipts WHERE id=${row!.id}`; }
});

test("navigation includes the same delivery states as the runs page", async () => {
  const baseline = (await get("nav-counts")).runs;
  const target = tag();
  await sql`INSERT INTO notify_targets(key,purpose,kind) VALUES (${target},'alert','log')`;
  try {
    for (const c of [
      { status: "unknown", age: 0, count: 1 }, { status: "failed", age: 100, count: 1 },
      { status: "sending", age: 1, count: 1 }, { status: "sending", age: 0, count: 0 },
      { status: "pending", age: 1, count: 0 }, { status: "sent", age: 1, count: 0 },
      { status: "skipped", age: 1, count: 0 },
    ]) {
      const [d] = await sql`INSERT INTO deliveries(target_key,subject_kind,subject_id,dedupe_key,status,updated_at)
        VALUES (${target},'test','test',${tag()},${c.status},now()-make_interval(hours=>${c.age})) RETURNING id`;
      assert.equal((await get("nav-counts")).runs, baseline + c.count, JSON.stringify(c));
      assert.equal((await get("runs")).deliveries.some((x: { id: number }) => x.id === Number(d!.id)), Boolean(c.count));
      await sql`DELETE FROM deliveries WHERE id=${d!.id}`;
    }
  } finally {
    await sql`DELETE FROM deliveries WHERE target_key=${target}`;
    await sql`DELETE FROM notify_targets WHERE key=${target}`;
  }
});
