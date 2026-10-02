import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { PgBoss } from "pg-boss";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { logicalKeyFor, paidRequest } from "@aihot/backend/providers/receipts";
import { releaseUnknownReceipt, type GatewayEvidence } from "@aihot/backend/admin/receipt-recovery";
import { ensureQueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { config } from "@aihot/backend/config";
import { queueProcessing, registerContentJobs, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { groupArticle } from "@aihot/backend/events/group";
import { publishArticle } from "@aihot/backend/publication/publish";

after(async () => { await stopBoss(); await closeDb(); });

async function article() {
  const id = tag(), source = tag();
  await sql`INSERT INTO sources (id, name, kind, enabled) VALUES (${source}, 'test', 'rss', false)`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, processing_state, body_status)
    VALUES (${id}, ${source}, ${id}, ${`https://example.test/${id}`}, 'Test', now(), now(), 'failed', 'ok')`;
  return id;
}

async function receipt(purpose: string, subject: string, attemptTag?: string, service = "receipt-recovery-test") {
  const requestId = randomUUID();
  const req = { service, model: "fixture", purpose, subject, identity: { id: tag() }, attemptTag,
    gatewayRequestId: requestId, requestSummary: { gateway: { logicalRequestId: requestId, project: "aihot-test", model: "fixture" } } };
  await assert.rejects(paidRequest(req, async () => { throw new Error("lost"); }));
  const [r] = await sql`SELECT id FROM receipts WHERE logical_key = ${logicalKeyFor(req)}`;
  const evidence: GatewayEvidence = { receiptId: r!.id, requestId, requests: [
    { project: "aihot-test", model: "fixture", outcome: "local_rejected", rejectReason: "route_cooldown", activeAttemptId: null, attempts: [] },
  ] };
  return evidence;
}

const release = (evidence: GatewayEvidence, dryRun = false) => releaseUnknownReceipt(evidence.receiptId,
  { evidence, dryRun, error: "ledger verified", actor: "test", note: "fixture proof", billed: false });

for (const [purpose, suffix] of [["prefilter_article", ""], ["structure_article", "structure"], ["score_article", "score-1"], ["score_article", "score-2"], ["understand_article", "understand"], ["summarize_article", "summarize"], ["analyze_article", ""]]) {
  test(`${purpose}/${suffix}: current failed article recovers same analysis run, once`, async () => {
    const id = await article();
    const e = await receipt(purpose!, `article:${id}@1`, suffix || undefined);
    assert.equal((await release(e, true))!.recovery, "eligible_not_dispatched");
    assert.equal((await sql`SELECT processing_state FROM articles WHERE id = ${id}`)[0]!.processing_state, "failed");
    const result = await release(e);
    assert.equal(result!.requeued, true);
    const jobs = await sql`SELECT data FROM pgboss.job WHERE name = ${QUEUES.analyze} AND data->>'articleId' = ${id}`;
    assert.deepEqual(jobs.map((j) => j.data), [{ articleId: id }]);
    assert.equal(await release(e), null);
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE subject = ${`receipt:${e.receiptId}`} AND action = 'receipt.reconcile'`)[0]!.n, 1);
  });
}

test("admin run tag survives recovery and older attempt costs are not rewritten", async () => {
  const id = await article(), root = `admin:${randomUUID()}`;
  const e = await receipt("score_article", `article:${id}@1`, `${root}:score-2`);
  await sql`UPDATE receipt_attempts SET attempt = 2 WHERE receipt_id = ${e.receiptId}`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, request_id, cost, currency, cost_basis)
    VALUES (${e.receiptId}, 1, 'receipt-recovery-test', 'unknown', ${randomUUID()}, 0.1, 'USD', 'estimated')`;
  await sql`UPDATE receipts SET attempts = 2 WHERE id = ${e.receiptId}`;
  await release(e);
  const [job] = await sql`SELECT data FROM pgboss.job WHERE name = ${QUEUES.analyze} AND data->>'articleId' = ${id}`;
  assert.equal(job!.data.attemptTag, root);
  const attempts = await sql`SELECT status, cost FROM receipt_attempts WHERE receipt_id = ${e.receiptId} ORDER BY attempt`;
  assert.deepEqual(attempts.map((a) => [a.status, a.cost]), [["unknown", 0.1], ["failed", null]]);
});

for (const invalid of ["uuid", "project", "model", "missing", "ambiguous", "active", "attempt", "failed", "app-attempt"]) {
  test(`reject reconciliation proof: ${invalid}`, async () => {
    const id = await article(), e = await receipt("prefilter_article", `article:${id}@1`);
    if (invalid === "uuid") e.requestId = randomUUID();
    if (invalid === "project") e.requests[0]!.project = "other";
    if (invalid === "model") e.requests[0]!.model = "other";
    if (invalid === "missing") e.requests = [];
    if (invalid === "ambiguous") e.requests.push({ ...e.requests[0]! });
    if (invalid === "active") e.requests[0]!.activeAttemptId = "active";
    if (invalid === "attempt") e.requests[0]!.attempts.push({ id: "a", outcome: "validation_error", dispatchBoundary: "not_crossed" });
    if (invalid === "failed") e.requests[0]!.outcome = "failed";
    if (invalid === "app-attempt") await sql`UPDATE receipt_attempts SET request_id = ${randomUUID()} WHERE receipt_id = ${e.receiptId}`;
    assert.equal((await release(e))!.status, "unknown");
    assert.equal((await sql`SELECT status FROM receipts WHERE id = ${e.receiptId}`)[0]!.status, "unknown");
    assert.equal((await sql`SELECT processing_state FROM articles WHERE id = ${id}`)[0]!.processing_state, "failed");
  });
}

test("stale revision, settled article and backfill never reset into live analysis", async () => {
  for (const scenario of ["revision", "settled", "backfill"]) {
    const id = await article();
    const e = await receipt("prefilter_article", `article:${id}@1`, undefined, scenario === "backfill" ? "backfill" : undefined);
    if (scenario === "revision") await sql`UPDATE articles SET revision = 2 WHERE id = ${id}`;
    if (scenario === "settled") await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${id}`;
    assert.equal((await release(e))!.requeued, false);
  }
});

test("group, signal, digest and monitor retain their own recovery paths", async () => {
  for (const purpose of ["group_article", "group_review", "group_signal"]) {
    const id = await article(), e = await receipt(purpose, `article:${id}${purpose === "group_review" ? ":fact:1" : ""}`);
    assert.equal((await release(e))!.recovery, "group_queued");
    const [job] = await sql`SELECT data FROM pgboss.job WHERE name = ${QUEUES.group} AND data->>'articleId' = ${id}`;
    assert.deepEqual(job!.data, { articleId: id, ...(purpose === "group_signal" ? { signalOnly: true } : {}) });
  }
  const [story] = await sql`INSERT INTO stories (public_id, title) VALUES (${randomUUID()}, 'test') RETURNING id`;
  const digest = await receipt("story_digest", `story:${story!.id}@1`);
  assert.equal((await release(digest))!.recovery, "digest_queued");
  const monitor = await receipt("monitor.recognize", "x:123");
  assert.equal((await release(monitor))!.recovery, "monitor_next_tick");
  const other = await receipt("unknown-purpose", tag());
  assert.equal((await release(other))!.recovery, "unsupported_purpose");
});

test("queue insertion failure rolls back receipt, article and audit together", async () => {
  await ensureQueue(QUEUES.analyze);
  const id = await article(), e = await receipt("prefilter_article", `article:${id}@1`);
  await sql.unsafe(`CREATE FUNCTION reject_recovery_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.data->>'articleId' = '${id}' THEN RAISE EXCEPTION 'fixture queue failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER reject_recovery_job BEFORE INSERT ON pgboss.job FOR EACH ROW EXECUTE FUNCTION reject_recovery_job()");
  try {
    await assert.rejects(release(e), /fixture queue failure/);
    assert.equal((await sql`SELECT status FROM receipts WHERE id = ${e.receiptId}`)[0]!.status, "unknown");
    assert.equal((await sql`SELECT processing_state FROM articles WHERE id = ${id}`)[0]!.processing_state, "failed");
    assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE subject = ${`receipt:${e.receiptId}`}`)[0]!.n, 0);
  } finally {
    await sql.unsafe("DROP TRIGGER reject_recovery_job ON pgboss.job");
    await sql.unsafe("DROP FUNCTION reject_recovery_job()");
  }
});

async function gatewayFixture(fn: (hit: number) => { status: number; content?: object }) {
  let hits = 0;
  const previousUrl = process.env.LLM_GATEWAY_URL, previousProject = process.env.LLM_GATEWAY_PROJECT;
  const previousEnabled = config.modelCallsEnabled;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    const answer = fn(++hits);
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.status === 200
      ? { llm_gateway: { projection_version: 1, logical_request_id: req.headers["x-llm-request-id"] }, choices: [{ message: { content: JSON.stringify(answer.content) } }] }
      : { error: { code: "route_cooldown" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.LLM_GATEWAY_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.LLM_GATEWAY_PROJECT = "aihot-test";
  config.modelCallsEnabled = true;
  return { close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousUrl === undefined) delete process.env.LLM_GATEWAY_URL; else process.env.LLM_GATEWAY_URL = previousUrl;
    if (previousProject === undefined) delete process.env.LLM_GATEWAY_PROJECT; else process.env.LLM_GATEWAY_PROJECT = previousProject;
    config.modelCallsEnabled = previousEnabled;
  } };
}

test("tagged worker cooldown -> deferred sweep -> worker retry keeps paid-request identity", async () => {
  const gateway = await gatewayFixture((hit) => hit === 1 ? { status: 422 } : { status: 200, content: { label: "BLOCK", reason: "普通生活资讯" } });
  try {
    const id = await article(), root = `admin:${randomUUID()}`;
    await sql`UPDATE articles SET processing_state = 'new', body_text = ${"Ordinary daily life and food. ".repeat(20)}, created_at = now() - interval '4 minutes' WHERE id = ${id}`;
    type Handler = (jobs: Array<{ data: { articleId: string; attemptTag?: string } }>) => Promise<unknown>;
    let handler: Handler | undefined;
    await registerContentJobs({ work: async (name: string, _options: unknown, callback: Handler) => { if (name === QUEUES.analyze) handler = callback; } } as unknown as PgBoss);
    await queueProcessing(id, { step: "analyze", attemptTag: root });
    // Use the real registered worker callback; no model or failure handler is mocked.
    await handler!([{ data: { articleId: id, attemptTag: root } }]);
    const [waiting] = await sql`SELECT processing_state, processing_retry_at, processing_attempt_tag FROM articles WHERE id = ${id}`;
    assert.equal(waiting!.processing_state, "new");
    assert.ok(waiting!.processing_retry_at > new Date());
    assert.equal(waiting!.processing_attempt_tag, root);
    await sql`DELETE FROM pgboss.job WHERE name = ${QUEUES.analyze} AND data->>'articleId' = ${id}`;
    await sql`UPDATE articles SET processing_retry_at = now() - interval '1 second', processing_queued_at = NULL WHERE id = ${id}`;
    await sweepUnprocessed();
    const [job] = await sql`SELECT data FROM pgboss.job WHERE name = ${QUEUES.analyze} AND data->>'articleId' = ${id}`;
    assert.equal(job!.data.attemptTag, root);
    await handler!([{ data: job!.data }]);
    const rows = await sql`SELECT status, attempts, logical_key FROM receipts WHERE subject = ${`article:${id}@1`}`;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "completed");
    assert.equal(rows[0]!.attempts, 2);
    assert.ok(rows[0]!.logical_key.endsWith(root));
  } finally { await gateway.close(); }
});

test("a real failed grouping stamps grouped_at but reconciliation still queues recovery", async () => {
  const gateway = await gatewayFixture(() => ({ status: 503 }));
  try {
    const title = `测试事件${tag()}发布新模型`;
    const first = await article(), second = await article();
    for (const id of [first, second]) {
      await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
        VALUES (${id}, 1, 'rule', 'pass', 'ai-models', ${title}, ${title}, 80, false, ${sql.json({ fact: { title, subject: "测试", action: "发布", object: "模型" } })})`;
      await publishArticle(id);
    }
    const [story] = await sql`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${title}, now(), now()) RETURNING id`;
    const [fact] = await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${tag()}, ${story!.id}, ${title}) RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${first}, 'report')`;
    await assert.rejects(groupArticle(second), /Gateway/);
    assert.ok((await sql`SELECT grouped_at FROM articles WHERE id = ${second}`)[0]!.grouped_at);
    const [r] = await sql`SELECT id, request_id, request FROM receipts WHERE purpose = 'group_article' AND subject = ${`article:${second}`}`;
    assert.ok(r);
    // Emulate the old client's ambiguous status after a Gateway local rejection.
    const evidence: GatewayEvidence = { receiptId: r.id, requestId: r.request_id, requests: [{ project: "aihot-test", model: r.request.gateway.model,
      outcome: "local_rejected", rejectReason: "route_cooldown", activeAttemptId: null, attempts: [] }] };
    assert.equal((await release(evidence))!.recovery, "group_queued");
    assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${QUEUES.group} AND data->>'articleId' = ${second}`)[0]!.n, 1);
  } finally { await gateway.close(); }
});
