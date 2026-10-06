import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcExtras,
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  dealStages,
  deals,
  events,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { finishCalcRequest, openCalcRequest } from '@/modules/wms/calc/service';
import { saveLines } from '@/modules/wms/deals/service';
import { setFreightZone } from '@/modules/wms/calc/workspace';

/**
 * «Готово» on a job the VED could have SEALED (round 112, item 6).
 *
 * The typed answer is phase A's fallback for a workspace that cannot price
 * (#775: the dictionaries ship empty). On a workspace that CAN, it was a way
 * past the seal: the request closed with a number nobody sealed — no version
 * on the card, no lock, no floor for the upsale, no discount notice. The
 * refusal is the seal's own gate (`canSeal`), so the three doors agree.
 */
const SUFFIX = `${Date.now().toString(36)}${process.pid % 1000}`;
let actorId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [a] = await db
    .insert(users)
    .values({ phone: `+99893${String(Date.now()).slice(-7)}`, fullName: `Finish fixture ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = a!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `FN${SUFFIX.slice(-6).toUpperCase()}`, name: `Finish client ${SUFFIX}`, phones: [] })
    .returning();
  clientId = c!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [d] = await db
    .insert(deals)
    .values({ code: `FN-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Finish fixture', createdBy: actorId })
    .returning();
  dealId = d!.id;
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  await db.delete(events).where(eq(events.entityId, dealId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.delete(clients).where(eq(clients.id, clientId));
  // DEACTIVATED, not deleted: the audited actions above point audit_log at
  // this user, and the FK refuses the delete (round 107's cleanup rule).
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function request(section: 'yolkira' | 'rastamojka') {
  const r = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section,
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 1500,
      volumeM3: 30,
      items: [{ name: `tovar ${SUFFIX}`, quantity: 10 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(r.id);
  return r.id;
}

describe('a typed «Готово» on a job that could be sealed', () => {
  it('is refused, and the request stays open', async () => {
    // A yolkira job with a zone prices from the tariff alone — exactly the
    // request `sealCalc` accepts (the upsale suite seals this shape).
    const id = await request('yolkira');
    await setFreightZone(id, 'cn', ctx());
    await expect(
      finishCalcRequest(id, { amountText: '480', currency: 'USD', note: 'typed', internalNote: 'ichki: qo‘lda' }, ctx()),
    ).rejects.toMatchObject({ code: 'seal_instead' });
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(row!.completedAt).toBeNull();
    expect(row!.answerAmount).toBeNull();
  });

  it('still takes the typed answer when the workspace cannot price (#775)', async () => {
    // A rastamojka job with no group and no baza has blockers: nothing can be
    // sealed, so the phase-A answer is the only door and must stay open.
    const id = await request('rastamojka');
    await finishCalcRequest(id, { amountText: '480', currency: 'USD', note: 'typed', internalNote: 'ichki: qo‘lda' }, ctx());
    const row = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, id) });
    expect(row!.completedAt).not.toBeNull();
    expect(Number(row!.answerAmount)).toBe(480);
  });
});

/**
 * The fourth door (docs/VED-TARIX.md §8, review ved-correctness-9): a seller
 * saving the deal's «Позиции» used to END the VED's queue job — no price, no
 * internal note — because the phase-A hook took the lines for the answer.
 */
describe('the seller’s lines do not end a queue job', () => {
  // Each half on its OWN deal: an older open request on the shared fixture
  // deal would be the one the hook picks, and the half under test would never
  // be reached (the first red proof of this test went red on the wrong line).
  const madeDeals: string[] = [];
  async function freshDeal(tag: string) {
    const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
    const [d] = await db
      .insert(deals)
      .values({ code: `FN-${tag}-${SUFFIX}`, clientId, stageId: stage!.id, title: `Lines ${tag}`, createdBy: actorId })
      .returning({ id: deals.id });
    madeDeals.push(d!.id);
    return d!.id;
  }
  afterAll(async () => {
    // Before the file's own afterAll removes the client these deals name.
    for (const id of madeDeals) {
      const reqs = await db
        .select({ id: calcRequests.id, taskId: calcRequests.taskId })
        .from(calcRequests)
        .where(eq(calcRequests.entityId, id));
      const ids = reqs.map((r) => r.id);
      if (ids.length > 0) {
        await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, ids));
        await db.delete(calcRequests).where(inArray(calcRequests.id, ids));
      }
      const taskIds = reqs.map((r) => r.taskId).filter(Boolean) as string[];
      if (taskIds.length > 0) {
        await db.delete(events).where(inArray(events.entityId, taskIds));
        await db.delete(tasks).where(inArray(tasks.id, taskIds));
      }
      await db.delete(events).where(eq(events.entityId, id));
      await db.delete(deals).where(eq(deals.id, id));
    }
  });

  it('an untouched sectioned request stays open', async () => {
    const deal = await freshDeal('Q');
    const r = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: deal,
        section: 'rastamojka',
        weightKg: 1500,
        items: [{ name: `tovar ${SUFFIX}`, quantity: 10 }],
        source: 'card',
      },
      ctx(),
    );
    // Untouched: rev 0, no groups — exactly the state the A14 guards let through.
    const before = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, r.id) });
    expect(before!.rev).toBe(0);
    await saveLines(deal, [{ description: `tovar ${SUFFIX}`, quantity: 3 }], ctx());
    const job = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, r.id) });
    expect(job!.completedAt, 'the VED’s job waits for a price or a seal').toBeNull();
  });

  it('a sectionless phase-A request is still ended by the lines', async () => {
    const deal = await freshDeal('L');
    const [old] = await db
      .insert(calcRequests)
      .values({
        entityType: 'deal',
        entityId: deal,
        requestedBy: actorId,
        itemCount: 1,
        dueAt: new Date(Date.now() + 3_600_000),
      })
      .returning({ id: calcRequests.id });
    await saveLines(deal, [{ description: `tovar ${SUFFIX}`, quantity: 3 }], ctx());
    const legacy = await db.query.calcRequests.findFirst({ where: eq(calcRequests.id, old!.id) });
    expect(legacy!.completedVia).toBe('lines');
  });
});
