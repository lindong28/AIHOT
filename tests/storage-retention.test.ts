import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { dailyRetention } from '@aihot/backend/operations/retention';

after(closeDb);
test('failed file removal remains retryable while independent expired files are reclaimed', async () => {
  const original = config.dataDir, dir = await mkdtemp(path.join(tmpdir(), 'aihot-retention-'));
  config.dataDir = dir;
  const bad = `bad-${tag()}`, good = `good-${tag()}`, absent = `absent-${tag()}`, live = `live-${tag()}`;
  try {
    await mkdir(path.join(dir, bad));
    for (const key of [good, live]) await writeFile(path.join(dir, key), 'keep or remove');
    for (const key of [bad, good, absent, live]) await sql`INSERT INTO stored_files(key,content_type,bytes,purpose,expires_at)
      VALUES(${key},'text/plain',14,'test',${new Date(Date.now() + (key === live ? 86400_000 : -86400_000))})`;
    await assert.rejects(dailyRetention(), /retention/i);
    assert.deepEqual((await sql`SELECT key FROM stored_files WHERE key IN ${sql([bad, good, absent, live])} ORDER BY key`).map(r => r.key), [bad, live].sort());
    await assert.rejects(stat(path.join(dir, good)), { code: 'ENOENT' });
    assert.ok(await stat(path.join(dir, live)));
    await rm(path.join(dir, bad), { recursive: true });
    assert.equal((await dailyRetention()).deletedFiles, 1);
    assert.equal((await dailyRetention()).deletedFiles, 0);
  } finally {
    await sql`DELETE FROM stored_files WHERE key IN ${sql([bad, good, absent, live])}`;
    config.dataDir = original; await rm(dir, { recursive: true, force: true });
  }
});
test('cache access errors fail the job without preventing the other cache from expiring', async () => {
  const original = config.dataDir, dir = await mkdtemp(path.join(tmpdir(), 'aihot-cache-'));
  config.dataDir = dir;
  try {
    await writeFile(path.join(dir, 'imgcache'), 'not a directory');
    await mkdir(path.join(dir, 'ogcache'));
    const old = path.join(dir, 'ogcache', 'old'), fresh = path.join(dir, 'ogcache', 'fresh');
    await writeFile(old, 'old'); await writeFile(fresh, 'fresh');
    await utimes(old, new Date(0), new Date(0));
    await assert.rejects(dailyRetention(), /retention/i);
    await assert.rejects(stat(old), { code: 'ENOENT' });
    assert.ok(await stat(fresh));
    await rm(path.join(dir, 'imgcache'));
    assert.equal((await dailyRetention()).prunedCache, 0);
  } finally { config.dataDir = original; await rm(dir, { recursive: true, force: true }); }
});
