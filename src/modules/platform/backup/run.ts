import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type BackupResult =
  | { ok: true; file: string; bytes: number; pruned: string[]; source: DumpSource }
  | { ok: false; error: string };

/**
 * Where tonight's dump came from.
 *
 * `own` is this process running pg_dump itself. `compose` is the separate
 * postgres:16 container in docker-compose taking it instead — see
 * `adoptRecentDump` for why that fallback is the thing that makes off-site
 * backup work at all on the live server.
 */
export type DumpSource = 'own' | 'compose';

/** Both naming schemes: the app writes gsr-YYYY-MM-DD, ops/backup.sh writes
 *  gsr-YYYYMMDD-HHMMSS. They share a volume, so both land in one directory. */
const DUMP_NAME = /^gsr-[\d-]+\.dump$/;

/** How old a dump taken by somebody else may be and still be tonight's. */
const ADOPT_MAX_AGE_MS = 26 * 3600 * 1000;

/**
 * Compressed pg_dump to BACKUP_DIR (default .data/backups), pruning dumps
 * older than BACKUP_RETENTION_DAYS (default 30). Restore:
 *   pg_restore -d gsr_dev --clean --if-exists .data/backups/gsr-YYYY-MM-DD.dump
 *
 * WHY THIS CAN FINISH WITHOUT pg_dump, which looks like a strange thing for a
 * function called runBackup to allow. The app image is `node:22-slim` and
 * installs no postgres client, so on the live server this shelled out to a
 * binary that is not there and returned ENOENT — every night, silently, and
 * the caller stops on a failure, which means `runOffsiteBackup` was never
 * reached and NOT ONE dump has ever left the machine. Meanwhile the compose
 * `backup` service — a postgres:16 container, which does have the tools — has
 * been writing a good dump to the very same volume all along.
 *
 * So a missing binary is no longer the end of the night: if a dump written in
 * the last 26 hours is sitting there, that one is adopted and shipped. The
 * result says which happened, because "the copy is up to a day old" and "the
 * copy is minutes old" are different facts and the log must not blur them.
 * Only when there is neither a working pg_dump nor a recent dump is this a
 * failure — which is the honest definition: there is nothing to send.
 */
export async function runBackup(): Promise<BackupResult> {
  const dir = path.resolve(process.env.BACKUP_DIR ?? '.data/backups');
  const url = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev';
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `gsr-${stamp}.dump`);

  mkdirSync(dir, { recursive: true });
  try {
    // -Fc = compressed custom format, restorable table-by-table.
    await execFileAsync('pg_dump', ['-Fc', '--no-owner', '-f', file, url]);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const why =
      e.code === 'ENOENT'
        ? 'pg_dump topilmadi (bu konteynerda postgres client yo‘q)'
        : String(e.stderr || e.message || e);

    const adopted = adoptRecentDump(dir);
    if (!adopted) {
      return {
        ok: false,
        error: `${why} — va ${dir} ichida so‘nggi 26 soatda olingan zaxira ham yo‘q`,
      };
    }
    return { ok: true, file: adopted.file, bytes: adopted.bytes, pruned: [], source: 'compose' };
  }

  const bytes = statSync(file).size;
  // A pg_dump that "succeeded" and produced nothing is not a backup, and
  // shipping it would overwrite nothing but would report a number that reads
  // like success. The offsite half checks its own size too; this one is here
  // so a local-only server is not lied to either.
  if (bytes === 0) return { ok: false, error: `pg_dump bo‘sh fayl yozdi: ${file}` };

  return { ok: true, file, bytes, pruned: pruneOldDumps(dir), source: 'own' };
}

/**
 * The freshest usable dump somebody else has already taken, or null.
 *
 * Deliberately reads the FILE and not a manifest: the compose container writes
 * nothing but the dump, and a second file to keep in step is a second thing
 * that can disagree with reality.
 */
export function adoptRecentDump(
  dir: string,
  now: number = Date.now(),
): { file: string; bytes: number; ageMs: number } | null {
  let best: { file: string; bytes: number; ageMs: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!DUMP_NAME.test(name)) continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.size === 0) continue;
    const ageMs = now - stat.mtimeMs;
    if (ageMs > ADOPT_MAX_AGE_MS || ageMs < 0) continue;
    if (!best || ageMs < best.ageMs) best = { file: full, bytes: stat.size, ageMs };
  }
  return best;
}

/** Drop local dumps past the retention window. Returns what went. */
function pruneOldDumps(dir: string): string[] {
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
  const pruned: string[] = [];
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  for (const name of readdirSync(dir)) {
    // Only the app's OWN naming scheme: the compose container prunes its own
    // dumps on its own schedule, and two pruners over one directory is how a
    // retention window quietly becomes the shorter of the two.
    if (!/^gsr-\d{4}-\d{2}-\d{2}\.dump$/.test(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).mtimeMs < cutoff) {
      unlinkSync(full);
      pruned.push(name);
    }
  }
  return pruned;
}
