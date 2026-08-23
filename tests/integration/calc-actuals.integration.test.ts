import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxes,
  calcBazas,
  calcExtras,
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  receiptLots,
  receipts,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import {
  confirmAllGroups,
  confirmGroup,
  createGroup,
  moveItemToGroup,
  pullBazasFromDictionary,
  recalcFromSealed,
  sealCalc,
  setFreightZone,
  setGroupRates,
  setItemBaza,
} from '@/modules/wms/calc/workspace';
import { saveBaza } from '@/modules/wms/calc/dictionaries';
import { confirmCalcLink, setCalcLink, stampCalcLink } from '@/modules/wms/calc/link';
import { calcActuals, calcCoverage, linkSuggestions } from '@/modules/wms/calc/actuals';
import { linkReceipt } from '@/modules/wms/deals/service';

/**
 * VED phase E1 — the join, and what a ✅ is a record OF.
 *
 * Every test here is about one of two things the round rests on:
 *
 *   1. **only a CONFIRMED link is measured.** An `auto` guess is a
 *      suggestion; the whole feature is honest because a guess never scores
 *      anybody.
 *   2. **a ✅ must not outlive the numbers it was about.** Two writers clear
 *      it and the pair CHECK 0089 added is what makes forgetting either one
 *      loud rather than silent.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `VEDE-${SUFFIX}-${(seq += 1)}`;

let actorId = '';
let clientId = '';
let dealId = '';
let warehouseId = '';
const madeRequests: string[] = [];
const madeReceipts: string[] = [];
const madeDeals: string[] = [];
const madeBazas: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [a] = await db
    .insert(users)
    .values({
      phone: `+99893${String(Date.now()).slice(-7)}`,
      fullName: `Actuals fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = a!.id;

  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AC${SUFFIX}`, name: `Actuals fixture ${SUFFIX}` })
    .returning();
  clientId = c!.id;

  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [d] = await db
    .insert(deals)
    .values({
      code: `AC-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'Actuals fixture',
      createdBy: actorId,
    })
    .returning();
  dealId = d!.id;

  // Any existing warehouse: this file never asserts about a warehouse, it
  // only needs a receipt to be able to exist.
  const wh = await db.query.warehouses.findFirst();
  warehouseId = wh!.id;
});

afterAll(async () => {
  if (madeReceipts.length > 0) {
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(inArray(receiptLots.receiptId, madeReceipts));
    if (lots.length > 0) {
      await db.delete(boxes).where(inArray(boxes.lotId, lots.map((l) => l.id)));
      await db.delete(receiptLots).where(inArray(receiptLots.id, lots.map((l) => l.id)));
    }
    await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  }
  if (madeRequests.length > 0) {
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db
      .update(calcRequests)
      .set({ supersedesRequestId: null })
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (madeBazas.length > 0) {
    await db.delete(calcBazas).where(inArray(calcBazas.id, madeBazas));
  }
  const allDeals = [dealId, ...madeDeals];
  await db.delete(crmActivities).where(inArray(crmActivities.entityId, allDeals));
  await db.delete(deals).where(inArray(deals.id, allDeals));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

/** A sealed yolkira job: freight only, so the tariff alone reaches a price. */
async function sealedJob(opts: { weightKg?: number; volumeM3?: number } = {}) {
  const request = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'yolkira',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: opts.weightKg ?? 1500,
      volumeM3: opts.volumeM3 ?? 30,
      items: [{ name: `tovar ${tag()}`, quantity: 10 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(request.id);
  await setFreightZone(request.id, 'cn', ctx());
  await sealCalc(
    request.id,
    { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
    ctx(),
  );
  return request.id;
}

/** A confirmed prixod on the fixture's deal, with one lot of known size. */
async function receipt(opts: { volumeM3?: number; weightKg?: number; confirmedAt?: Date } = {}) {
  const [row] = await db
    .insert(receipts)
    .values({
      number: `AC${tag()}`,
      warehouseId,
      clientId,
      status: 'confirmed',
      createdBy: actorId,
      confirmedAt: opts.confirmedAt ?? new Date(),
      confirmedBy: actorId,
      dealId,
    })
    .returning();
  madeReceipts.push(row!.id);
  await db.insert(receiptLots).values({
    receiptId: row!.id,
    seq: 1,
    productNameZh: `tovar ${tag()}`,
    boxCount: 1,
    dimsMode: 'mixed',
    totalWeightKg: String(opts.weightKg ?? 1500),
    totalVolumeM3: String(opts.volumeM3 ?? 30),
  });
  return row!.id;
}

describe('the join is written by one function and only a person makes it count', () => {
  it('suggests a link when the deal has exactly one sealed calculation', async () => {
    const requestId = await sealedJob();
    const receiptId = await receipt();
    await db.transaction(async (tx) => {
      await stampCalcLink(tx, receiptId, dealId);
    });
    const row = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(row!.calcRequestId).toBe(requestId);
    expect(row!.calcLinkSource).toBe('auto');
    // …and it is NOT confirmed, which is the whole point.
    expect(row!.calcLinkConfirmedAt).toBeNull();
  });

  /**
   * The guard the design's «one sealed calculation» door would have missed.
   * `dealFor` sends every repeat client to their newest OPEN deal and no
   * seeded stage carries a cargo trigger, so one deal alive for months with
   * several quotes on it is the ordinary shape — a machine has no way to pick.
   */
  it('suggests nothing once the deal carries two sealed calculations', async () => {
    await sealedJob();
    await sealedJob();
    const receiptId = await receipt();
    await db.transaction(async (tx) => {
      await stampCalcLink(tx, receiptId, dealId);
    });
    const row = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(row!.calcRequestId).toBeNull();
  });

  /**
   * The WINDOW. A prixod confirmed after the quote expired is next season's
   * shipment on the same long-lived deal, not the cargo that quote was about.
   */
  it('refuses a prixod confirmed outside the quote window', async () => {
    const other = await freshDeal();
    await sealedJobOn(other);
    const past = new Date(Date.now() - 400 * 86_400_000);
    const receiptId = await receiptOn(other, { confirmedAt: past });
    await db.transaction(async (tx) => {
      await stampCalcLink(tx, receiptId, other);
    });
    const row = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(row!.calcRequestId).toBeNull();
  });

  it('linkReceipt stamps it, and detaching the deal takes the link with it', async () => {
    const other = await freshDeal();
    await sealedJobOn(other);
    const receiptId = await receiptOn(other);
    // Born with no deal, so `linkReceipt` is the door that makes it.
    await db.update(receipts).set({ dealId: null }).where(eq(receipts.id, receiptId));
    await linkReceipt(receiptId, other, ctx());
    const linked = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(linked!.calcRequestId).not.toBeNull();

    await linkReceipt(receiptId, null, ctx());
    const cleared = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(cleared!.calcRequestId).toBeNull();
    expect(cleared!.calcLinkSource).toBeNull();
  });

  it('refuses a calculation belonging to somebody else’s deal', async () => {
    const other = await freshDeal();
    const foreign = await sealedJobOn(other);
    const receiptId = await receipt();
    await expect(setCalcLink(receiptId, foreign, ctx())).rejects.toMatchObject({
      code: 'request_foreign',
    });
  });

  it('an unconfirmed link is offered in the queue and scores nothing', async () => {
    const other = await freshDeal();
    const requestId = await sealedJobOn(other);
    const receiptId = await receiptOn(other);
    await db.transaction(async (tx) => {
      await stampCalcLink(tx, receiptId, other);
    });

    const who = { scope: 'all', actorId } as const;
    const queue = await linkSuggestions(who);
    expect(queue.some((q) => q.receiptId === receiptId)).toBe(true);

    const before = (await calcActuals(who)).find((r) => r.requestId === requestId);
    expect(before?.refusal).toBe('not_linked');

    await confirmCalcLink(receiptId, ctx());
    const after = (await calcActuals(who)).find((r) => r.requestId === requestId);
    // Now it is measurable — and refuses for a REASON about the money, not
    // about the link.
    expect(after?.refusal).not.toBe('not_linked');
    expect(after?.receiptCount).toBe(1);
  });

  it('counts a confirmed link in the coverage line', async () => {
    const other = await freshDeal();
    await sealedJobOn(other);
    const receiptId = await receiptOn(other);
    await db.transaction(async (tx) => {
      await stampCalcLink(tx, receiptId, other);
    });
    const who = { scope: 'all', actorId } as const;
    const since = new Date(Date.now() - 86_400_000);
    const before = await calcCoverage(who, since);
    await confirmCalcLink(receiptId, ctx());
    const after = await calcCoverage(who, since);
    expect(after.linked).toBe(before.linked + 1);
  });
});

describe('a correction adopts the cargo it was correcting', () => {
  /**
   * Re-pointing at recalc time was refused: `recalcFromSealed` inserts a
   * request with NO version, so the cargo would hang off a priceless request
   * — permanently, if the correction were then abandoned. The seal is where a
   * price exists by construction.
   */
  it('moves confirmed links onto the new request when the correction seals', async () => {
    const other = await freshDeal();
    const first = await sealedJobOn(other);
    const receiptId = await receiptOn(other);
    await setCalcLink(receiptId, first, ctx());

    const second = await recalcFromSealed(first, ctx());
    madeRequests.push(second);
    // Still on the old one while the correction is unsealed: an abandoned
    // correction must not take the shipment's only measurement with it.
    const during = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(during!.calcRequestId).toBe(first);

    await setFreightZone(second, 'cn', ctx());
    await sealCalc(
      second,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );
    const after = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(after!.calcRequestId).toBe(second);
  });
});

/**
 * `mergeProposals` mints the ORPHAN group — the cargo the model did not place
 * — with confidence 'low' and `aiProposed: false`. Counting confidence alone
 * inflates «how much of this was still the model's» by a group nobody's model
 * ever touched, on every calculation that has one, which is most of them.
 */
describe('the low-confidence counter is about the MODEL, not about a mood', () => {
  it('does not count a group the model never proposed', async () => {
    // A rastamojka quote, because a yolkira one that carries customs groups
    // is refused by design and the group is the whole subject here.
    const request = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: dealId,
        section: 'rastamojka',
        weightKg: 1500,
        volumeM3: 30,
        items: [{ name: `tovar ${tag()}`, quantity: 10 }],
        source: 'card',
      },
      ctx(),
    );
    madeRequests.push(request.id);
    // The orphan's exact shape, written directly: `applyProposal` would need
    // a model call to reach it, and the shape is the whole subject here.
    const [orphan] = await db
      .insert(calcGroups)
      .values({
        requestId: request.id,
        seq: 1,
        label: 'qolgan tovarlar',
        aiProposed: false,
        aiConfidence: 'low',
      })
      .returning();
    await moveItemToGroup(request.id, 1, orphan!.id, ctx());
    await setGroupRates(
      orphan!.id,
      {
        tnvedCode: '8528520000',
        dutyPct: 10,
        vatPct: 12,
        feeUsd: 0,
        dutyFree: false,
        vatFree: false,
        source: 'typed',
      },
      ctx(),
    );
    // `unit` and not `kg`: `openCalcRequest` items carry a quantity and no
    // weight, so a kg basis has no measure to multiply and the group refuses.
    await setItemBaza(request.id, 1, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
    // Confirmed LAST: both setters clear the ✅, and an unconfirmed group is
    // a seal blocker (law 1).
    await confirmGroup(orphan!.id, ctx());
    await sealCalc(
      request.id,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );
    const version = await db.query.calcVersions.findFirst({
      where: eq(calcVersions.requestId, request.id),
    });
    expect(version!.lowConfidenceSealed).toBe(0);
    expect(version!.aiBlindGroups).toBe(0);
  });
});

describe('a ✅ must not outlive the numbers it was about', () => {
  async function groupedJob() {
    const request = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: dealId,
        section: 'rastamojka',
        weightKg: 1500,
        volumeM3: 30,
        items: [{ name: `tovar ${tag()}`, quantity: 10 }],
        source: 'card',
      },
      ctx(),
    );
    madeRequests.push(request.id);
    const groupId = await createGroup(request.id, { label: 'test' }, ctx());
    await moveItemToGroup(request.id, 1, groupId, ctx());
    await setGroupRates(
      groupId,
      {
        tnvedCode: '8528520000',
        dutyPct: 10,
        vatPct: 12,
        feeUsd: 0,
        dutyFree: false,
        vatFree: false,
        source: 'typed',
      },
      ctx(),
    );
    return { requestId: request.id, groupId };
  }

  it('records what stood on the screen when a group is confirmed', async () => {
    const { requestId, groupId } = await groupedJob();
    await confirmGroup(groupId, ctx());
    const row = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
    expect(row!.confirmVia).toBe('single');
    // The dictionaries ship EMPTY, so an honest recording here is the empty
    // list — that is the point of the `dictionaryRates !== null` clause.
    expect(row!.confirmedWarnings).toEqual([]);
    expect(requestId).toBeTruthy();
  });

  it('marks a bulk confirm as bulk — a different act from a single one', async () => {
    const { requestId, groupId } = await groupedJob();
    await confirmAllGroups(requestId, ctx());
    const row = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
    expect(row!.confirmVia).toBe('bulk');
  });

  /**
   * THE 23514 test. `setGroupRates` INLINES its own clear rather than calling
   * `unconfirm()`, so a fix aimed at one writer leaves the other raising on
   * the most-pressed button in the workspace.
   */
  it('setGroupRates clears the record, not only the confirmation', async () => {
    const { groupId } = await groupedJob();
    await confirmGroup(groupId, ctx());
    await setGroupRates(
      groupId,
      {
        tnvedCode: '8528520000',
        dutyPct: 15,
        vatPct: 12,
        feeUsd: 0,
        dutyFree: false,
        vatFree: false,
        source: 'typed',
      },
      ctx(),
    );
    const row = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
    expect(row!.confirmedAt).toBeNull();
    expect(row!.confirmVia).toBeNull();
    expect(row!.confirmedWarnings).toBeNull();
  });

  /**
   * `pullBazasFromDictionary` fills every blank baza in one pass, and it is a
   * third writer of the numbers a ✅ was about — it had no clear at all,
   * so a dictionary sweep left the tick standing over figures nobody had
   * looked at. The same rule `setItemBaza` already applied one item at a time.
   */
  it('a dictionary sweep clears the confirmation too', async () => {
    const name = `pullbaza ${tag()}`;
    const request = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: dealId,
        section: 'rastamojka',
        weightKg: 1500,
        volumeM3: 30,
        items: [{ name, quantity: 10 }],
        source: 'card',
      },
      ctx(),
    );
    madeRequests.push(request.id);
    const groupId = await createGroup(request.id, { label: 'test' }, ctx());
    await moveItemToGroup(request.id, 1, groupId, ctx());
    // The dictionary row this sweep will find. Its own, and removed at the
    // end — a baza is the COMPANY's and one left behind reprices the next
    // spec's calculation (#183/#653).
    const bazaId = await saveBaza(
      {
        name,
        label: name,
        tnvedCode: null,
        bazaUsd: 4,
        basis: 'kg',
        effectiveDate: '2020-01-01',
        note: null,
      },
      ctx(),
    );
    madeBazas.push(bazaId);

    await confirmGroup(groupId, ctx());
    const filled = await pullBazasFromDictionary(request.id, ctx());
    expect(filled).toBe(1);
    const row = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
    expect(row!.confirmedAt).toBeNull();
    expect(row!.confirmVia).toBeNull();
  });

  it('unconfirm() clears it too — a changed baza is a changed number', async () => {
    const { requestId, groupId } = await groupedJob();
    await confirmGroup(groupId, ctx());
    await setItemBaza(requestId, 1, { bazaUsd: 4, basis: 'kg', source: 'typed' }, ctx());
    const row = await db.query.calcGroups.findFirst({ where: eq(calcGroups.id, groupId) });
    expect(row!.confirmedAt).toBeNull();
    expect(row!.confirmVia).toBeNull();
  });
});

/**
 * The standing guard for the CHECK that was deliberately NOT written as a
 * biconditional: measured, `ON DELETE SET NULL` is an internal UPDATE of the
 * FK column alone, so a biconditional turns this delete into a 23514 — and
 * six integration files would start silently leaving rows behind.
 */
describe('deleting a calc_request with a linked prixod still works', () => {
  it('nulls the pointer instead of aborting', async () => {
    const other = await freshDeal();
    const requestId = await sealedJobOn(other);
    const receiptId = await receiptOn(other);
    await setCalcLink(receiptId, requestId, ctx());

    await db.delete(calcVersions).where(eq(calcVersions.requestId, requestId));
    await db.delete(calcRequestItems).where(eq(calcRequestItems.requestId, requestId));
    await db.delete(calcRequests).where(eq(calcRequests.id, requestId));

    const row = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(row!.calcRequestId).toBeNull();
    // The source and the confirmation survive as an orphaned record, which is
    // exactly what the relaxed CHECK permits and what the biconditional would
    // have refused at the cost of the delete itself.
    expect(row!.calcLinkSource).toBe('person');
  });
});

// --- fixtures that need their own deal -------------------------------------
//
// The first block shares one deal on purpose (it is about a deal carrying
// SEVERAL calculations). Every test that needs «exactly one sealed
// calculation» mints its own, or it inherits the multi-quote state and
// asserts the opposite of its own sentence.

async function freshDeal(): Promise<string> {
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [d] = await db
    .insert(deals)
    .values({
      code: `AC-${tag()}`,
      clientId,
      stageId: stage!.id,
      title: 'Actuals fixture',
      createdBy: actorId,
    })
    .returning();
  madeDeals.push(d!.id);
  return d!.id;
}

async function sealedJobOn(deal: string): Promise<string> {
  const request = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: deal,
      section: 'yolkira',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 1500,
      volumeM3: 30,
      items: [{ name: `tovar ${tag()}`, quantity: 10 }],
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(request.id);
  await setFreightZone(request.id, 'cn', ctx());
  await sealCalc(
    request.id,
    { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
    ctx(),
  );
  return request.id;
}

async function receiptOn(
  deal: string,
  opts: { confirmedAt?: Date } = {},
): Promise<string> {
  const [row] = await db
    .insert(receipts)
    .values({
      number: `AC${tag()}`,
      warehouseId,
      clientId,
      status: 'confirmed',
      createdBy: actorId,
      confirmedAt: opts.confirmedAt ?? new Date(),
      confirmedBy: actorId,
      dealId: deal,
    })
    .returning();
  madeReceipts.push(row!.id);
  await db.insert(receiptLots).values({
    receiptId: row!.id,
    seq: 1,
    productNameZh: `tovar ${tag()}`,
    boxCount: 1,
    dimsMode: 'mixed',
    totalWeightKg: '1500',
    totalVolumeM3: '30',
  });
  return row!.id;
}
