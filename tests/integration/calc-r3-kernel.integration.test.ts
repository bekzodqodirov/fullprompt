import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The round-3 kernel's database seams (docs/SAKKIZ-R3.md K2, K14, K15), each
 * inert until a package uses it, each proven here on a real database:
 *  - the landing writes `handsoff_rev = 0`, and a CONCURRENT twin of one
 *    note's landing finds the first's request instead of opening a second;
 *  - `storedRequestFacts` reads a stored request the way the bot will;
 *  - `saveTable`'s three options (the hands-off stamp, the cargo patch, the
 *    in-transaction hook);
 *  - a reading billed on its note and attached at the landing;
 *  - one machine message per PASS, and the muted seller's direct row.
 *
 * The drain's kick is stood in (#530's idiom): no pg-boss in a test process.
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => null),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  aiCalcPasses,
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  dealStages,
  events,
  leads,
  leadStages,
  notifications,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { queueStaffTelegram } from '@/modules/platform/notifications/staff';
import { openCalcRequest, storedRequestFacts } from '@/modules/wms/calc/service';
import { saveTable } from '@/modules/wms/calc/workspace';
import { attachIntakePasses, recordAiPass } from '@/modules/wms/calc/ai-cost';
import { sayOnce } from '@/modules/wms/calc/say-once';

const SUFFIX = String(Date.now()).slice(-6);
let actorId = '';
let mutedId = '';
let clientId = '';
const madeDeals: string[] = [];
const madeLeads: string[] = [];
const madeRequests: string[] = [];

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99893${String(Date.now()).slice(-7)}`, fullName: `R3 kernel ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  const [muted] = await db
    .insert(users)
    .values({
      phone: `+99894${String(Date.now()).slice(-7)}`,
      fullName: `R3 kernel muted ${SUFFIX}`,
      passwordHash: 'x',
      mutedNotificationTypes: ['CalcPrefilled'],
    })
    .returning();
  mutedId = muted!.id;
  const [client] = await db.insert(clients).values({ clientCode: `RK${SUFFIX}`, name: `Kernel mijoz ${SUFFIX}` }).returning();
  clientId = client!.id;
});

afterAll(async () => {
  await db.delete(notifications).where(inArray(notifications.userId, [actorId, mutedId]));
  if (madeRequests.length > 0) {
    await db.delete(aiCalcPasses).where(inArray(aiCalcPasses.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const ids = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (ids.length > 0) {
      await db.delete(events).where(inArray(events.entityId, ids));
      await db.delete(tasks).where(inArray(tasks.id, ids));
    }
  }
  const cards = [...madeDeals, ...madeLeads];
  if (cards.length > 0) await db.delete(crmActivities).where(inArray(crmActivities.entityId, cards));
  if (madeLeads.length > 0) await db.delete(leads).where(inArray(leads.id, madeLeads));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(inArray(users.id, [actorId, mutedId]));
  await pgClient.end();
});

async function freshDeal(): Promise<{ id: string; code: string }> {
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const code = `RK-${SUFFIX}-${madeDeals.length}`;
  const [deal] = await db
    .insert(deals)
    .values({ code, clientId, stageId: stage!.id, title: 'R3 kernel', createdBy: actorId })
    .returning();
  madeDeals.push(deal!.id);
  return { id: deal!.id, code };
}

async function noteOn(entityType: 'deal' | 'lead', entityId: string): Promise<string> {
  const [note] = await db
    .insert(crmActivities)
    .values({ entityType, entityId, kind: 'note', note: `R3 kernel ${SUFFIX}`, createdBy: actorId })
    .returning({ id: crmActivities.id });
  return note!.id;
}

const requestRow = (id: string) =>
  db
    .select({ rev: calcRequests.rev, handsoffRev: calcRequests.handsoffRev, weightKg: calcRequests.weightKg, volumeM3: calcRequests.volumeM3, toCity: calcRequests.toCity })
    .from(calcRequests)
    .where(eq(calcRequests.id, id))
    .then((rows) => rows[0]!);

describe('the landing (K2)', () => {
  it('writes handsoff_rev = 0 beside rev 0: a request nobody has touched reads hands-off from birth', async () => {
    const deal = await freshDeal();
    const r = await openCalcRequest(
      { entityType: 'deal', entityId: deal.id, section: 'rastamojka', items: [{ name: `Kurtka ${SUFFIX}`, quantity: 10 }], source: 'card' },
      { actorId },
    );
    madeRequests.push(r.id);
    expect(r.existing).toBe(false);
    expect(await requestRow(r.id)).toMatchObject({ rev: 0, handsoffRev: 0 });
  });

  it('a twin landing of one note, waiting on the note lock, answers `existing` with the first one’s request', async () => {
    // Deterministic, not a burst (#715's method): the FIRST finisher is this
    // test's own transaction, holding the note's lock with its request
    // inserted and not yet committed. The twin must WAIT on the lock — seen
    // in pg_stat_activity through the pool — and, once the first commits,
    // read its root and insert nothing. Without the lock the twin reads
    // before the commit, sees no root, and opens a second request.
    const deal = await freshDeal();
    const noteId = await noteOn('deal', deal.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstId = '';
    let holding!: () => void;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const first = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('calc-note:' || ${noteId}::text))`);
      const [row] = await tx
        .insert(calcRequests)
        .values({
          entityType: 'deal',
          entityId: deal.id,
          requestedBy: actorId,
          itemCount: 1,
          section: 'rastamojka',
          source: 'bot',
          noteId,
          dueAt: new Date(Date.now() + 3_600_000),
          handsoffRev: 0,
        })
        .returning({ id: calcRequests.id });
      firstId = row!.id;
      holding();
      await gate;
    });
    await held;
    const twin = openCalcRequest(
      { entityType: 'deal', entityId: deal.id, section: 'rastamojka', items: [{ name: `Twin ${SUFFIX}` }], noteId, source: 'bot' },
      { actorId },
    );
    // Wait (bounded) until the twin is parked on an advisory lock.
    let waiting = false;
    for (let i = 0; i < 60 && !waiting; i += 1) {
      const rows = await db.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND datname = current_database()
      `);
      waiting = Number(rows[0]?.n ?? 0) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await first;
    madeRequests.push(firstId);
    const opened = await twin;
    if (opened.id !== firstId) madeRequests.push(opened.id);
    expect(waiting).toBe(true);
    expect(opened).toMatchObject({ id: firstId, existing: true });
    const roots = await db
      .select({ id: calcRequests.id })
      .from(calcRequests)
      .where(and(eq(calcRequests.noteId, noteId), sql`${calcRequests.supersedesRequestId} IS NULL`));
    expect(roots).toHaveLength(1);
    // Nothing after the transaction ran for the twin: no task on the card.
    const onCard = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.entityId, deal.id));
    expect(onCard).toHaveLength(0);
  });
});

describe('storedRequestFacts (K14)', () => {
  it('reads the rows in seq order with their law — the group’s for a grouped row, null for an uncoded one', async () => {
    const deal = await freshDeal();
    const r = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: deal.id,
        section: 'rastamojka',
        weightKg: 120,
        toCity: 'Toshkent',
        items: [
          { name: `Krossovka ${SUFFIX}`, quantity: 40 },
          { name: `Noma’lum ${SUFFIX}` },
        ],
        source: 'card',
      },
      { actorId },
    );
    madeRequests.push(r.id);
    const items = await db
      .select({ id: calcRequestItems.id, seq: calcRequestItems.seq })
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, r.id))
      .orderBy(calcRequestItems.seq);
    // A group with a «20 %, at least $3 a pair» law, ✅'d, holding row 1.
    const [group] = await db
      .insert(calcGroups)
      .values({
        requestId: r.id,
        seq: 1,
        label: 'Oyoq kiyim',
        tnvedCode: '6403990000',
        dutyPct: '20.000',
        vatPct: '12.000',
        dutyMode: 'max',
        dutySpecific: '3.0000',
        dutyUnit: 'juft',
        confirmedAt: new Date(),
        confirmedBy: actorId,
        confirmVia: 'single',
      })
      .returning({ id: calcGroups.id });
    await db.update(calcRequestItems).set({ groupId: group!.id, tnvedCode: '6403990000' }).where(eq(calcRequestItems.id, items[0]!.id));

    const read = await storedRequestFacts(r.id);
    expect(read).not.toBeNull();
    expect(read!.base).toMatchObject({
      requestId: r.id,
      cardLabel: deal.code,
      entityType: 'deal',
      entityId: deal.id,
      leadOpen: null,
      section: 'rastamojka',
      clientLabel: `RK${SUFFIX} Kernel mijoz ${SUFFIX}`,
      openedRev: 0,
      weightKg: 120,
      toCity: 'Toshkent',
    });
    expect(read!.base.items.map((i) => [i.seq, i.itemId, i.confirmed])).toEqual([
      [1, items[0]!.id, true],
      [2, items[1]!.id, false],
    ]);
    expect(read!.base.items[0]!.law).toMatchObject({ dutyMode: 'max', dutyUnit: 'juft', dutySpecific: 3 });
    expect(read!.base.items[1]!.law).toBeNull();
    // The facts carry the same rows, numbered, and R2's regression-3 flags.
    expect(read!.facts.goods!.map((g) => [g.seq, g.itemId])).toEqual([
      [1, items[0]!.id],
      [2, items[1]!.id],
    ]);
    expect(read!.facts).toMatchObject({ lineWeightsStated: true, totalsStored: true, weightKg: 120 });
    expect(read).toMatchObject({ rev: 0, handsoffRev: 0, aiPassRev: null, aiPassJob: null, requestedBy: actorId, ending: null });
  });

  it('a lead’s request says whether the lead still takes a job; an unknown id is null', async () => {
    const stage = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'open') });
    const [lead] = await db
      .insert(leads)
      .values({ name: `Kernel lid ${SUFFIX}`, phone: '+998901234567', stageId: stage!.id, ownerId: actorId, createdBy: actorId })
      .returning({ id: leads.id });
    madeLeads.push(lead!.id);
    const r = await openCalcRequest(
      { entityType: 'lead', entityId: lead!.id, section: 'yolkira', items: [{ name: `Yuk ${SUFFIX}` }], source: 'card' },
      { actorId },
    );
    madeRequests.push(r.id);
    const read = await storedRequestFacts(r.id);
    expect(read!.base).toMatchObject({
      entityType: 'lead',
      leadOpen: true,
      cardLabel: `Kernel lid ${SUFFIX}`,
      clientLabel: `Kernel lid ${SUFFIX} +998901234567`,
    });
    const won = await db.query.leadStages.findFirst({ where: eq(leadStages.kind, 'won') });
    await db.update(leads).set({ stageId: won!.id }).where(eq(leads.id, lead!.id));
    expect((await storedRequestFacts(r.id))!.base.leadOpen).toBe(false);
    expect(await storedRequestFacts(randomUUID())).toBeNull();
  });
});

describe('saveTable’s seams (K15)', () => {
  async function landed(): Promise<{ id: string; itemId: string }> {
    const deal = await freshDeal();
    const r = await openCalcRequest(
      { entityType: 'deal', entityId: deal.id, section: 'podklyuch', weightKg: 300, volumeM3: 2, toCity: 'Andijon', items: [{ name: `Sumka ${SUFFIX}`, quantity: 5 }], source: 'card' },
      { actorId },
    );
    madeRequests.push(r.id);
    const [item] = await db.select({ id: calcRequestItems.id }).from(calcRequestItems).where(eq(calcRequestItems.requestId, r.id));
    return { id: r.id, itemId: item!.id };
  }

  it('a machine save moves the hands-off stamp with the clock; once a person writes, it never catches up', async () => {
    const { id, itemId } = await landed();
    await saveTable(id, { items: [{ id: itemId, seq: 1, quantity: 6 }], adds: [] }, { actorId: null }, { expectRev: 0, handsOff: true });
    expect(await requestRow(id)).toMatchObject({ rev: 1, handsoffRev: 1 });
    // A person (no chain): the clock moves, the stamp stays — «started».
    await saveTable(id, { items: [{ id: itemId, seq: 1, quantity: 7 }], adds: [] }, { actorId });
    expect(await requestRow(id)).toMatchObject({ rev: 2, handsoffRev: 1 });
    // A later machine save at the person's revision writes, and still cannot
    // move a stamp that no longer stands at the revision it expected.
    await saveTable(id, { items: [{ id: itemId, seq: 1, quantity: 8 }], adds: [] }, { actorId: null }, { expectRev: 2, handsOff: true });
    expect(await requestRow(id)).toMatchObject({ rev: 3, handsoffRev: 1 });
    // Without `handsOff` a chained save moves nothing but the clock.
    const other = await landed();
    await saveTable(other.id, { items: [{ id: other.itemId, seq: 1, quantity: 6 }], adds: [] }, { actorId: null }, { expectRev: 0 });
    expect(await requestRow(other.id)).toMatchObject({ rev: 1, handsoffRev: 0 });
  });

  it('`cargo` writes only the keys it carries; `inTx` runs last, inside the save, at the revision it wrote', async () => {
    const { id, itemId } = await landed();
    let seen: { rev: number; inside: number; applied: unknown } | null = null;
    const saved = await saveTable(
      id,
      { items: [{ id: itemId, seq: 1, quantity: 9 }], adds: [], cargo: { weightKg: 450 } },
      { actorId: null },
      {
        inTx: async (tx, rev, applied) => {
          const [row] = await tx.select({ rev: calcRequests.rev }).from(calcRequests).where(eq(calcRequests.id, id));
          seen = { rev, inside: row!.rev, applied };
        },
      },
    );
    expect(seen).toEqual({ rev: saved.rev, inside: saved.rev, applied: { measuresDropped: [], measuresCleared: [], basisConflict: [] } });
    const row = await requestRow(id);
    expect(Number(row.weightKg)).toBe(450);
    expect(Number(row.volumeM3)).toBe(2);
    expect(row.toCity).toBe('Andijon');
  });

  it('a hook that throws takes the whole save back with it', async () => {
    const { id, itemId } = await landed();
    await expect(
      saveTable(
        id,
        { items: [{ id: itemId, seq: 1, quantity: 11 }], adds: [], cargo: { volumeM3: 3 } },
        { actorId: null },
        { inTx: async () => Promise.reject(new Error('hook refused')) },
      ),
    ).rejects.toThrow('hook refused');
    expect(await requestRow(id)).toMatchObject({ rev: 0 });
    expect(Number((await requestRow(id)).volumeM3)).toBe(2);
  });
});

describe('a reading billed on its note (K15)', () => {
  it('stands on the note alone until the landing attaches it — once', async () => {
    const deal = await freshDeal();
    const r = await openCalcRequest(
      { entityType: 'deal', entityId: deal.id, section: 'rastamojka', items: [{ name: `Lak ${SUFFIX}` }], source: 'card' },
      { actorId },
    );
    madeRequests.push(r.id);
    const noteId = randomUUID();
    await recordAiPass({ kind: 'intake', requestId: null, intakeNoteId: noteId, staffId: actorId, model: 'm', inputTokens: 10, outputTokens: 2 });
    const before = await db.select({ requestId: aiCalcPasses.requestId }).from(aiCalcPasses).where(eq(aiCalcPasses.intakeNoteId, noteId));
    expect(before).toEqual([{ requestId: null }]);
    expect(await attachIntakePasses(noteId, r.id)).toBe(1);
    expect(await attachIntakePasses(noteId, r.id)).toBe(0);
    const after = await db.select({ requestId: aiCalcPasses.requestId }).from(aiCalcPasses).where(eq(aiCalcPasses.intakeNoteId, noteId));
    expect(after).toEqual([{ requestId: r.id }]);
  });
});

describe('machine messages per pass, and the muted seller’s direct row (K15)', () => {
  const rowsFor = (requestId: string, userId: string) =>
    db
      .select({ status: notifications.status, payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), sql`${notifications}.payload->>'requestId' = ${requestId}`));

  it('a row written before passes had names is the landing’s; a named pass speaks once of its own', async () => {
    const deal = await freshDeal();
    const r = await openCalcRequest(
      { entityType: 'deal', entityId: deal.id, section: 'rastamojka', items: [{ name: `Stol ${SUFFIX}` }], source: 'card' },
      { actorId },
    );
    madeRequests.push(r.id);
    // Yesterday's claim: no `pass` in its payload.
    await db.insert(notifications).values({
      userId: actorId,
      channel: 'telegram',
      type: 'CalcPrefilled',
      payload: { requestId: r.id, text: 'eski' },
      status: 'sent',
    });
    const input = { userIds: [actorId], type: 'CalcPrefilled', text: 'javob' };
    expect(await sayOnce(r.id, 'landing', input)).toBe(false);
    expect(await sayOnce(r.id, 'amend:a1', input)).toBe(true);
    expect(await sayOnce(r.id, 'amend:a1', input)).toBe(false);
    const passes = (await rowsFor(r.id, actorId)).map((row) => (row.payload as { pass?: string }).pass ?? null).sort();
    expect(passes).toEqual(['amend:a1', null]);
  });

  it('`ignoreMute` queues a muted person’s row for the drain, marked direct; without it the row is muted', async () => {
    const tag = randomUUID();
    await queueStaffTelegram(db, { userIds: [mutedId], type: 'CalcPrefilled', text: 'jim', extra: { requestId: tag } });
    await queueStaffTelegram(db, { userIds: [mutedId], type: 'CalcPrefilled', text: 'to‘g‘ridan', extra: { requestId: tag }, ignoreMute: true });
    const rows = (await rowsFor(tag, mutedId)).map((row) => [row.status, (row.payload as { direct?: boolean }).direct ?? false]);
    expect(rows.sort()).toEqual([
      ['muted', false],
      ['pending', true],
    ]);
  });
});
