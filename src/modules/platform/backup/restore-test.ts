import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';

const execFileAsync = promisify(execFile);

export type RestoreTestResult =
  | { ok: true; file: string; counts: Record<string, number> }
  | { ok: false; error: string };

// A restore that "succeeds" but loses the core tables is still a failure —
// these must all exist and users must be non-empty in any real dump.
const SANITY_TABLES = ['users', 'warehouses', 'clients', 'receipts', 'boxes', 'batches'];

const SCRATCH_DB = 'gsr_restore_test';

function urlForDb(base: string, dbName: string): string {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Weekly backup fire drill (spec §16 / PLAN M6): restore the LATEST dump into
 * a scratch database, verify the core tables came back with rows, drop the
 * scratch. A backup nobody ever restored is not a backup.
 */
export async function runRestoreTest(): Promise<RestoreTestResult> {
  const dir = path.resolve(process.env.BACKUP_DIR ?? '.data/backups');
  const baseUrl = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev';

  let latest: string | null = null;
  try {
    // BOTH naming schemes: the app writes gsr-YYYY-MM-DD.dump and the
    // independent compose container writes gsr-YYYYMMDD-HHMMSS.dump. They now
    // share a volume, and this used to match only the first — so on the VPS,
    // where the compose container is the one that actually runs, the weekly
    // fire drill found nothing to restore and reported a missing backup while
    // dumps were sitting right there.
    const dumps = readdirSync(dir)
      .filter((n) => /^gsr-[\d-]+\.dump$/.test(n))
      .sort();
    latest = dumps.at(-1) ?? null;
  } catch {
    latest = null;
  }
  if (!latest) return { ok: false, error: `backup topilmadi: ${dir}` };
  const file = path.join(dir, latest);

  // Admin connection on the always-present 'postgres' db for create/drop.
  const admin = postgres(urlForDb(baseUrl, 'postgres'), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);

    try {
      await execFileAsync('pg_restore', [
        '--no-owner',
        '--exit-on-error',
        '-d',
        urlForDb(baseUrl, SCRATCH_DB),
        file,
      ]);

      const scratch = postgres(urlForDb(baseUrl, SCRATCH_DB), { max: 1, onnotice: () => {} });
      try {
        const counts: Record<string, number> = {};
        for (const table of SANITY_TABLES) {
          const [row] = await scratch.unsafe(`SELECT count(*) AS n FROM "${table}"`);
          counts[table] = Number(row?.n ?? 0);
        }
        if (counts.users === 0) {
          return { ok: false, error: `restore bo‘ldi, lekin users jadvali bo‘sh (${latest})` };
        }
        return { ok: true, file, counts };
      } finally {
        await scratch.end();
      }
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    return {
      ok: false,
      error:
        e.code === 'ENOENT'
          ? 'pg_restore topilmadi — PostgreSQL bin papkasini PATH ga qo‘shing'
          : String(e.stderr || e.message || e),
    };
  } finally {
    await admin.end();
  }
}
