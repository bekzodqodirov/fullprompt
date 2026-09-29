import 'dotenv/config';
import { and, eq, gte, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The disk watch through its real store (B9). `statfs` is the one thing
 * replaced: this container's disk is whatever it is, and the rule under test
 * is what the job does at 85 % — told once, per PHYSICAL disk (the package
 * judge's finding 10: two readings of one filesystem must not become two
 * messages per threshold).
 */

const stats = { current: { type: 61267, bsize: 4096, blocks: 1_000_000, bfree: 150_000, bavail: 150_000 } };

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, statfs: async () => ({ ...stats.current, files: 0, ffree: 0 }) };
});

const { db, pgClient } = await import('@/modules/platform/db/client');
const { notifications, systemSignals } = await import('@/modules/platform/db/schema');
const { checkDisks } = await import('@/modules/platform/backup/disk');
const { diskSignals } = await import('@/modules/platform/diagnostics/signals');

const started = new Date();
const env = { BACKUP_DIR: '/tmp/kuzatuv-db', STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: '/tmp/kuzatuv-photos' };
let saved: Awaited<ReturnType<typeof diskSignals>> = [];

beforeAll(async () => {
  saved = await diskSignals();
  await db.delete(systemSignals).where(like(systemSignals.key, 'disk:%'));
});

afterAll(async () => {
  await db
    .delete(notifications)
    .where(and(eq(notifications.type, 'DiskFilling'), gte(notifications.createdAt, started)));
  await db.delete(systemSignals).where(like(systemSignals.key, 'disk:%'));
  for (const s of saved) await db.insert(systemSignals).values({ key: s.key, level: s.level, detail: s.detail });
  await pgClient.end();
});

const alarms = async () =>
  (
    await db
      .select({ id: notifications.id, payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.type, 'DiskFilling'), gte(notifications.createdAt, started)))
  ).map((r) => (r.payload as { text: string }).text);

describe('the disk watch', () => {
  it('85 % on the one disk both directories share: one alarm, one stored step', async () => {
    // (1e6 − 150e3) / 1e6 = 85 %.
    expect(await checkDisks(env)).toBe(1);
    const texts = await alarms();
    expect(texts.length).toBeGreaterThan(0);
    // Every admin got the SAME single message — never one per directory.
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toContain('Server diski (baza, zaxira va rasmlar) 85%');
    const signals = await diskSignals();
    expect(signals.map((s) => [s.key, s.level])).toEqual([['disk:db', 80]]);
  });

  it('the next hour at the same fill says nothing; 91 % says 90 once', async () => {
    const before = (await alarms()).length;
    expect(await checkDisks(env)).toBe(0);
    expect((await alarms()).length).toBe(before);
    stats.current = { ...stats.current, bfree: 90_000, bavail: 90_000 };
    expect(await checkDisks(env)).toBe(1);
    expect((await diskSignals()).find((s) => s.key === 'disk:db')?.level).toBe(90);
  });

  it('a cleanup that brings it well below lowers the step without a word', async () => {
    stats.current = { ...stats.current, bfree: 500_000, bavail: 500_000 };
    expect(await checkDisks(env)).toBe(0);
    expect((await diskSignals()).filter((s) => s.key.startsWith('disk:'))).toEqual([]);
  });
});
