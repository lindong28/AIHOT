// Daily housekeeping: expired leases, old run history, files past their life and derived caches.
import { readdir, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { discardExpiredSignals } from "../content/retention.ts";

/** Derived caches (proxied images, share cards and posters) are rebuilt on demand; drop ones older than a month. */
async function pruneCache(dir: string, maxAgeMs: number, now: number, errors: Error[]): Promise<number> {
  let removed = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') errors.push(new Error(`cache directory: ${e.code ?? 'read failed'}`));
      return [];
    });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      try {
        const info = await lstat(p);
        if (now - info.mtimeMs > maxAgeMs) { await unlink(p); removed += 1; }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') errors.push(new Error(`cache file: ${code ?? 'remove failed'}`));
      }
    }
  };
  await walk(dir);
  return removed;
}

export async function dailyRetention(now = new Date()) {
  const errors: Error[] = [];
  const phase = async (name: string, work: () => Promise<number>): Promise<number> => {
    try { return await work(); }
    catch { errors.push(new Error(`${name} failed`)); return 0; }
  };
  const discardedSignals = await phase('signals', discardExpiredSignals);
  const deletedLeases = await phase('leases', async () => (await sql`DELETE FROM delivery_leases WHERE expires_at < ${now}`).count);
  // Scheduled-task history: 30 days (failures 90) is enough for the runs view.
  const deletedJobRuns = await phase('job history', async () => (await sql`DELETE FROM job_runs WHERE started_at < ${new Date(now.getTime() - 30 * 86400_000)} AND (status IS DISTINCT FROM 'failed' OR started_at < ${new Date(now.getTime() - 90 * 86400_000)})`).count);
  // Raw files with a bounded life.
  const deletedFiles = await phase('stored files', async () => {
    const files = await sql<{ key: string }[]>`SELECT key FROM stored_files WHERE expires_at < ${now}`;
    let removed = 0;
    // One file transaction at a time bounds locks and I/O on the worker's shared data disk.
    for (const f of files) removed += await phase('stored file', async () => sql.begin(async tx => {
      const [due] = await tx`SELECT key FROM stored_files WHERE key=${f.key} AND expires_at < ${now} FOR UPDATE`;
      if (!due) return 0;
      const file = path.resolve(config.dataDir, f.key);
      if (!file.startsWith(path.resolve(config.dataDir) + path.sep)) throw new Error('stored file outside data directory');
      try { await unlink(file); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      await tx`DELETE FROM stored_files WHERE key=${f.key}`;
      return 1;
    }) as Promise<number>);
    return removed;
  });
  const monthMs = 30 * 86400_000;
  const prunedCache = (await pruneCache(path.join(config.dataDir, "imgcache"), monthMs, now.getTime(), errors)) + (await pruneCache(path.join(config.dataDir, "ogcache"), monthMs, now.getTime(), errors));
  const summary = { deletedLeases, deletedJobRuns, deletedFiles, prunedCache, discardedSignals };
  if (errors.length) throw new AggregateError(errors, `retention incomplete: ${errors.length} failure(s); ${JSON.stringify(summary)}; ${errors.map(e => e.message).join('; ')}`);
  return summary;
}
