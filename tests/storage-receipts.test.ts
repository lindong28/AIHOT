import { gate, tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { config } from '@aihot/backend/config';
import { closeDb, sql } from '@aihot/backend/db';
import { paidRequest, completeReceipt, rejectReceivedOutput } from '@aihot/backend/providers/receipts';

after(closeDb);
for (const singleCopy of [false, true]) {
  test(`receipt reuse after waiting for result commit (single copy: ${singleCopy})`, async () => {
    const original = config.receiptSingleCopy;
    const req = { service: `storage-race-${tag()}`, purpose: 'storage-test', identity: tag() };
    const payload = { text: 'committed response' };
    const locked = gate<number>(), release = gate();
    let writer: Promise<unknown> | undefined;
    let reuse: ReturnType<typeof paidRequest> | undefined;
    try {
      config.receiptSingleCopy = singleCopy;
      const first = await paidRequest(req, async () => ({ response: payload }));
      await sql.begin(async tx => {
        await tx`UPDATE receipts SET status='pending',response=NULL WHERE id=${first.receiptId}`;
        await tx`UPDATE receipt_attempts SET status='pending',response=NULL WHERE id=${first.attemptId}`;
      });
      writer = sql.begin(async tx => {
        await tx`UPDATE receipts SET status='received',response=${singleCopy ? null : tx.json(payload)} WHERE id=${first.receiptId}`;
        await tx`UPDATE receipt_attempts SET status='received',response=${tx.json(payload)} WHERE id=${first.attemptId}`;
        const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
        locked.open(backend!.pid);
        await release.promise;
      });
      // Surface setup failures instead of leaving the barrier unresolved.
      void writer.catch(() => locked.open(-1));
      const writerPid = await locked.promise;
      assert.ok(writerPid > 0);
      reuse = paidRequest(req, async () => { throw new Error('must reuse without buying again'); });
      void reuse.catch(() => {});
      let waiting = false;
      for (let poll = 0; poll < 150; poll++) {
        const [row] = await sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND ${writerPid} = ANY(pg_blocking_pids(pid))) AS waiting`;
        if (row!.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(waiting, 'reader must enter its locking statement before the writer commits');
      release.open();
      await writer;
      const result = await reuse;
      assert.equal(result.reused, true);
      assert.equal(result.attemptId, first.attemptId);
      assert.deepEqual(result.response, payload);
    } finally {
      release.open();
      await Promise.allSettled([writer, reuse]);
      config.receiptSingleCopy = original;
    }
  });
}

test('single-copy receipts preserve reuse, retries, legacy readers and per-attempt costs', async () => {
  const original = config.receiptSingleCopy;
  const req = { service: 'storage-test', purpose: 'storage-test', identity: tag() };
  const firstPayload = { text: Array.from({length: 300}, () => tag()).join(' ') };
  const nextPayload = { text: 'valid second answer' };
  try {
    config.receiptSingleCopy = false;
    const first = await paidRequest(req, async () => ({ response: firstPayload, cost: {amount: 1, currency: 'USD', basis: 'actual'} }));
    assert.deepEqual((await paidRequest(req, async () => { throw new Error('must reuse legacy'); })).response, firstPayload);
    await rejectReceivedOutput(first.receiptId, first.attemptId, 'fixture invalid output');
    config.receiptSingleCopy = true;
    const second = await paidRequest(req, async () => ({response: nextPayload}));
    assert.equal(second.receiptId, first.receiptId);
    const [row] = await sql`SELECT response,receipt_response(receipts) AS effective FROM receipts WHERE id=${second.receiptId}`;
    assert.equal(row!.response,null, 'old legacy response cannot shadow a new attempt');
    assert.deepEqual(row!.effective,nextPayload);
    await completeReceipt(sql,second.receiptId);
    for (const mode of [true,false]) {
      config.receiptSingleCopy = mode;
      const reused = await paidRequest(req, async () => { throw new Error('must not buy again'); });
      assert.deepEqual(reused.response,nextPayload);
      assert.equal(reused.attemptId,second.attemptId);
    }
    const attempts = await sql`SELECT response,cost,output_validation_error FROM receipt_attempts WHERE receipt_id=${first.receiptId} ORDER BY attempt`;
    assert.deepEqual(attempts.map(a=>a.response),[firstPayload,nextPayload]);
    assert.equal(attempts[0]!.cost,1);
    assert.equal(attempts[1]!.cost,null);
    assert.equal(attempts[0]!.output_validation_error,'fixture invalid output');
  } finally { config.receiptSingleCopy = original; }
});

test('identical responses occupy one payload instead of two without changing their readback', async () => {
  const original = config.receiptSingleCopy, payload = { text: Array.from({length: 1000}, () => tag()).join(' ') };
  const bytes: number[] = [];
  try {
    for (const mode of [false,true]) {
      config.receiptSingleCopy=mode;
      const result=await paidRequest({service:'storage-test',purpose:'bytes',identity:tag()},async()=>({response:payload}));
      const [size]=await sql`SELECT coalesce(pg_column_size(r.response),0)+coalesce(pg_column_size(a.response),0) AS bytes,
        receipt_response(r) AS response FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id AND a.attempt=r.attempts WHERE r.id=${result.receiptId}`;
      bytes.push(size!.bytes); assert.deepEqual(size!.response,payload);
    }
    assert.ok(bytes[1]! < bytes[0]! / 1.9, JSON.stringify(bytes));
    console.log('stored payload bytes double/single:',bytes);
  } finally { config.receiptSingleCopy=original; }
});
