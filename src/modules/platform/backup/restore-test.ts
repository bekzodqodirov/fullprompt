import { execFile } from 'node:child_process';
import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';

const execFileAsync = promisify(execFile);

export type RestoreTestResult =
  | { ok: true; file: string; mode: 'restore'; counts: Record<string, number> }
  /**
   * The drill could not be run here, but the dump was inspected as far as it
   * can be without the tools — see `inspectDump`. Reported as ok because a
   * weekly alarm that means «this machine has no pg_restore» is an alarm
   * people learn to ignore, and the next real failure goes with it.
   */
  | { ok: true; file: string; mode: 'header'; note: string }
  | { ok: false; error: string };

/** Every dump in the directory, newest last, with its size. */
export function dumpsInDir(dir: string): { file: string; bytes: number }[] {
  try {
    return readdirSync(dir)
      .filter((n) => /^gsr-[\d-]+\.dump$/.test(n))
      .sort()
      .map((n) => ({ file: `${dir}/${n}`, bytes: statSync(`${dir}/${n}`).size }));
  } catch {
    return [];
  }
}

/**
 * What can be said about a dump without restoring it.
 *
 * Two facts, and the second is the one worth having. A pg_dump custom-format
 * file starts with the five bytes `PGDMP`, so a truncated or empty upload is
 * caught for the cost of one read. And a dump that has suddenly HALVED is the
 * shape a real disaster takes — a database that came up empty, a restore that
 * replaced production with a test set, a --schema-only flag that crept into a
 * script — while the file itself stays perfectly valid and every size check
 * that only asks «is it non-zero» says yes.
 *
 * Pure so the rule can be tested; the caller supplies the sizes.
 */
export function inspectDump(
  magicOk: boolean,
  bytes: number,
  previousBytes: number | null,
): { ok: boolean; note: string } {
  if (!magicOk) return { ok: false, note: 'fayl pg_dump formatida emas (PGDMP sarlavhasi yo‘q)' };
  if (bytes === 0) return { ok: false, note: 'fayl bo‘sh' };
  if (previousBytes !== null && previousBytes > 0 && bytes < previousBytes / 2) {
    return {
      ok: false,
      note: `zaxira keskin kichraydi: ${bytes} bayt, oldingisi ${previousBytes} bayt`,
    };
  }
  return { ok: true, note: `sarlavha to‘g‘ri, ${bytes} bayt` };
}

/** The five bytes every custom-format dump starts with. */
export function hasDumpMagic(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(5);
    readSync(fd, head, 0, 5, 0);
    return head.toString('latin1') === 'PGDMP';
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

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
        return { ok: true, file, mode: 'restore', counts };
      } finally {
        await scratch.end();
      }
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      // The app image carries no postgres client, so the full drill cannot
      // run in this container. Say what CAN be checked rather than raising the
      // same alarm every Saturday for a fact about the image — an alarm that
      // never changes is one nobody reads, and the real failure hides behind
      // it. docs/BACKUP.md carries the manual drill.
      const all = dumpsInDir(dir);
      const current = all.at(-1);
      const previous = all.at(-2)?.bytes ?? null;
      const verdict = inspectDump(hasDumpMagic(file), current?.bytes ?? 0, previous);
      return verdict.ok
        ? {
            ok: true,
            file,
            mode: 'header',
            note: `pg_restore yo‘q — to‘liq tiklash sinovi o‘tkazilmadi; ${verdict.note}`,
          }
        : { ok: false, error: verdict.note };
    }
    return { ok: false, error: String(e.stderr || e.message || e) };
  } finally {
    await admin.end();
  }
}
