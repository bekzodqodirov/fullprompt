import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  calcBazas,
  calcExtras,
  calcGroups,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  crmActivities,
  currencies,
  dealStages,
  deals,
  events,
  receiptLots,
  receipts,
  tasks,
  users,
  warehouses,
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
import { addCostEntry } from '@/modules/wms/costing/service';
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
let strangerId = '';
/**
 * A currency with NO `fx_rates` row, minted by this file.
 *
 * The first version used 'AED', which passed here and failed on a fresh
 * database — because AED is inserted by `finance.integration.test.ts` and TST
 * by `m6-costing`, and vitest orders FILES by a duration cache, so «a
 * currency somebody else created» is not a fixture, it is a coin toss
 * (#380). Reference data is CONFIGURATION: this one is removed at the end.
 */
const NO_RATE_CURRENCY = `Z${SUFFIX.slice(-2)}`;
const madeRequests: string[] = [];
const madeReceipts: string[] = [];
const madeDeals: string[] = [];
const madeBazas: string[] = [];
const madeClients: string[] = [];
const madeBatches: string[] = [];
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

  await db
    .insert(currencies)
    .values({ code: NO_RATE_CURRENCY, name: `No-rate ${SUFFIX}` })
    .onConflictDoNothing();

  const [stranger] = await db
    .insert(users)
    .values({
      phone: `+99892${String(Date.now()).slice(-7)}`,
      fullName: `Actuals stranger ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  strangerId = stranger!.id;
});

afterAll(async () => {
  if (madeReceipts.length > 0) {
    // Money first: `cost_entries` point AT the receipts and their allocations
    // point at the boxes, so the pointers go before the rows they name. The
    // cleanup found this itself, as a FILE-level failure with every test
    // green — an afterAll that throws does not fail an assertion.
    const costs = await db
      .select({ id: costEntries.id })
      .from(costEntries)
      .where(inArray(costEntries.receiptId, madeReceipts));
    if (costs.length > 0) {
      const ids = costs.map((c) => c.id);
      await db.delete(costAllocations).where(inArray(costAllocations.costEntryId, ids));
      await db.delete(costEntries).where(inArray(costEntries.id, ids));
    }
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(inArray(receiptLots.receiptId, madeReceipts));
    if (lots.length > 0) {
      const boxRows = await db
        .select({ id: boxes.id })
        .from(boxes)
        .where(inArray(boxes.lotId, lots.map((l) => l.id)));
      if (boxRows.length > 0) {
        const ids = boxRows.map((b) => b.id);
        // Allocations by BOX, not only by entry: a batch-scope cost that DID
        // convert allocates onto these cartons, and its entry is cleaned up
        // further down — the rows in between would keep the boxes alive.
        await db.delete(costAllocations).where(inArray(costAllocations.boxId, ids));
        await db.delete(boxMovements).where(inArray(boxMovements.boxId, ids));
      }
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
  if (madeBatches.length > 0) {
    // Batch-scope cost entries point at the batch, and their allocations at
    // the boxes: pointers before the rows they name, same rule as the
    // receipt-scope block above.
    const batchCosts = await db
      .select({ id: costEntries.id })
      .from(costEntries)
      .where(inArray(costEntries.batchId, madeBatches));
    if (batchCosts.length > 0) {
      const ids = batchCosts.map((c) => c.id);
      await db.delete(costAllocations).where(inArray(costAllocations.costEntryId, ids));
      await db.delete(costEntries).where(inArray(costEntries.id, ids));
    }
    await db.delete(batches).where(inArray(batches.id, madeBatches));
  }
  const allDeals = [dealId, ...madeDeals];
  await db.delete(crmActivities).where(inArray(crmActivities.entityId, allDeals));
  await db.delete(deals).where(inArray(deals.id, allDeals));
  await db
    .update(clients)
    .set({ active: false })
    .where(inArray(clients.id, [clientId, ...madeClients]));
  await db.update(users).set({ active: false }).where(inArray(users.id, [actorId, strangerId]));
  // LAST: cost entries reference the currency, so the rows that name it go
  // first. Deleting it earlier raised a foreign-key error that failed the
  // FILE while every test still read green — an afterAll that throws does not
  // fail an assertion, which is how the leftover survived the first run.
  await db.delete(currencies).where(eq(currencies.code, NO_RATE_CURRENCY));
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

  it('a VED cannot touch the link that measures a colleague', async () => {
    const other = await freshDeal();
    const requestId = await sealedJobOn(other);
    const receiptId = await receiptOn(other, { boxes: 1 });
    await setCalcLink(receiptId, requestId, 'all', ctx());

    // The fixture seals as `actorId`. A DIFFERENT VED, whose scope is 'own',
    // reaches this row only by URL — every list on the screen already hides
    // it — and must not be able to erase the measurement or bless it.
    const stranger = { actorId: strangerId };
    await expect(setCalcLink(receiptId, null, 'own', stranger)).rejects.toMatchObject({
      code: 'not_mine',
    });
    await expect(confirmCalcLink(receiptId, 'own', stranger)).rejects.toMatchObject({
      code: 'not_mine',
    });
    // …and the link is still standing.
    const row = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(row!.calcRequestId).toBe(requestId);

    // The owner and the accountant answer 'all' and pass, which is the point.
    await setCalcLink(receiptId, null, 'all', stranger);
  });

  /**
   * The DETACH branch of `linkReceipt` clears the calc link and says why. The
   * RE-FILE branch had the identical problem and wrote `deal_id` alone —
   * `stampCalcLink` cannot repair it, because its UPDATE is guarded by
   * `calc_request_id IS NULL` and a confirmed link is not null.
   */
  it('re-filing a prixod onto another deal takes its calc link with it', async () => {
    const from = await freshDeal();
    const to = await freshDeal();
    const requestId = await sealedJobOn(from);
    const receiptId = await receiptOn(from, { boxes: 1 });
    await setCalcLink(receiptId, requestId, 'all', ctx());

    const before = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(before!.calcRequestId).toBe(requestId);
    expect(before!.calcLinkConfirmedAt).not.toBeNull();

    await linkReceipt(receiptId, to, ctx());

    const after = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(after!.dealId).toBe(to);
    // The old deal's calculation must stop being measured by cargo that left
    // it — and the new deal has two sealed calcs on it in this fixture only
    // if one was made, so a fresh suggestion is the most that may appear.
    expect(after!.calcLinkConfirmedAt).toBeNull();
    expect(after!.calcLinkSource).not.toBe('person');
  });

  /**
   * The ✓ writes the same fact `setCalcLink` does, so it needs the same
   * re-proof: a prixod re-filed between the screen rendering and the tap
   * leaves a stale suggestion pointing at another customer's calculation.
   */
  it('the ✓ refuses a link whose calculation is not this prixod’s deal', async () => {
    const from = await freshDeal();
    const to = await freshDeal();
    const requestId = await sealedJobOn(from);
    const receiptId = await receiptOn(from, { boxes: 1 });
    // A suggestion, unconfirmed — what the queue offers.
    await db
      .update(receipts)
      .set({ calcRequestId: requestId, calcLinkSource: 'auto' })
      .where(eq(receipts.id, receiptId));
    // …and the prixod moves to another deal underneath it.
    await db.update(receipts).set({ dealId: to }).where(eq(receipts.id, receiptId));

    await expect(confirmCalcLink(receiptId, 'all', ctx())).rejects.toMatchObject({
      code: 'request_foreign',
    });
  });

  it('refuses a calculation belonging to somebody else’s deal', async () => {
    const other = await freshDeal();
    const foreign = await sealedJobOn(other);
    const receiptId = await receipt();
    await expect(setCalcLink(receiptId, foreign, 'all', ctx())).rejects.toMatchObject({
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

    await confirmCalcLink(receiptId, 'all', ctx());
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
    await confirmCalcLink(receiptId, 'all', ctx());
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
    await setCalcLink(receiptId, first, 'all', ctx());

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
    // The typed rates EQUAL what the seeded PP-3818 dictionary answers for
    // 8528 (10 % / 12 %), so an honest recording is the empty list — typing
    // the law's own numbers deviates from nothing (VED 2.0's value compare).
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
    const { filled } = await pullBazasFromDictionary(request.id, ctx());
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
 * THE GATE ON THE WHOLE FEATURE, and the one thing the first version of this
 * file never touched: nothing here wrote a single `box_movements` row, so
 * `arrived_at` was NULL in every test and the settle clock had zero coverage
 * — while the shipped predicate asked for a status unloading never writes.
 */
describe('the cargo has to LAND before anything is scored', () => {
  /** What `ingestUnloadScans` writes at a customs/distribution warehouse. */
  async function unloadInto(receiptId: string, at: Date) {
    const uz = (await db.query.warehouses.findFirst({
      where: and(eq(warehouses.country, 'UZ'), eq(warehouses.type, 'distribution')),
    }))!;
    const cn = (await db.query.warehouses.findFirst({ where: eq(warehouses.country, 'CN') }))!;
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(eq(receiptLots.receiptId, receiptId));
    const rows = await db
      .select({ id: boxes.id })
      .from(boxes)
      .where(inArray(boxes.lotId, lots.map((l) => l.id)));
    for (const b of rows) {
      await db.insert(boxMovements).values({
        boxId: b.id,
        fromWarehouseId: cn.id,
        toWarehouseId: uz.id,
        fromStatus: 'in_transit',
        // NOT 'in_stock'. Unloading at a customs or distribution warehouse
        // puts cargo straight into ready_for_pickup, and in Uzbekistan every
        // destination is one of those two — which is why the first predicate
        // matched nothing at all.
        toStatus: 'ready_for_pickup',
        cause: 'unload_scan',
        actorId,
        createdAt: at,
      });
    }
  }

  it('is not settled while the cargo is still on the road', async () => {
    const deal = await freshDeal();
    const requestId = await sealedJobOn(deal);
    const receiptId = await receiptOn(deal, { boxes: 3 });
    await setCalcLink(receiptId, requestId, 'all', ctx());
    const row = (await calcActuals({ scope: 'all', actorId })).find(
      (r) => r.requestId === requestId,
    );
    expect(row?.arrivedAt).toBeNull();
    expect(row?.settled).toBe(false);
  });

  it('settles once a truck has unloaded it and the window has passed', async () => {
    const deal = await freshDeal();
    const requestId = await sealedJobOn(deal);
    const receiptId = await receiptOn(deal, { boxes: 3 });
    await setCalcLink(receiptId, requestId, 'all', ctx());
    await unloadInto(receiptId, new Date(Date.now() - 30 * 86_400_000));

    const row = (await calcActuals({ scope: 'all', actorId })).find(
      (r) => r.requestId === requestId,
    );
    expect(row?.arrivedAt).not.toBeNull();
    expect(row?.settled).toBe(true);
    // …and the SQL gate agrees with the flag, or the screen shows a different
    // set from the one this function reports.
    const onlySettled = await calcActuals({ scope: 'all', actorId }, { settledOnly: true });
    expect(onlySettled.some((r) => r.requestId === requestId)).toBe(true);
  });

  it('the SQL gate keeps an unsettled row out, not just the JS flag', async () => {
    const deal = await freshDeal();
    const requestId = await sealedJobOn(deal);
    const receiptId = await receiptOn(deal, { boxes: 2 });
    await setCalcLink(receiptId, requestId, 'all', ctx());
    // Landed YESTERDAY: linked, arrived, and still inside the settle window.
    await unloadInto(receiptId, new Date(Date.now() - 86_400_000));

    const all = await calcActuals({ scope: 'all', actorId });
    expect(all.some((r) => r.requestId === requestId)).toBe(true);
    expect(all.find((r) => r.requestId === requestId)?.settled).toBe(false);

    // The gate has to be in the QUERY: filtered in JS after the LIMIT, the
    // busiest months lose every scoreable row to the slice.
    const onlySettled = await calcActuals({ scope: 'all', actorId }, { settledOnly: true });
    expect(onlySettled.some((r) => r.requestId === requestId)).toBe(false);
  });

  it('does not count a status change as an arrival', async () => {
    const deal = await freshDeal();
    const requestId = await sealedJobOn(deal);
    const receiptId = await receiptOn(deal, { boxes: 2 });
    await setCalcLink(receiptId, requestId, 'all', ctx());

    const uz = (await db.query.warehouses.findFirst({
      where: and(eq(warehouses.country, 'UZ'), eq(warehouses.type, 'distribution')),
    }))!;
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(eq(receiptLots.receiptId, receiptId));
    const rows = await db
      .select({ id: boxes.id })
      .from(boxes)
      .where(inArray(boxes.lotId, lots.map((l) => l.id)));
    for (const b of rows) {
      // A crate being packed at the destination: same warehouse on both
      // sides. It is a status change, not a journey, and it must not start
      // the settle clock — nor restart it three weeks after the truck landed.
      await db.insert(boxMovements).values({
        boxId: b.id,
        fromWarehouseId: uz.id,
        toWarehouseId: uz.id,
        fromStatus: 'ready_for_pickup',
        toStatus: 'ready_for_pickup',
        cause: 'crate_packed',
        actorId,
        createdAt: new Date(Date.now() - 40 * 86_400_000),
      });
    }
    const row = (await calcActuals({ scope: 'all', actorId })).find(
      (r) => r.requestId === requestId,
    );
    expect(row?.arrivedAt).toBeNull();
    expect(row?.settled).toBe(false);
  });
});

/**
 * The band a quote was priced in came from the tariff in force when it was
 * SEALED. The owner edits his table by adding a DATED row — that is what the
 * tariff screen is for — so a check that reads TODAY's boundaries would make
 * every correct old quote start reporting the wrong band the morning after
 * any edit. Exactly the failure this round exists to avoid.
 *
 * The scenario here is artificial ON PURPOSE, and the reason is #183: a dated
 * tariff row is CONFIGURATION for the whole installation, and vitest runs
 * test FILES in parallel — inserting one repriced every seal in
 * `calc-seal` and `calc-offer` while this file held it, which is exactly what
 * happened on the first version of this test. So instead of adding a row, the
 * version is backdated to before the seed's own `effective_date`, where the
 * tariff in force is EMPTY. Correct code cannot look a band up at all; code
 * reading today's table finds one. Nothing global is written.
 */
describe('the band check reads the tariff the quote was priced under', () => {
  it('cannot re-check a quote sealed before the tariff existed', async () => {
    const deal = await freshDeal();
    const requestId = await sealedJobOn(deal);
    const receiptId = await receiptOn(deal, { boxes: 2 });
    await setCalcLink(receiptId, requestId, 'all', ctx());

    // 1500 kg / 30 m³ = 50 kg/m³, which the seed prices in the 1-100 band.
    const sealed = (await db.query.calcVersions.findFirst({
      where: eq(calcVersions.requestId, requestId),
    }))!;
    expect(Number(sealed.freightBandMin)).toBe(1);

    // Before the seed's own effective_date (2026-01-01).
    await db
      .update(calcVersions)
      .set({ sealedAt: new Date('2025-06-01T00:00:00Z') })
      .where(eq(calcVersions.id, sealed.id));

    const row = (
      // A big limit on purpose: this row is deliberately the OLDEST seal in
      // the window, and `ORDER BY sealed_at DESC LIMIT n` keeps the newest —
      // on a long-lived local database the default slice drops it. That is
      // the screen's own trade-off, not this test's subject.
      await calcActuals(
        { scope: 'all', actorId },
        { since: new Date('2025-01-01T00:00:00Z'), limit: 5000 },
      )
    ).find((r) => r.requestId === requestId);

    // The quote still names the band it was sealed with — that is stored on
    // the version and nothing can move it.
    expect(row?.band.quotedMin).toBe(1);
    // But there is no tariff to look the arrived density up in, so the check
    // says nothing rather than inventing an answer. Reading TODAY's table
    // would answer 1 here, which is what the red proof shows.
    expect(row?.band.arrivedMin).toBeNull();
    expect(row?.band.ok).toBeNull();
  });
});

/**
 * A rastamojka quote needs no volume at all — nothing blocks a seal without
 * one — so a completeness rule keyed on volume ALONE leaves exactly that
 * section with no guard, and the row is scored on whatever fraction of the
 * shipment happens to have arrived.
 */
describe('a quote with no volume is still guarded, by weight', () => {
  it('refuses a quote whose cargo arrived at a fraction of the quoted weight', async () => {
    const deal = await freshDeal();
    const request = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: deal,
        section: 'rastamojka',
        weightKg: 5000,
        items: [{ name: `tovar ${tag()}`, quantity: 200 }],
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
        dutyFree: false,
        vatFree: false,
        source: 'typed',
      },
      ctx(),
    );
    await setItemBaza(request.id, 1, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
    await confirmGroup(groupId, ctx());
    await sealCalc(
      request.id,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );
    const version = (await db.query.calcVersions.findFirst({
      where: eq(calcVersions.requestId, request.id),
    }))!;
    // The premise: a rastamojka seal really does carry no volume.
    expect(version.volumeM3).toBeNull();

    // One small prixod against a 5,000 kg quote: the rest is still in Yiwu.
    const [row] = await db
      .insert(receipts)
      .values({
        number: `AC${tag()}`,
        warehouseId,
        clientId,
        status: 'confirmed',
        createdBy: actorId,
        confirmedAt: new Date(),
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
      totalWeightKg: '300',
      totalVolumeM3: '1.8',
    });
    await setCalcLink(row!.id, request.id, 'all', ctx());

    const scored = (await calcActuals({ scope: 'all', actorId })).find(
      (r) => r.requestId === request.id,
    );
    expect(scored?.refusal).toBe('cargo_incomplete');
    // And no percentage against the person who priced it correctly.
    expect(scored?.customsPct).toBeNull();
  });
});

/**
 * The TRUCK's answers. Two of them reach this screen and neither can be read
 * off the prixod alone: the shared rastamojka the accountant enters once at
 * BATCH scope, and «mijoz o'z firmasi bilan» set once on the batch card.
 */
describe('the truck answers for the cargo it carried', () => {
  /** The batch these boxes rode, as `departBatch` records it. */
  async function rodeBatch(receiptId: string, opts: { byClient?: boolean } = {}) {
    const cn = (await db.query.warehouses.findFirst({ where: eq(warehouses.country, 'CN') }))!;
    const uz = (await db.query.warehouses.findFirst({
      where: and(eq(warehouses.country, 'UZ'), eq(warehouses.type, 'distribution')),
    }))!;
    const [batch] = await db
      .insert(batches)
      .values({
        code: `ACB-${tag()}`.slice(0, 20),
        originWarehouseId: cn.id,
        destWarehouseId: uz.id,
        status: 'in_transit',
        departedAt: new Date(Date.now() - 20 * 86_400_000),
        customsByClient: opts.byClient ?? false,
        createdBy: actorId,
      })
      .returning();
    madeBatches.push(batch!.id);
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(eq(receiptLots.receiptId, receiptId));
    const rows = await db
      .select({ id: boxes.id })
      .from(boxes)
      .where(inArray(boxes.lotId, lots.map((l) => l.id)));
    for (const b of rows) {
      await db.insert(boxMovements).values({
        boxId: b.id,
        fromWarehouseId: cn.id,
        toWarehouseId: uz.id,
        fromStatus: 'loading',
        toStatus: 'in_transit',
        cause: 'batch_departed',
        refType: 'batch',
        refId: batch!.id,
        actorId,
        createdAt: new Date(Date.now() - 20 * 86_400_000),
      });
    }
    return batch!.id;
  }

  async function customsJob() {
    const deal = await freshDeal();
    const request = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: deal,
        section: 'rastamojka',
        weightKg: 1500,
        volumeM3: 30,
        items: [{ name: `tovar ${tag()}`, quantity: 200 }],
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
        dutyFree: false,
        vatFree: false,
        source: 'typed',
      },
      ctx(),
    );
    await setItemBaza(request.id, 1, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
    await confirmGroup(groupId, ctx());
    await sealCalc(
      request.id,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );
    const receiptId = await receiptOn(deal, { boxes: 4 });
    await setCalcLink(receiptId, request.id, 'all', ctx());
    return { requestId: request.id, receiptId };
  }

  it('sees a BATCH-scope rastamojka that has no FX rate yet', async () => {
    const { requestId, receiptId } = await customsJob();
    const batchId = await rodeBatch(receiptId);
    const customsType = (await db.query.costTypes.findFirst({
      where: eq(costTypes.code, 'customs'),
    }))!;
    // Round 29's agreed method: shared rastamojka is ONE batch-scope row.
    // With no rate it allocates to nothing, so every allocation-backed CTE
    // is blind to it — and the row was being scored on the money that DID
    // convert, i.e. a green «saving» on a bill of ours worth more than the
    // quote.
    await addCostEntry(
      {
        scope: 'batch',
        batchId,
        costTypeId: customsType.id,
        amount: 2000,
        currency: NO_RATE_CURRENCY,
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'weight',
      } as never,
      ctx(),
    );
    const row = (await calcActuals({ scope: 'all', actorId })).find(
      (r) => r.requestId === requestId,
    );
    expect(row?.refusal).toBe('unconverted');
    expect(row?.actualCustomsUsd).toBeNull();
  });

  it('honours «mijoz o‘z firmasi bilan» set once on the batch card', async () => {
    const { requestId, receiptId } = await customsJob();
    // Nobody touched the per-prixod picker, which is the whole point of the
    // batch-level control: the receipt stays NULL and the truck answers.
    await rodeBatch(receiptId, { byClient: true });
    const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(receipt!.customsByClient).toBeNull();

    const row = (await calcActuals({ scope: 'all', actorId })).find(
      (r) => r.requestId === requestId,
    );
    expect(row?.refusal).toBe('customs_by_client');
  });

  it('but an explicit answer on the prixod still wins over the truck', async () => {
    const { requestId, receiptId } = await customsJob();
    await rodeBatch(receiptId, { byClient: true });
    // `false` on the receipt is an ANSWER — «we clear this one» — and the
    // three-state rule exists so it is not mixed up with silence.
    await db
      .update(receipts)
      .set({ customsByClient: false })
      .where(eq(receipts.id, receiptId));

    const row = (await calcActuals({ scope: 'all', actorId })).find(
      (r) => r.requestId === requestId,
    );
    expect(row?.refusal).not.toBe('customs_by_client');
  });
});

/**
 * The two ways a real customs bill goes MISSING from the comparison, both of
 * which write no `cost_allocations` rows at all — so the query cannot see
 * them through the allocation table, which is the only place it looks for
 * money. Both make the actual read LOWER than the truth, which puts the VED
 * in the wrong about a bill they had nothing to do with.
 */
describe('a bill that allocated to nobody is a refusal, not a saving', () => {
  /**
   * A sealed RASTAMOJKA job with cargo linked to it. The section matters:
   * `section_has_no_customs` fires first on a yolkira quote, which is right
   * and would make these two tests assert about the wrong refusal.
   */
  async function linkedJob() {
    const deal = await freshDeal();
    const request = await openCalcRequest(
      {
        entityType: 'deal',
        entityId: deal,
        section: 'rastamojka',
        weightKg: 1500,
        volumeM3: 30,
        items: [{ name: `tovar ${tag()}`, quantity: 200 }],
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
        dutyFree: false,
        vatFree: false,
        source: 'typed',
      },
      ctx(),
    );
    await setItemBaza(request.id, 1, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx());
    await confirmGroup(groupId, ctx());
    await sealCalc(
      request.id,
      { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null },
      ctx(),
    );
    const receiptId = await receiptOn(deal, { boxes: 4 });
    await setCalcLink(receiptId, request.id, 'all', ctx());
    return { requestId: request.id, receiptId, deal };
  }

  it('refuses «unconverted» when the rastamojka has no FX rate yet', async () => {
    const { requestId, receiptId } = await linkedJob();
    const customsType = (await db.query.costTypes.findFirst({
      where: eq(costTypes.code, 'customs'),
    }))!;
    // A currency with no dated rate: `recomputeEntry` returns before
    // allocating, so `amount_usd` stays NULL and nothing is written.
    await addCostEntry(
      {
        scope: 'receipt',
        receiptId,
        costTypeId: customsType.id,
        amount: 500,
        // No `fx_rates` row at all, so `recomputeEntry` returns before
        // allocating and `amount_usd` stays NULL. CNY would NOT do: `rateFor`
        // falls back to the earliest row, so even a 2019 date converts.
        currency: NO_RATE_CURRENCY,
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'weight',
      } as never,
      ctx(),
    );
    const row = (await calcActuals({ scope: 'all', actorId })).find(
      (r) => r.requestId === requestId,
    );
    expect(row?.refusal).toBe('unconverted');
    // And NOT a number: reading a missing rate as $0 makes it look like the
    // VED saved the company the whole rastamojka.
    expect(row?.actualCustomsUsd).toBeNull();
  });

  it('refuses «unallocated» when the bill was filed against another client', async () => {
    const { requestId, receiptId } = await linkedJob();
    const customsType = (await db.query.costTypes.findFirst({
      where: eq(costTypes.code, 'customs'),
    }))!;
    const [other] = await db
      .insert(clients)
      .values({ clientCode: `AX${tag()}`.slice(0, 10), name: `Foreign ${SUFFIX}` })
      .returning();
    madeClients.push(other!.id);
    await db.execute(sql`INSERT INTO fx_rates (id, currency, rate_to_usd, effective_date, entered_by)
      VALUES (gen_random_uuid(), 'USD', 1, CURRENT_DATE, ${actorId}::uuid)
      ON CONFLICT (currency, effective_date) DO NOTHING`);
    // `direct_to_client` at a client who owns none of these boxes writes NO
    // allocation rows — the entry exists, the money is real, and the
    // comparison could not see it at all.
    await addCostEntry(
      {
        scope: 'receipt',
        receiptId,
        costTypeId: customsType.id,
        amount: 1800,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'direct_to_client',
        clientId: other!.id,
      } as never,
      ctx(),
    );
    const row = (await calcActuals({ scope: 'all', actorId })).find(
      (r) => r.requestId === requestId,
    );
    expect(row?.refusal).toBe('unallocated');
    expect(row?.actualCustomsUsd).toBeNull();
  });

  /**
   * `calc_customs_deviation_pct` is a live row on /admin/settings. It shipped
   * reading nothing, so the screen coloured on the SIGN and a 0.4 % overrun
   * looked as alarming as a 60 % one.
   */
  it('flags a gap only once it passes the owner’s own threshold', async () => {
    const { requestId, receiptId } = await linkedJob();
    const customsType = (await db.query.costTypes.findFirst({
      where: eq(costTypes.code, 'customs'),
    }))!;
    await db.execute(sql`INSERT INTO fx_rates (id, currency, rate_to_usd, effective_date, entered_by)
      VALUES (gen_random_uuid(), 'USD', 1, CURRENT_DATE, ${actorId}::uuid)
      ON CONFLICT (currency, effective_date) DO NOTHING`);
    const version = (await db.query.calcVersions.findFirst({
      where: eq(calcVersions.requestId, requestId),
    }))!;
    // Half a percent over the quote: real, recorded, and not worth a colour.
    await addCostEntry(
      {
        scope: 'receipt',
        receiptId,
        costTypeId: customsType.id,
        amount: Math.round(Number(version.customsUsd) * 1.005 * 100) / 100,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'weight',
      } as never,
      ctx(),
    );
    const row = (await calcActuals({ scope: 'all', actorId })).find(
      (r) => r.requestId === requestId,
    );
    expect(row?.refusal).toBeNull();
    expect(row?.customsPct).not.toBeNull();
    expect(Math.abs(row!.customsPct!)).toBeLessThan(15);
    expect(row?.customsOffThreshold).toBe(false);
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
    await setCalcLink(receiptId, requestId, 'all', ctx());

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
  opts: { confirmedAt?: Date; boxes?: number } = {},
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
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: row!.id,
      seq: 1,
      productNameZh: `tovar ${tag()}`,
      boxCount: opts.boxes ?? 1,
      dimsMode: 'mixed',
      totalWeightKg: '1500',
      totalVolumeM3: '30',
    })
    .returning();
  // Real cartons, because `cost_allocations` are per BOX: a receipt with no
  // boxes can never be allocated to, so a test about «this bill allocated to
  // nobody» would pass for a reason that has nothing to do with its subject.
  for (let n = 1; n <= (opts.boxes ?? 0); n += 1) {
    await db.insert(boxes).values({
      lotId: lot!.id,
      shortCode: `AC${tag()}${n}`.slice(0, 20),
      seqInLot: n,
      status: 'in_stock',
      currentWarehouseId: warehouseId,
    });
  }
  return row!.id;
}
