import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, backupObjects } from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import {
  DUMP_RESERVE_BYTES,
  objectFileName,
  remainingObjects,
  runObjectBackup,
} from '@/modules/platform/backup/objects';

/**
 * The photographs actually leaving the machine — the whole path, with a Drive
 * that exists only in this file.
 *
 * What matters here is not that an upload happens; it is that an object is
 * uploaded ONCE, that the ledger row is written only after the destination
 * confirmed the size, and that the reserve kept for the database dump really
 * does stop the photographs rather than merely being subtracted somewhere.
 */

const ENV: Record<string, string | undefined> = {
  GDRIVE_CLIENT_ID: 'id',
  GDRIVE_CLIENT_SECRET: 'secret',
  GDRIVE_REFRESH_TOKEN: 'refresh',
  GDRIVE_FOLDER_NAME: 'ZZ test backup',
};

const SUFFIX = randomUUID().slice(0, 8);
const KEY_PREFIX = `zztest/${SUFFIX}`;
let actorId: string;
const keys: string[] = [];

/** A Drive that stores what it is given, and can claim to be nearly full. */
function fakeDrive(opts: { freeBytes?: number; storedSize?: (sent: number) => number } = {}) {
  const stored = new Map<string, number>();
  const uploaded: string[] = [];
  let nextId = 1;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }), { status: 200 });
    }
    if (url.includes('/drive/v3/about')) {
      const limit = 15 * 1024 * 1024 * 1024;
      const free = opts.freeBytes ?? limit;
      return new Response(
        JSON.stringify({ storageQuota: { limit: String(limit), usage: String(limit - free) } }),
        { status: 200 },
      );
    }
    // The folder is looked up by MIME type, then created if it is not there.
    if (url.includes('/drive/v3/files?q=') && decodeURIComponent(url).includes('apps.folder')) {
      return new Response(JSON.stringify({ files: [{ id: 'folder-1' }] }), { status: 200 });
    }
    if (url.includes('/upload/drive/v3/files') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name: string };
      const sent = Number(init?.headers ? (init.headers as Record<string, string>)['x-upload-content-length'] : 0);
      const id = `file-${nextId++}`;
      stored.set(id, opts.storedSize ? opts.storedSize(sent) : sent);
      uploaded.push(body.name);
      return new Response(null, {
        status: 200,
        headers: { location: `https://upload.test/session/${id}?name=${encodeURIComponent(body.name)}` },
      });
    }
    if (url.startsWith('https://upload.test/session/') && method === 'PUT') {
      const id = url.split('/session/')[1]!.split('?')[0]!;
      const name = decodeURIComponent(url.split('name=')[1] ?? '');
      return new Response(
        JSON.stringify({ id, name, size: String(stored.get(id) ?? 0), createdTime: '2026-08-16T00:00:00Z' }),
        { status: 200 },
      );
    }
    return new Response('unexpected ' + method + ' ' + url, { status: 500 });
  }) as typeof fetch;
  return { fetcher, stored, uploaded };
}

beforeAll(async () => {
  const who = await db.query.users.findFirst();
  if (!who) throw new Error('the suite needs at least one user');
  actorId = who.id;

  const storage = getStorage();
  for (let i = 0; i < 3; i += 1) {
    const key = `${KEY_PREFIX}/${randomUUID()}`;
    const body = Buffer.alloc(1024 * (i + 1), i + 1);
    await storage.put(key, body, 'image/jpeg');
    await db.insert(attachments).values({
      entityType: 'receipt',
      entityId: randomUUID(),
      kind: 'photo',
      storageKey: key,
      fileName: `zz-${i}.jpg`,
      contentType: 'image/jpeg',
      sizeBytes: body.length,
      uploadedBy: actorId,
    });
    keys.push(key);
  }
});

afterAll(async () => {
  // Both tables, or the next run of this file finds its own leftovers already
  // "backed up" and proves nothing (#183).
  await db.delete(backupObjects).where(inArray(backupObjects.storageKey, keys));
  await db.delete(attachments).where(like(attachments.storageKey, `${KEY_PREFIX}%`));
  const storage = getStorage();
  for (const key of keys) await storage.delete(key).catch(() => {});
  await pgClient.end();
});

describe('the object backup', () => {
  it('copies what is missing and records only what the destination confirmed', async () => {
    // Asserted against the LEDGER, not against a page of the pending list:
    // this database holds a hundred e2e leftovers older than these three, so
    // «is mine in the first hundred waiting» is a question about strangers
    // (#713). What is true of my own rows is that nothing has copied them.
    const before = await db
      .select()
      .from(backupObjects)
      .where(inArray(backupObjects.storageKey, keys));
    expect(before).toHaveLength(0);

    const { fetcher } = fakeDrive();
    const result = await runObjectBackup(ENV, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok || result.skipped) throw new Error('expected a real run');
    expect(result.where).toBe('drive');
    // `result.failed` is deliberately NOT asserted to be zero: this database
    // carries a hundred e2e leftovers whose bytes were never written, and
    // they fail every run. That they do not STOP the run is the point, and
    // the last test in this file is the one that proves it.

    const rows = await db
      .select()
      .from(backupObjects)
      .where(inArray(backupObjects.storageKey, keys));
    expect(rows).toHaveLength(3);
    // The size stored is the DESTINATION's number, and it must match the file.
    for (const row of rows) {
      expect(row.destination).toBe('drive');
      expect(row.remoteRef).toMatch(/^file-\d+$/);
      const source = await db.query.attachments.findFirst({
        where: eq(attachments.storageKey, row.storageKey),
      });
      expect(row.sizeBytes).toBe(source!.sizeBytes);
    }
  });

  it('never uploads the same object twice', async () => {
    const { fetcher, uploaded } = fakeDrive();
    const result = await runObjectBackup(ENV, fetcher);
    if (!result.ok || result.skipped) throw new Error('expected a real run');
    // Whatever else is in this database, none of THESE three moved again.
    const mineAgain = uploaded.filter((name) => keys.some((k) => name === objectFileName(k)));
    expect(mineAgain, mineAgain.join(' ')).toEqual([]);
    const mine = await db
      .select()
      .from(backupObjects)
      .where(inArray(backupObjects.storageKey, keys));
    expect(mine).toHaveLength(3);
  });

  it('a destination that lies about the size it stored is a failure, not a ledger row', async () => {
    // The size check is the whole of "verified" — a truncated upload leaves an
    // object with the right name and the wrong contents, which is worse than
    // no object at all, because the name is what anybody looks for.
    await db.delete(backupObjects).where(inArray(backupObjects.storageKey, keys));
    const { fetcher } = fakeDrive({ storedSize: (sent) => Math.max(0, sent - 1) });
    const result = await runObjectBackup(ENV, fetcher);
    if (!result.ok || result.skipped) throw new Error('expected a real run');
    expect(result.copied).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    const rows = await db
      .select()
      .from(backupObjects)
      .where(inArray(backupObjects.storageKey, keys));
    expect(rows, 'nothing recorded for an unverified upload').toHaveLength(0);
  });

  it('stops at the reserve kept for the database dump, and says so', async () => {
    const { fetcher, uploaded } = fakeDrive({ freeBytes: DUMP_RESERVE_BYTES });
    const result = await runObjectBackup(ENV, fetcher);
    if (!result.ok || result.skipped) throw new Error('expected a real run');
    expect(result.stoppedBecause).toBe('quota');
    expect(result.copied).toBe(0);
    expect(uploaded, 'not one photograph went up').toEqual([]);
    expect(result.remaining).toBeGreaterThan(0);
  });

  it('says "not configured" rather than failing when no destination is set', async () => {
    const result = await runObjectBackup({}, fakeDrive().fetcher);
    expect(result).toEqual({ ok: true, skipped: true, reason: 'not_configured' });
  });

  it('the backlog is a number somebody can watch', async () => {
    expect(await remainingObjects('drive')).toBeGreaterThanOrEqual(0);
  });

  it('an object whose bytes are gone does not block the ones behind it', async () => {
    // The failure mode this whole offset exists for: a row pointing at a file
    // that is not in storage fails every night, and with the window standing
    // still every photograph created after it is never backed up at all.
    await db.delete(backupObjects).where(inArray(backupObjects.storageKey, keys));
    const ghost = `${KEY_PREFIX}/ghost-${randomUUID()}`;
    await db.insert(attachments).values({
      entityType: 'receipt',
      entityId: randomUUID(),
      kind: 'photo',
      // created_at older than the three real ones, so it sits in FRONT of them
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      storageKey: ghost,
      fileName: 'ghost.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 10,
      uploadedBy: actorId,
    });
    keys.push(ghost);

    const { fetcher } = fakeDrive();
    const result = await runObjectBackup(ENV, fetcher);
    if (!result.ok || result.skipped) throw new Error('expected a real run');

    const rows = await db
      .select()
      .from(backupObjects)
      .where(inArray(backupObjects.storageKey, keys));
    // The three real photographs are safe; the ghost is not, and never claims
    // to be — a ledger row for a file that does not exist is the one lie a
    // backup must never tell.
    expect(rows.map((r) => r.storageKey).sort()).toEqual(keys.filter((k) => k !== ghost).sort());
  });
});
