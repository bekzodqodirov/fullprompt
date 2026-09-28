import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { notifyStaffTelegram } from '../notifications/staff';
import { usersWithRoles } from '../notifications/service';
import { diskLevels, setDiskLevel, type DiskSignalKey } from '../diagnostics/signals';

/**
 * How full the server's disks are, and a word before they are full (B9).
 *
 * Round 74 measured why this matters more than anything else on the box: the
 * database grows half a gigabyte a year, photographs and call recordings tens,
 * and while they share one disk a FULL disk stops postgres AND the backup that
 * would recover it in the same minute. Nothing said how full it was — the
 * first sign would have been the app stopping.
 *
 * Two readings, both `statfs` of a directory this container can see:
 *  - «Baza + zaxira»: BACKUP_DIR — the `backups` named volume, on the same
 *    Docker root as `pgdata`, so its filesystem IS the database's;
 *  - «Rasmlar»: `miniodata` mounted READ-ONLY into the app (compose), or the
 *    local storage root when there is no MinIO. A named volume, never a bind
 *    to a path: a missing path refuses to start the container (#472), a named
 *    volume always exists — and after the «Disk» move in docs/DEPLOY.md the
 *    same name points at the second disk, so the reading follows it.
 * The package judge's simpler road, taken: no MinIO metrics endpoint, no JWT
 * minted from the S3 keys, nothing whose authentication cannot be tested here.
 *
 * Two readings of ONE filesystem are one disk — same size, same type — and are
 * reported, and ALARMED, once (the judge's finding: a screen that merges them
 * and a job that does not sends two messages per threshold).
 *
 * Any failure reads «noma'lum», never 0 %: a disk we could not read is not an
 * empty disk.
 */

export interface DiskReading {
  totalBytes: number;
  freeBytes: number;
  /** Used share as `df` prints it: used ÷ (used + available to non-root). */
  usedPct: number;
  /** The filesystem's magic number — half of «is this the same disk». */
  fsType: number;
}

export type DiskLineKey = 'one' | 'db' | 'photos';

export interface DiskLine {
  key: DiskLineKey;
  reading: DiskReading | null;
}

/** A statfs that has not answered in this long is «noma'lum». */
export const DISK_READ_MS = 3_000;

/** The three settings that say where to look (a test passes its own). */
export type DiskEnv = Record<string, string | undefined>;

/** Where to look. Null = nothing mounted to look at (reads «noma'lum»). */
export function diskPaths(env: DiskEnv = process.env): { db: string; photos: string | null } {
  const db = path.resolve(env.BACKUP_DIR ?? '.data/backups');
  const photos =
    (env.STORAGE_DRIVER ?? 'local') === 's3'
      ? env.MINIO_DATA_DIR
        ? path.resolve(env.MINIO_DATA_DIR)
        : null
      : path.resolve(env.STORAGE_LOCAL_DIR ?? '.data/files');
  return { db, photos };
}

/** `df`'s arithmetic, from the raw block counts. */
export function readingFrom(stats: {
  type: number;
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}): DiskReading | null {
  const used = (stats.blocks - stats.bfree) * stats.bsize;
  const avail = stats.bavail * stats.bsize;
  if (!(used + avail > 0)) return null;
  return {
    totalBytes: stats.blocks * stats.bsize,
    freeBytes: avail,
    usedPct: Math.round((used / (used + avail)) * 100),
    fsType: stats.type,
  };
}

/** Same size and same kind of filesystem: one physical disk seen twice. */
export function sameDisk(a: DiskReading, b: DiskReading): boolean {
  return a.totalBytes === b.totalBytes && a.fsType === b.fsType;
}

/**
 * statfs of the nearest directory that exists — on a fresh machine the backup
 * directory may not exist yet, and its parent sits on the same filesystem.
 */
async function readDisk(target: string | null): Promise<DiskReading | null> {
  if (!target) return null;
  let at = target;
  for (let i = 0; i < 20; i += 1) {
    try {
      const stats = await Promise.race([
        statfs(at),
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new Error('statfs timeout')), DISK_READ_MS);
          t.unref?.();
        }),
      ]);
      return readingFrom(stats);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
  return null;
}

/** The lines to print, and to judge: one per physical disk. */
export function mergeDisks(db: DiskReading | null, photos: DiskReading | null): DiskLine[] {
  if (db && photos && sameDisk(db, photos)) return [{ key: 'one', reading: db }];
  return [
    { key: 'db', reading: db },
    { key: 'photos', reading: photos },
  ];
}

export async function diskLines(env: DiskEnv = process.env): Promise<DiskLine[]> {
  const where = diskPaths(env);
  const [db, photos] = await Promise.all([readDisk(where.db), readDisk(where.photos)]);
  return mergeDisks(db, photos);
}

/**
 * The alarm's step, with a floor under it. Up is told the moment it happens
 * (80, then 90); down only once the disk is five points below the step it is
 * on — a disk hovering at 79-81 % after a night's backup must not ring every
 * hour. A fall is never announced: it is somebody's cleanup working.
 */
export function nextDiskLevel(prev: number, pct: number): { level: number; alert: boolean } {
  const target = pct >= 90 ? 90 : pct >= 80 ? 80 : 0;
  if (target > prev) return { level: target, alert: true };
  if (target === prev) return { level: prev, alert: false };
  return pct < prev - 5 ? { level: target, alert: false } : { level: prev, alert: false };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

const DISK_WORDS: Record<DiskLineKey, string> = {
  one: 'Server diski (baza, zaxira va rasmlar)',
  db: 'Baza va zaxira diski',
  photos: 'Rasmlar diski',
};

/** The Telegram sentence — pre-rendered Uzbek, like `silentTruckText`. */
export function diskAlarmText(key: DiskLineKey, reading: DiskReading): string {
  return (
    `💾 ${DISK_WORDS[key]} ${reading.usedPct}% to'ldi (bo'sh ${formatBytes(reading.freeBytes)}).\n` +
    `Disk to'lsa baza to'xtaydi va zaxira ham olinmaydi — joy bo'shating yoki rasmlarni alohida diskka ko'chiring.\n` +
    `Qo'llanma: docs/DEPLOY.md, «Disk» bo'limi.`
  );
}

function signalKey(key: DiskLineKey): DiskSignalKey {
  return key === 'photos' ? 'disk:photos' : 'disk:db';
}

/**
 * The hourly check. Levels live in `system_signals`, so a restart forgets
 * nothing and the home screen reads the same row the alarm wrote. A reading
 * that failed leaves its level alone — «we could not look» is not «it
 * emptied».
 */
export async function checkDisks(env: DiskEnv = process.env): Promise<number> {
  const lines = await diskLines(env);
  const levels = await diskLevels();
  let alerted = 0;
  if (lines.length === 1 && levels.has('disk:photos')) await setDiskLevel('disk:photos', 0, null);
  for (const line of lines) {
    if (!line.reading) continue;
    const key = signalKey(line.key);
    const prev = levels.get(key) ?? 0;
    const { level, alert } = nextDiskLevel(prev, line.reading.usedPct);
    if (level > 0 || prev > 0) {
      await setDiskLevel(key, level, `${line.key}:${line.reading.usedPct}:${line.reading.freeBytes}`);
    }
    if (alert) {
      const admins = await usersWithRoles(['admin', 'super_admin']);
      await notifyStaffTelegram({ userIds: admins, type: 'DiskFilling', text: diskAlarmText(line.key, line.reading) });
      alerted += 1;
    }
  }
  return alerted;
}

/** The stored detail «one:82:15032385536» back into what the home prints. */
export function parseDiskDetail(detail: string | null): { key: DiskLineKey; usedPct: number; freeBytes: number } | null {
  const [key, pct, free] = (detail ?? '').split(':');
  if (key !== 'one' && key !== 'db' && key !== 'photos') return null;
  const usedPct = Number(pct);
  const freeBytes = Number(free);
  if (!Number.isFinite(usedPct) || !Number.isFinite(freeBytes)) return null;
  return { key, usedPct, freeBytes };
}
