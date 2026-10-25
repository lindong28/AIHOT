import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { runsOverview } from "@aihot/backend/admin/runs";
import { ensureQueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { rejectReceivedOutput } from "@aihot/backend/providers/receipts";

after(async () => { await stopBoss(); await closeDb(); });

async function findReceipt(view:string,id:number) {
  for (let page=1;;page++) {
    const result=await runsOverview({view,page});
    const row=result.receipts.issues.find(x=>Number(x.id)===id);
    if (row || page*result.receipts.pageSize>=result.receipts.issueTotal) return row;
  }
}

async function receipt(subject: string, purpose = 'prefilter_article', suffix = '0', status = 'unknown') {
  const [r] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,attempts)
    VALUES (${`${tag()}:${suffix}`},'runs-ui-test',${purpose},${subject},${status},1) RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,request_id)
    VALUES (${r!.id},1,'runs-ui-test',${status === 'completed' ? 'received' : status},${`request-${r!.id}-1`})`;
  return Number(r!.id);
}

test('billing retains original attempts after newer success and deduplicates review/recovery', async () => {
  await ensureQueue(QUEUES.analyze);
  const id = await receipt(tag());
  await sql`INSERT INTO receipt_reviews(receipt_id,attempt,billed,disposition,note,actor)
    VALUES (${id},1,null,'stopped','fixture','test')`;
  await sql`INSERT INTO receipt_recoveries(receipt_id,original_attempt,batch,target_key,target,state,note,original_status)
    VALUES (${id},1,'fixture','fixture','{}','recovered','fixture','unknown')`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status) VALUES (${id},2,'runs-ui-test','received')`;
  await sql`UPDATE receipts SET attempts=2,status='completed' WHERE id=${id}`;
  await sql`INSERT INTO receipt_reviews(receipt_id,attempt,billed,note,actor) VALUES (${id},2,false,'new attempt','test')`;
  const before = await runsOverview({view:'billing'});
  const row = await findReceipt('billing',id) as any;
  assert.ok(row);
  assert.ok(await findReceipt('history',id));
  assert.deepEqual(row.billing_pending.map((x: any) => x.attempt), [1]);
  assert.equal(row.billing_pending[0].request_id, `request-${id}-1`);
  const count = before.receipts.billingUnknownTotal;
  await sql`UPDATE receipt_reviews SET billed=false WHERE receipt_id=${id} AND attempt=1`;
  const cleared = await runsOverview({view:'billing'});
  assert.equal(cleared.receipts.billingUnknownTotal, count - 1);
  assert.equal(await findReceipt('billing',id),undefined);
  // A recovery without a review must still keep the historical bill visible.
  await sql`DELETE FROM receipt_reviews WHERE receipt_id=${id} AND attempt=1`;
  assert.equal((await runsOverview({view:'billing'})).receipts.billingUnknownTotal, count);
  await sql`INSERT INTO receipt_reviews(receipt_id,attempt,billed,note,actor) VALUES (${id},1,true,'confirmed billed','test')`;
  assert.equal((await runsOverview({view:'billing'})).receipts.billingUnknownTotal, count - 1);
});

test('same-revision stages distinguish score votes and invalid output without exposing responses', async () => {
  const subject = `article:${tag()}@1`;
  const first = await receipt(subject, 'score_article', 'score-1', 'completed');
  const second = await receipt(subject, 'score_article', 'rerun:score-2');
  const invalid = await receipt(subject, 'understand_article', 'understand', 'received');
  await sql`UPDATE receipt_attempts SET response='{"private":"payload"}' WHERE receipt_id=${invalid}`;
  const [invalidAttempt] = await sql`SELECT id FROM receipt_attempts WHERE receipt_id=${invalid}`;
  await rejectReceivedOutput(invalid,Number(invalidAttempt!.id),'invalid fixture');
  await receipt(subject.replace('@1','@2'), 'summarize_article', 'summarize', 'completed');
  const result = await runsOverview();
  const row = result.receipts.issues.find(x => Number(x.id) === second)! as any;
  assert.ok(row);
  assert.deepEqual(row.related_stages.map((x: any) => Number(x.receipt_id)).sort((a: number,b: number)=>a-b), [first,second,invalid].sort((a,b)=>a-b));
  assert.equal(row.related_stages.find((x: any) => Number(x.receipt_id) === first).score_vote, '1');
  assert.equal(row.related_stages.find((x: any) => Number(x.receipt_id) === second).score_vote, '2');
  assert.equal(row.related_stages.find((x: any) => Number(x.receipt_id) === invalid).validation_failed, true);
  assert.ok(row.related_stages.every((x: any) => !('response' in x)));
});


test('billing pagination counts receipt rows separately from historical attempts', async () => {
  const baseline = await runsOverview({view:'billing'});
  const prefix = tag();
  await sql`INSERT INTO receipts(logical_key,service,purpose,status,attempts)
    SELECT ${prefix} || ':' || n,'runs-ui-test','fixture','completed',2 FROM generate_series(1,45) n`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status)
    SELECT r.id,n,'runs-ui-test','received' FROM receipts r CROSS JOIN generate_series(1,2) n
    WHERE r.logical_key LIKE ${prefix + ':%'}`;
  await sql`INSERT INTO receipt_reviews(receipt_id,attempt,billed,note,actor)
    SELECT r.id,n,null,'fixture','test' FROM receipts r CROSS JOIN generate_series(1,2) n
    WHERE r.logical_key LIKE ${prefix + ':%'}`;
  const first = await runsOverview({view:'billing'});
  const second = await runsOverview({view:'billing',page:2});
  assert.equal(first.receipts.issues.length,40);
  assert.equal(second.receipts.issues.length,Math.min(40,baseline.receipts.issueTotal+5));
  assert.equal(first.receipts.issueTotal,baseline.receipts.issueTotal+45);
  assert.equal(first.receipts.billingUnknownTotal,baseline.receipts.billingUnknownTotal+90);
  assert.equal(new Set([...first.receipts.issues,...second.receipts.issues].map(x=>x.id)).size,first.receipts.issues.length+second.receipts.issues.length);
});
