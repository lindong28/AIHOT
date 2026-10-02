import { gate, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { BudgetExceededError, paidRequest } from "@aihot/backend/providers/receipts";
import { collectPosts, monitorTick, processPending } from "@aihot/backend/monitor/scan";
import { readXSearch, type XBacklog } from "@aihot/backend/sources/x";

const T = tag();
const queries: string[] = [];
const tweet = (id: string, parent?: string) => ({ id_str: id, tweet_created_at: new Date().toISOString(), full_text: `post ${id}`,
  user: { name: "Tibo", screen_name: "thsottiaux" }, in_reply_to_status_id_str: parent });
let answer: (u: URL) => unknown = () => ({ tweets: [] });
const api = await stub((_hit, req) => {
  const u = new URL(req.url, "http://stub");
  queries.push(u.searchParams.get("query") ?? u.pathname);
  return answer(u);
});
process.env.SOCIALDATA_BASE_URL = api.url;
process.env.SOCIALDATA_API_KEY = "test-only";
config.allowPrivateNetworkFetch = true;
config.modelCallsEnabled = false;
let budget: { per_minute: number; per_hour: number; per_day: number };
before(async () => {
  [budget] = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'socialdata'`;
  await sql`UPDATE budgets SET per_minute = 10000, per_hour = 10000, per_day = 100000 WHERE service = 'socialdata'`;
});
after(async () => {
  await sql`UPDATE budgets SET per_minute = ${budget.per_minute}, per_hour = ${budget.per_hour}, per_day = ${budget.per_day} WHERE service = 'socialdata'`;
  await sql`DELETE FROM monitor_state WHERE key IN ('cursor', 'watermarks', 'lookbackPending')`;
  await api.close();
  await closeDb();
});

test("a crash after receipt save replays the same page across time buckets without another purchase", async () => {
  answer = () => ({ tweets: [tweet("900"), tweet("899")], next_cursor: "p2" });
  let saved: { lastId: string | null; backlog: XBacklog[] } = { lastId: "800", backlog: [] };
  const base = `from:crash${T}`;
  const checkpoint = async (tweets: unknown[], state: typeof saved) => {
    if (tweets.length) throw new Error("database unavailable after paid response");
    saved = structuredClone(state);
  };
  await assert.rejects(readXSearch(base, { ...saved, subject: T, window: "2020-01-01T00:00:00Z", checkpoint }), /database unavailable/);
  const hits = api.hits();
  const recovered = await readXSearch(base, { ...saved, subject: T, window: "2030-01-01T00:00:00Z", maxPages: 1,
    checkpoint: async (_tweets, state) => { saved = structuredClone(state); } });
  assert.equal(api.hits(), hits);
  assert.equal(recovered.lastId, "900");
  assert.equal(saved.backlog[0]!.next, "p2");
  assert.equal(saved.backlog[0]!.window, "2020-01-01T00:00:00Z");
});

test("expired cursor recovers by saved ID boundary; older ranges are never truncated to five", async () => {
  answer = (u) => u.searchParams.get("cursor") === "expired" ? new Reply(422, {})
    : u.searchParams.get("query")!.includes("max_id:80") ? { tweets: [tweet("79"), tweet("78")] } : { tweets: [] };
  const base = `from:expiry${T}`;
  let state = { lastId: "100" as string | null, backlog: [
    { query: `${base} since_id:10`, next: "expired", maxId: "80", window: "2020-01-01" },
    ...Array.from({ length: 6 }, (_, i) => ({ query: `from:legacy${i}`, next: "expired", error: "no saved boundary" })),
  ] as XBacklog[] };
  const checkpoint = async (_tweets: unknown[], s: typeof state) => { state = structuredClone(s); };
  const first = await readXSearch(base, { ...state, subject: T, checkpoint });
  assert.equal(first.backlog.length, 7);
  assert.equal(first.backlog[0]!.next, null);
  assert.match(first.backlog[0]!.query, /since_id:10 max_id:80$/);
  const second = await readXSearch(base, { ...state, subject: T, checkpoint });
  assert.deepEqual(second.tweets.map((t) => t.id_str), ["79", "78"]);
  assert.equal(second.backlog.length, 6);
  assert.equal(second.dropped, 0);
});

test("an invalid legacy cursor without an ID boundary remains visible", async () => {
  answer = (u) => u.searchParams.get("cursor") ? new Reply(400, {}) : { tweets: [] };
  const r = await readXSearch(`from:legacy${T}`, { lastId: "100", subject: T, backlog: [{ query: "from:old", next: "bad" }] });
  assert.equal(r.backlog.length, 1);
  assert.match(r.backlog[0]!.error!, /no saved/);
});

test("monitor stores raw pages before context and does not recognize across an unread older page", async () => {
  await sql`DELETE FROM monitor_state WHERE key IN ('cursor', 'watermarks')`;
  await sql`INSERT INTO monitor_state (key, value) VALUES ('cursor', '{"sinceId":null}')`;
  const base = String(BigInt(Date.now()) * 10000n);
  const newest = String(BigInt(base) + 3n);
  const older = String(BigInt(base) + 1n);
  answer = (u) => {
    if (!u.pathname.endsWith("/search")) throw new Error("context fetched during collection");
    if (u.searchParams.get("cursor")) return { tweets: [tweet(older, "22")] };
    if (u.searchParams.get("query")!.includes("since_id:")) return { tweets: [] };
    return { tweets: [tweet(newest, "21")], next_cursor: "older" };
  };
  const first = await collectPosts();
  assert.equal(first.stored, 1);
  const [row] = await sql`SELECT raw FROM monitor_posts WHERE id = ${newest}`;
  assert.equal(row.raw.contextPending, true);
  assert.deepEqual(await processPending(), { processed: 0, failed: 0 }, "older announcement must be collected before newer confirmation is recognized");
  const second = await collectPosts();
  assert.equal(second.stored, 1);
  assert.ok(queries.some((q) => q === `from:thsottiaux since_id:${newest}`));
  const [cursor] = await sql`SELECT value FROM monitor_state WHERE key = 'cursor'`;
  assert.equal(cursor.value.backlog.length, 0);
  assert.equal(cursor.value.sinceId, newest);
});

test("upgrade recovers already paid monitor pages before its first incremental search", async () => {
  const id = String(BigInt(Date.now()) * 100000n);
  await paidRequest({ service: "socialdata", purpose: "monitor.scan", identity: `upgrade-${T}`,
    requestSummary: { query: "from:thsottiaux", type: "Latest" } }, async () => ({ response: { tweets: [tweet(id, "31")] } }));
  await sql`DELETE FROM monitor_state WHERE key = 'cursor'`;
  answer = () => ({ tweets: [] });
  const before = queries.length;
  await collectPosts();
  assert.equal(queries[before], `from:thsottiaux since_id:${id}`);
  const [post] = await sql`SELECT raw FROM monitor_posts WHERE id = ${id}`;
  assert.equal(post.raw.contextPending, true);
});

test("daily lookback and normal tick cannot overwrite the same monitor cursor", async () => {
  const entered = gate();
  const release = gate();
  answer = async () => { entered.open(); await release.promise; return { tweets: [] }; };
  await sql`UPDATE monitor_posts SET processed_at = now() WHERE processed_at IS NULL`;
  const first = monitorTick({ force: true });
  await entered.promise;
  try {
    const other = await monitorTick({ lookbackHours: 48 });
    assert.equal(other.skipped, true);
    assert.ok("reason" in other);
    assert.equal(other.reason, "monitor already running");
  } finally { release.open(); }
  await first;
  answer = () => ({ tweets: [] });
  await monitorTick();
  assert.ok(queries.some((q) => q.startsWith("from:thsottiaux since_time:")), "the contending lookback is consumed by the next tick");
  assert.equal((await sql`SELECT 1 FROM monitor_state WHERE key = 'lookbackPending'`).length, 0);
});

test("rolling budget waits for the latest blocking release, including lower limits", async () => {
  const service = `test-budget-${T}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 10, 10, 10)`;
  for (let i = 0; i < 3; i++) await paidRequest({ service, purpose: "test", identity: i }, async () => ({ response: {} }));
  await sql`UPDATE receipt_attempts SET started_at = now() - interval '30 seconds' WHERE service = ${service}`;
  await sql`UPDATE budgets SET per_minute = 1, per_hour = 2, per_day = 3 WHERE service = ${service}`;
  await assert.rejects(paidRequest({ service, purpose: "test", identity: "blocked" }, async () => { throw new Error("must not send"); }), (e: unknown) => {
    assert.ok(e instanceof BudgetExceededError);
    assert.ok(e.retryAfterSeconds > 86360 && e.retryAfterSeconds <= 86371, "day window dominates hour and minute");
    return true;
  });
  await sql`UPDATE budgets SET per_day = 10000 WHERE service = ${service}`;
  await assert.rejects(paidRequest({ service, purpose: "test", identity: "hour" }, async () => ({ response: {} })), (e: unknown) => e instanceof BudgetExceededError && e.retryAfterSeconds > 3560 && e.retryAfterSeconds <= 3571);
  await sql`UPDATE budgets SET per_hour = 10000 WHERE service = ${service}`;
  await assert.rejects(paidRequest({ service, purpose: "test", identity: "minute" }, async () => ({ response: {} })), (e: unknown) => e instanceof BudgetExceededError && e.retryAfterSeconds > 20 && e.retryAfterSeconds <= 31);
  await sql`UPDATE receipt_attempts SET started_at = now() - interval '2 days' WHERE service = ${service}`;
  await paidRequest({ service, purpose: "test", identity: "released" }, async () => ({ response: {} }));
});

test("empty search costs are explicitly an estimated bound, not zero billing", async () => {
  answer = () => ({ tweets: [] });
  const base = `from:empty${T}`;
  await readXSearch(base, { lastId: "1", backlog: [], subject: T });
  const [receipt] = await sql`SELECT usage, cost, cost_basis FROM receipts WHERE service = 'socialdata' AND request->>'query' = ${`${base} since_id:1`}`;
  assert.equal(receipt.cost, 0.0002);
  assert.equal(receipt.cost_basis, "estimated");
  assert.equal(receipt.usage.costLowerUsd, 0);
  assert.equal(receipt.usage.costUpperUsd, 0.0002);
});
