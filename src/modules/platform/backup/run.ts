import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type BackupResult =
  | { ok: true; file: string; bytes: number; pruned: string[] }
  | { ok: false; error: string };

/**
 * Compressed pg_dump to BACKUP_DIR (default .data/backups), pruning dumps
 * older than BACKUP_RETENTION_DAYS (default 30). Owner's answer: local disk
 * for now, off-site revisited later. Restore:
 *   pg_restore -d gsr_dev --clean --if-exists .data/backups/gsr-YYYY-MM-DD.dump
 * Needs pg_dump on PATH (ships with the PostgreSQL install).
 */
export async function runBackup(): Promise<BackupResult> {
  const dir = path.resolve(process.env.BACKUP_DIR ?? '.data/backups');
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 30);
  const url = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev';
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `gsr-${stamp}.dump`);

  mkdirSync(dir, { recursive: true });
  try {
    // -Fc = compressed custom format, restorable table-by-table.
    await execFileAsync('pg_dump', ['-Fc', '--no-owner', '-f', file, url]);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    return {
      ok: false,
      error:
        e.code === 'ENOENT'
          ? 'pg_dump topilmadi — PostgreSQL bin papkasini PATH ga qo‘shing'
          : String(e.stderr || e.message || e),
    };
  }

  const pruned: string[] = [];
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  for (const name of readdirSync(dir)) {
    if (!/^gsr-\d{4}-\d{2}-\d{2}\.dump$/.test(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).mtimeMs < cutoff) {
      unlinkSync(full);
      pruned.push(name);
    }
  }
  return { ok: true, file, bytes: statSync(file).size, pruned };
}
