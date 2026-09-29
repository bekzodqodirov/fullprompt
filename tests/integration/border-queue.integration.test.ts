import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { auditLog, borderQueue, users } from '@/modules/platform/db/schema';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import {
  BORDER_QUEUE_WARN_DAYS,
  BorderQueueError,
  borderQueueRows,
  clearBorderWait,
  loadBorderHours,
  setBorderWait,
} from '@/modules/wms/tracking/border-queue';

/**
 * «Chegara navbatlari» written and read (the Horgos round, migration 0118).
 *
 * The table is CONFIGURATION in the strongest sense: a leftover typed wait
 * changes every Horgos date every later test and spec computes (#183). So
 * the rows are snapshotted before anything is touched, the table is emptied
 * for the file, and afterAll puts the snapshot back EXACTLY — same ids, same
 * `updated_at`, same `updated_by` — because «no row» and «a reset row» read
 * alike to the dates but not to the audit history. The fixture people are
 * deactivated at the end, never deleted: the audit rows name them and
 * audit_log refuses DELETE.
 */

const SUFFIX = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
const META = { ip: null, userAgent: 'border-queue.integration' };

let snapshot: (typeof borderQueue.$inferSelect)[] = [];
const made: string[] = [];
let logist = { id: '', permissions: new Set<string>(['plans.manage']), warehouseScoped: false };
let seller = { id: '', permissions: new Set<string>(['crm.leads']), warehouseScoped: false };
let scopedPlanner = { id: '', permissions: new Set<string>(['plans.manage']), warehouseScoped: true };

async function mint(label: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ phone: `+99895${SUFFIX}${made.length}`, fullName: `Chegara ${label} ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  made.push(row!.id);
  return row!.id;
}

const rowOf = async (post: string) => (await db.select().from(borderQueue).where(eq(borderQueue.post, post)))[0];
const seenOf = async (post: string) => (await rowOf(post))?.updatedAt.toISOString() ?? null;
const codeOf = async (press: Promise<unknown>) => {
  try {
    await press;
    return null;
  } catch (err) {
    if (err instanceof BorderQueueError) return err.code;
    throw err;
  }
};
const save = (actor: typeof logist, over: Partial<Parameters<typeof setBorderWait>[1]> = {}) =>
  setBorderWait(actor, { post: 'khorgos', minDays: '3', maxDays: '4', note: '', seenAt: null, ...over }, META);

beforeAll(async () => {
  snapshot = await db.select().from(borderQueue);
  logist = { ...logist, id: await mint('logist') };
  seller = { ...seller, id: await mint('seller') };
  scopedPlanner = { ...scopedPlanner, id: await mint('scoped') };
});

beforeEach(async () => {
  await db.delete(borderQueue);
});

afterAll(async () => {
  await db.delete(borderQueue);
  if (snapshot.length) await db.insert(borderQueue).values(snapshot);
  if (made.length) await db.update(users).set({ active: false }).where(inArray(users.id, made));
  await pgClient.end();
});

describe('setBorderWait — the door and the numbers', () => {
  it('the logist types «3,5»–«4» days: 84–96 hours, a row, an audit line, and the dates read it', async () => {
    await save(logist, { minDays: '3,5', maxDays: ' 4 ', note: '  Qor yog‘yapti  ' });
    const row = (await rowOf('khorgos'))!;
    expect(row).toMatchObject({ minHours: 84, maxHours: 96, note: 'Qor yog‘yapti', updatedBy: logist.id });
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'border_queue'), eq(auditLog.entityId, row.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(logist.id);
    expect(audit[0]!.after).toMatchObject({ post: 'khorgos', minHours: 84, maxHours: 96 });
    const hours = await loadBorderHours();
    expect(hours.khorgos).toEqual({ hours: [84, 96], sinceMs: row.updatedAt.getTime() });
    expect(hours.yallama).toBeUndefined();
  });

  it('a seller is refused by the SERVICE, not only by the screen (#531)', async () => {
    expect(await codeOf(save(seller))).toBe('forbidden');
    expect(await rowOf('khorgos')).toBeUndefined();
  });

  it('a warehouse-scoped holder of plans.manage is refused: a border belongs to no warehouse', async () => {
    expect(await codeOf(save(scopedPlanner))).toBe('scoped_actor');
    expect(await rowOf('khorgos')).toBeUndefined();
  });

  it('refuses what is not a number, not a range, not a post, or too long — and writes nothing', async () => {
    expect(await codeOf(save(logist, { minDays: 'abc' }))).toBe('bad_number');
    expect(await codeOf(save(logist, { maxDays: '1 000' }))).toBe('bad_number');
    expect(await codeOf(save(logist, { minDays: '-1' }))).toBe('bad_number');
    expect(await codeOf(save(logist, { minDays: '' }))).toBe('bad_number');
    expect(await codeOf(save(logist, { minDays: '5', maxDays: '2' }))).toBe('bad_range');
    expect(await codeOf(save(logist, { maxDays: '31' }))).toBe('bad_range');
    expect(await codeOf(save(logist, { note: 'x'.repeat(301) }))).toBe('note_too_long');
    expect(await codeOf(save(logist, { post: 'irkeshtam' }))).toBe('unknown_post');
    expect(await db.select().from(borderQueue)).toHaveLength(0);
    // The edges are allowed: «0–0» (the queue is gone) and the 30-day cap.
    await save(logist, { minDays: '0', maxDays: '0' });
    await save(logist, { post: 'yallama', minDays: '30', maxDays: '30' });
    expect((await rowOf('khorgos'))!.maxHours).toBe(0);
    expect((await rowOf('yallama'))!.maxHours).toBe(720);
  });

  it('a colleague’s number typed in between is refused, never overwritten in silence', async () => {
    await save(logist);
    // The screen still shows «no row»: its seenAt is null.
    expect(await codeOf(save(logist, { minDays: '1', maxDays: '2', seenAt: null }))).toBe('changed');
    expect((await rowOf('khorgos'))!.minHours).toBe(72);
    // With what the screen actually saw, it goes through.
    await save(logist, { minDays: '1', maxDays: '2', seenAt: await seenOf('khorgos') });
    expect((await rowOf('khorgos'))!.minHours).toBe(24);
  });
});

describe('clearBorderWait — «Odatdagi jadvalga qaytarish»', () => {
  it('NULLs the hours and the note, keeps the row id, and the dates fall back to his defaults', async () => {
    await save(logist, { note: 'navbat' });
    const before = (await rowOf('khorgos'))!;
    await clearBorderWait(logist, { post: 'khorgos', seenAt: before.updatedAt.toISOString() }, META);
    const after = (await rowOf('khorgos'))!;
    expect(after.id).toBe(before.id);
    expect(after).toMatchObject({ minHours: null, maxHours: null, note: null, updatedBy: logist.id });
    expect((await loadBorderHours()).khorgos).toBeUndefined();
    // A reset row reads exactly like no row on the panel — no name, no note.
    const { rows } = await borderQueueRows(tashkentDay());
    const khorgos = rows.find((r) => r.post === 'khorgos')!;
    expect(khorgos.typed).toBeNull();
    expect(khorgos.seenAt).toBe(after.updatedAt.toISOString());
  });

  it('asks the same door, and is a no-op with nothing to clear', async () => {
    expect(await codeOf(clearBorderWait(seller, { post: 'khorgos', seenAt: null }, META))).toBe('forbidden');
    await clearBorderWait(logist, { post: 'khorgos', seenAt: null }, META);
    expect(await rowOf('khorgos')).toBeUndefined();
  });
});

describe('the panel’s age warning, in Tashkent days', () => {
  it(`warns from ${BORDER_QUEUE_WARN_DAYS} days, not before`, async () => {
    await save(logist);
    const today = tashkentDay();
    // Noon in Tashkent is 07:00Z — nowhere near a day boundary, whatever
    // time of day this runs (#1063's trap).
    const daysAgo = (n: number) => new Date(Date.parse(`${today}T07:00:00Z`) - n * 86_400_000);
    await db.update(borderQueue).set({ updatedAt: daysAgo(BORDER_QUEUE_WARN_DAYS - 1) }).where(eq(borderQueue.post, 'khorgos'));
    let row = (await borderQueueRows(today)).rows.find((r) => r.post === 'khorgos')!;
    expect(row.typed).toMatchObject({ ageDays: BORDER_QUEUE_WARN_DAYS - 1, warn: false });
    await db.update(borderQueue).set({ updatedAt: daysAgo(BORDER_QUEUE_WARN_DAYS) }).where(eq(borderQueue.post, 'khorgos'));
    row = (await borderQueueRows(today)).rows.find((r) => r.post === 'khorgos')!;
    expect(row.typed).toMatchObject({ ageDays: BORDER_QUEUE_WARN_DAYS, warn: true });
    // A warning is not an expiry (his default (b)): the number still counts.
    expect((await loadBorderHours()).khorgos?.hours).toEqual([72, 96]);
    // …and the panel names who typed it.
    expect(row.typed!.byName).toContain(`Chegara logist ${SUFFIX}`);
  });

  it('a row nobody’s code knows is not trusted as a wait', async () => {
    await db.insert(borderQueue).values({ post: 'irkeshtam', minHours: 1, maxHours: 2 });
    expect(await loadBorderHours()).toEqual({});
    expect((await borderQueueRows(tashkentDay())).rows.map((r) => r.post)).toEqual(['khorgos', 'yallama']);
  });
});
