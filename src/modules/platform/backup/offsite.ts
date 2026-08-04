import { statSync } from 'node:fs';
import path from 'node:path';
import {
  accessToken,
  deleteFile,
  driveConfig,
  dumpsToPrune,
  ensureFolder,
  listDumps,
  uploadDump,
  type Env,
  type Fetcher,
} from './gdrive';

export type OffsiteResult =
  | { ok: true; skipped: true; reason: 'not_configured' }
  | { ok: true; skipped: false; fileId: string; name: string; bytes: number; pruned: string[] }
  | { ok: false; error: string };

/**
 * Put last night's dump somewhere the VPS burning down cannot reach.
 *
 * Until now every copy of this company's database lived on one disk: the
 * nightly dump sat in a docker volume on the same machine as the database it
 * was protecting, and `ops/backup.sh` deleted anything older than 30 days.
 * Losing the server lost both. The script's own comment said the dumps were
 * "shipped to object storage" — a design that was never built, and a comment
 * that stopped anybody noticing for months.
 *
 * The size is checked against what Google says it stored, and a mismatch is a
 * FAILURE rather than a warning. A backup nobody has verified the size of is
 * a file; the whole point of this is to be able to say a number.
 */
export async function runOffsiteBackup(
  dumpPath: string,
  fetcher: Fetcher = fetch,
  env: Env = process.env,
): Promise<OffsiteResult> {
  const config = driveConfig(env);
  // Not configured is not a failure: a server without Drive credentials must
  // still take its local dump every night without an error in the log that
  // teaches people to ignore errors.
  if (!config) return { ok: true, skipped: true, reason: 'not_configured' };

  const keep = Number(env.GDRIVE_RETENTION ?? env.BACKUP_RETENTION_DAYS ?? 30);
  try {
    const local = statSync(dumpPath).size;
    if (local === 0) return { ok: false, error: `dump bo‘sh: ${dumpPath}` };

    const token = await accessToken(config, fetcher);
    const folderId = await ensureFolder(token, config.folderName, fetcher);
    const uploaded = await uploadDump(token, folderId, dumpPath, fetcher);

    if (uploaded.size !== local) {
      return {
        ok: false,
        error: `hajm mos kelmadi: diskda ${local} bayt, Drive'da ${uploaded.size} bayt`,
      };
    }

    // Prune only AFTER a verified upload — never delete an old copy on a
    // night when the new one did not land.
    const pruned: string[] = [];
    for (const stale of dumpsToPrune(await listDumps(token, folderId, fetcher), keep)) {
      await deleteFile(token, stale.id, fetcher);
      pruned.push(stale.name);
    }

    return {
      ok: true,
      skipped: false,
      fileId: uploaded.id,
      name: path.basename(dumpPath),
      bytes: uploaded.size,
      pruned,
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}
