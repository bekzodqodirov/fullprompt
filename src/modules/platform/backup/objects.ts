import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { attachments, backupObjects } from '../db/schema';
import { getStorage } from '../files/storage';
import { logger } from '../logger';
import { runPooled } from '@/components/pooled';
import {
  accessToken,
  driveConfig,
  driveQuota,
  ensureFolder,
  uploadBuffer,
  type Env,
  type Fetcher,
} from './gdrive';
import { backupS3Client, backupS3Config, uploadBufferToS3 } from './s3';

/**
 * The photographs, the call recordings and every attached document, copied
 * off this machine one object at a time.
 *
 * The database dump has been the whole of «backup» here, and the database is
 * the SMALL half: it grows about half a gigabyte a year while the object
 * store grows by tens (round 74 measured it). Everything a warehouse operator
 * has photographed since this system started lives in one MinIO volume, on
 * the same disk as the database, with no second copy anywhere — so the one
 * failure this whole subsystem exists to survive would take every photograph
 * of every carton with it, and no dump would bring them back.
 *
 * THREE rules shape the design.
 *
 * ONE OBJECT IS UPLOADED ONCE. There are tens of thousands of them and the
 * backlog takes days to drain, so «already done» has to survive restarts and
 * cost nothing to ask — hence a ledger table rather than listing the
 * destination. `backup_objects` is keyed by (key, destination), so pointing
 * the backup somewhere new honestly reads as «nothing is there yet».
 *
 * ORIGINALS ONLY. Thumbnails are derived from the original by
 * `generateThumbnails`, so copying them would roughly double the bytes to buy
 * back something a restore can rebuild. `scripts/restore-objects.ts` says how.
 *
 * THE DUMP OUTRANKS THE PHOTOGRAPHS. A free Google Drive is 15 GB shared with
 * the owner's own Gmail and photographs, and a sync that fills the last
 * gigabyte would push out the one file that carries the money, the clients and
 * the cargo. So a reserve is held back for the database and the photographs
 * stop at it — loudly, because a backup that quietly stopped is the failure
 * this all exists to prevent.
 */

/** Room kept free for the database dump, whatever the photographs want. */
export const DUMP_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;

/** One run's ceiling, so a night's upload cannot run until morning. */
export const MAX_BYTES_PER_RUN = 4 * 1024 * 1024 * 1024;
export const MAX_RUN_MS = 30 * 60 * 1000;

/** How many objects to fetch and upload at a time. */
export const OBJECT_BATCH = 40;
export const OBJECT_CONCURRENCY = 3;

export type ObjectBackupResult =
  | { ok: true; skipped: true; reason: 'not_configured' }
  | {
      ok: true;
      skipped: false;
      where: 'drive' | 's3';
      copied: number;
      bytes: number;
      failed: number;
      remaining: number;
      /** Set when the run stopped for a reason worth telling somebody. */
      stoppedBecause?: 'quota' | 'byte_cap' | 'deadline';
    }
  | { ok: false; error: string };

/**
 * How many bytes this run may upload.
 *
 * Pure, because it is the rule that decides whether the photographs are
 * allowed to crowd out the database — the one arithmetic mistake here that
 * would be discovered by a restore going wrong months later.
 *
 * `free` is null when the destination does not report a quota (an S3 bucket
 * bills instead of refusing), and then only the per-run cap applies.
 */
export function bytesAllowed(free: number | null, reserve: number, cap: number): number {
  if (free === null) return cap;
  const spare = free - reserve;
  return spare <= 0 ? 0 : Math.min(spare, cap);
}

/**
 * A storage key as one flat destination file name.
 *
 * Drive has folders but `drive.file` can only see its own, and one folder of
 * fifty thousand files is a listing nobody wants to page through — so the KEY
 * itself is the name, with its slashes swapped for a character no key can
 * contain (keys are `entityType/uuid/uuid`). Reversible on the way back, which
 * is what makes a restore possible without a manifest to keep in step.
 */
export function objectFileName(storageKey: string): string {
  if (storageKey.includes('~')) throw new Error(`kalitda ~ bor, nomga aylantirib bo‘lmaydi: ${storageKey}`);
  return storageKey.replace(/\//g, '~');
}

/** The inverse — used by the restore script. */
export function storageKeyFromFileName(name: string): string {
  return name.replace(/~/g, '/');
}

/** One destination, whichever it is. */
interface Destination {
  kind: 'drive' | 's3';
  put(key: string, body: Buffer): Promise<{ bytes: number; ref: string }>;
  /** Bytes free, or null when the destination does not answer that question. */
  free(): Promise<number | null>;
  close(): void;
}

async function resolveDestination(env: Env, fetcher: Fetcher): Promise<Destination | null> {
  // S3 wins when both are set, exactly as the dump's dispatcher decides it —
  // one destination, one place to look (see offsite.ts).
  const s3 = backupS3Config(env);
  if (s3) {
    const client = backupS3Client(s3);
    return {
      kind: 's3',
      put: async (key, body) => {
        const objectKey = `${s3.prefix}/objects/${key}`;
        const bytes = await uploadBufferToS3(client, s3, objectKey, body);
        return { bytes, ref: objectKey };
      },
      // A bucket does not refuse for space, it bills — so there is no honest
      // number to return, and pretending there is one would invent a fence.
      free: async () => null,
      close: () => client.destroy(),
    };
  }

  const drive = driveConfig(env);
  if (!drive) return null;
  const token = await accessToken(drive, fetcher);
  const folder = await ensureFolder(token, `${drive.folderName} fayllar`, fetcher);
  return {
    kind: 'drive',
    put: async (key, body) => {
      const file = await uploadBuffer(token, folder, objectFileName(key), body, fetcher);
      return { bytes: file.size, ref: file.id };
    },
    free: async () => {
      const quota = await driveQuota(token, fetcher);
      // limit 0 is Google's way of saying unlimited; treat it as «no fence».
      return quota.limit === 0 ? null : quota.limit - quota.usage;
    },
    close: () => {},
  };
}

/**
 * Objects that have never reached this destination, oldest first.
 *
 * `skip` walks PAST the ones that failed earlier in this run. An attachment
 * row whose object is genuinely gone from storage — a lost upload, a file
 * deleted by hand — fails every time it is tried, and without the offset it
 * sits at the head of the queue for ever and every photograph behind it is
 * never backed up at all. That is the outbox jam of #221 in another costume,
 * and it was found by an integration run against a database that happens to
 * contain exactly that: rows whose bytes are not there.
 */
export async function pendingObjects(
  destination: string,
  limit: number,
  skip = 0,
): Promise<{ storageKey: string; sizeBytes: number }[]> {
  return db
    .select({ storageKey: attachments.storageKey, sizeBytes: attachments.sizeBytes })
    .from(attachments)
    .leftJoin(
      backupObjects,
      and(
        eq(backupObjects.storageKey, attachments.storageKey),
        eq(backupObjects.destination, destination),
      ),
    )
    .where(isNull(backupObjects.storageKey))
    .orderBy(asc(attachments.createdAt))
    .limit(limit)
    .offset(skip);
}

/** How many are still waiting — the number that says whether this is working. */
export async function remainingObjects(destination: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(attachments)
    .leftJoin(
      backupObjects,
      and(
        eq(backupObjects.storageKey, attachments.storageKey),
        eq(backupObjects.destination, destination),
      ),
    )
    .where(isNull(backupObjects.storageKey));
  return row?.n ?? 0;
}

/**
 * Copy what is missing, until the backlog is empty or a limit says stop.
 *
 * Bounded three ways and every one of them is reported: the destination's own
 * free space, a per-run byte cap, and a wall clock. A run that stops early is
 * not a failure — the ledger means tomorrow picks up exactly where this left
 * off — but it must never stop QUIETLY, so the reason travels back to the job.
 */
export async function runObjectBackup(
  env: Env = process.env,
  fetcher: Fetcher = fetch,
  now: () => number = Date.now,
): Promise<ObjectBackupResult> {
  let destination: Destination | null;
  try {
    destination = await resolveDestination(env, fetcher);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
  if (!destination) return { ok: true, skipped: true, reason: 'not_configured' };

  const started = now();
  const storage = getStorage();
  let copied = 0;
  let bytes = 0;
  let failed = 0;
  let stoppedBecause: 'quota' | 'byte_cap' | 'deadline' | undefined;

  try {
    const free = await destination.free();
    const budget = bytesAllowed(free, DUMP_RESERVE_BYTES, MAX_BYTES_PER_RUN);
    if (budget <= 0) {
      return {
        ok: true,
        skipped: false,
        where: destination.kind,
        copied: 0,
        bytes: 0,
        failed: 0,
        remaining: await remainingObjects(destination.kind),
        stoppedBecause: 'quota',
      };
    }

    for (;;) {
      if (now() - started > MAX_RUN_MS) {
        stoppedBecause = 'deadline';
        break;
      }
      if (bytes >= budget) {
        stoppedBecause = free === null ? 'byte_cap' : 'quota';
        break;
      }
      // Skip past everything that has already failed tonight: a success
      // leaves the pending set, a failure does not, so the count of failures
      // is exactly how far the window has to move to see something new.
      const batch = await pendingObjects(destination.kind, OBJECT_BATCH, failed);
      if (batch.length === 0) break;

      await runPooled(batch, OBJECT_CONCURRENCY, async (object) => {
        // Checked inside the pool too: a batch of forty large recordings can
        // cross the budget halfway through, and the reserve is not a target
        // to overshoot by one file.
        if (bytes >= budget) return;
        try {
          const body = await storage.get(object.storageKey);
          const put = await destination!.put(object.storageKey, body);
          if (put.bytes !== body.length) {
            throw new Error(`hajm mos kelmadi: ${body.length} → ${put.bytes}`);
          }
          // Recorded only AFTER the destination confirmed the size. A ledger
          // row written first would mark a photograph safe that is not there.
          await db
            .insert(backupObjects)
            .values({
              storageKey: object.storageKey,
              destination: destination!.kind,
              sizeBytes: put.bytes,
              remoteRef: put.ref,
            })
            .onConflictDoNothing();
          copied += 1;
          bytes += put.bytes;
        } catch (err) {
          // One unreadable object must not end the night for the rest — it is
          // retried tomorrow, because nothing was written to the ledger.
          failed += 1;
          logger.warn({ err, key: object.storageKey }, 'object backup: one file failed');
        }
      });
    }

    return {
      ok: true,
      skipped: false,
      where: destination.kind,
      copied,
      bytes,
      failed,
      remaining: await remainingObjects(destination.kind),
      stoppedBecause,
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  } finally {
    destination.close();
  }
}

/**
 * The dump that went off-site last night, written into the same ledger.
 *
 * A dump IS an object we placed at the destination with a verified size, so
 * it belongs here rather than in a table of its own — and having it here is
 * what lets one query answer the only question the owner actually asks:
 * «when did anything last leave this machine, and how big was it». Keyed
 * under `dump/` so the anti-join that finds unbacked attachments cannot see
 * it, and so the two can never be confused.
 */
export async function recordDumpUpload(input: {
  name: string;
  destination: 'drive' | 's3';
  bytes: number;
  remoteRef: string;
}): Promise<void> {
  await db
    .insert(backupObjects)
    .values({
      storageKey: `dump/${input.name}`,
      destination: input.destination,
      sizeBytes: input.bytes,
      remoteRef: input.remoteRef,
    })
    .onConflictDoUpdate({
      target: [backupObjects.storageKey, backupObjects.destination],
      // A dump with the same name going up again (a re-run, a retry) is the
      // NEWER copy — the row must move with it or the screen keeps showing
      // the first attempt's time for ever.
      set: { sizeBytes: input.bytes, remoteRef: input.remoteRef, uploadedAt: new Date() },
    });
}

export interface BackupStatus {
  lastDump: { name: string; bytes: number; at: Date; destination: string } | null;
  objects: { copied: number; bytes: number; lastAt: Date | null; remaining: number };
  destination: 'drive' | 's3' | null;
}

/**
 * What to put on a screen so somebody can see this is working without
 * reading a log file. The owner is not a developer and «check the logs» is
 * not a monitoring strategy for the one subsystem whose failure is invisible
 * until the day it matters.
 */
export async function backupStatus(env: Env = process.env): Promise<BackupStatus> {
  const destination: 'drive' | 's3' | null = backupS3Config(env)
    ? 's3'
    : driveConfig(env)
      ? 'drive'
      : null;

  const [dump] = await db
    .select()
    .from(backupObjects)
    .where(sql`${backupObjects.storageKey} LIKE 'dump/%'`)
    .orderBy(sql`${backupObjects.uploadedAt} DESC`)
    .limit(1);

  const [totals] = await db
    .select({
      copied: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${backupObjects.sizeBytes}), 0)::bigint`,
      lastAt: sql<Date | null>`max(${backupObjects.uploadedAt})`,
    })
    .from(backupObjects)
    .where(sql`${backupObjects.storageKey} NOT LIKE 'dump/%'`);

  return {
    destination,
    lastDump: dump
      ? {
          name: dump.storageKey.slice('dump/'.length),
          bytes: Number(dump.sizeBytes),
          at: dump.uploadedAt,
          destination: dump.destination,
        }
      : null,
    objects: {
      copied: totals?.copied ?? 0,
      bytes: Number(totals?.bytes ?? 0),
      lastAt: totals?.lastAt ?? null,
      remaining: destination ? await remainingObjects(destination) : 0,
    },
  };
}
