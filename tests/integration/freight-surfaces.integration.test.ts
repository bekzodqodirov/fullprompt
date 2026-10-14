import 'dotenv/config';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  calcFreightTariffs,
  clients,
  clientTransactions,
  costEntries,
  costTypes,
  currencies,
  events,
  moneyAccounts,
  receiptLots,
  receipts,
  users,
  warehouses,
  warehouseTariffColumns,
} from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import {
  addCostEntry,
  batchCostSheet,
  batchLandedCostTotals,
  carriedUnsplitBills,
  unsplitCountFor,
  unsplitOnFormingTrucks,
} from '@/modules/wms/costing/service';
import { ALL_COSTS, costSightFor } from '@/modules/wms/costing/cost-sight';
import { setTariffColumnInTx } from '@/modules/wms/costing/tariff-column';
import { editLot } from '@/modules/wms/receipts/edit';
import { addTransaction } from '@/modules/wms/finance/service';
import { companyBalance, profitByBatch } from '@/modules/wms/accounting/reports';

/**
 * docs/YOLKIRA-TAQSIMOT.md §11 tests 10-12 — where a HELD yo'lkira bill (his
 * rule 6: saved, not split) is named, against a real database:
 *
 * - 10: on the pricing page of the truck whose tannarx it feeds — an earlier
 *   internal leg («shu reysgacha») and a later Uzbek leg («keyingi yo'l») —
 *   through the fence's own CTEs, and gone the moment the lot is fixed;
 * - 11: on the Balans, as its own sentence and never inside «hech bir
 *   karobkaga tushmagan» (whose cure is a void);
 * - 12: as the truck card's todo, under the reader's own sight;
 * - and the edges of `carriedUnsplitBills` / `unsplitOnFormingTrucks` the
 *   tests above cannot reach (review of the round): what the fence's two
 *   windows LEAVE OUT, a feeding bill with no rate yet, a direct bill as its
 *   own client's money, and the trucks that have not left.
 *
 * Money parked in 1648 (no other file's year), so the trucks fall in no
 * other file's profit window. Tariff columns under ONE private run prefix
 * `t_<n><run>_wten`, swept before and deleted as a FINAL TEST (#824). A
 * warehouse column is CONFIGURATION (#183); the private warehouses and the
 * kassa are deactivated, never deleted (audit FK). Every Balans figure is a
 * DELTA: CI runs every file on one database. The no-rate currency is the
 * file's own (no rate is ever written for it — `rateFor` falls back to a
 * currency's EARLIEST rate, so any real one converts even in 1648) and is
 * removed once nothing names it.
 */
const RUN = String(Date.now()).slice(-6);
let counter = 0;
const ZONE = `t_${(counter += 1)}${RUN}_wten`;
const SWEEP = /^t_[0-9a-z]+_wten$/;
const TARIFF_DAY = '1648-01-01';
const DAY = '1648-06-14';
const NO_RATE = 'QFS';

let actorId = '';
let accountantId = '';
let vedId = '';
let freightType = '';
let till = '';
let whW = '';
let whK = '';
let whD = '';
let whE = '';
/** Two Kazakh warehouses: a crossing INTO Kazakhstan bears the price again, the leg after it does not. */
let whF = '';
let whG = '';
const made = {
  receipts: [] as string[],
  batches: [] as string[],
  costs: [] as string[],
  clients: [] as string[],
  charges: [] as string[],
  /** A truck a charge names — kept (cancelled), since money is voided, never deleted. */
  charged: [] as string[],
};
let seq = 0;

const ctx = (as = actorId) => ({ actorId: as, ip: null, userAgent: null });
const manager = () =>
  ({
    id: actorId,
    fullName: `FS manager ${RUN}`,
    roles: ['warehouse_manager'],
    permissions: new Set(['receipts.edit', 'receipts.void']),
  }) as unknown as Actor;

async function mintWarehouse(code: string, country: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, name: `FS ${code}`, country, type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
    .returning();
  return row!.id;
}

async function mintClient(label: string) {
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `S${label}${RUN}`.slice(0, 10), name: `FS ${label} ${RUN}` })
    .returning();
  made.clients.push(c!.id);
  return c!.id;
}

/**
 * A confirmed prixod at W (or `at` — where it was received decides which
 * truck bears its price, `bearsPriceSql`) with one MIXED lot of one carton
 * (totals).
 */
async function mintLot(client: string, kg: number, m3: number, at = whW) {
  const [receipt] = await db
    .insert(receipts)
    .values({ warehouseId: at, clientId: client, status: 'confirmed', confirmedAt: new Date(), createdBy: actorId })
    .returning();
  made.receipts.push(receipt!.id);
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt!.id,
      seq: 1,
      letter: 'A',
      dimsMode: 'mixed',
      productNameZh: '测试货',
      boxCount: 1,
      totalWeightKg: kg.toFixed(3),
      totalVolumeM3: m3.toFixed(4),
    })
    .returning();
  const [box] = await db
    .insert(boxes)
    .values({ lotId: lot!.id, shortCode: `FS${RUN}-${(seq += 1)}`, seqInLot: 1, status: 'in_stock', currentWarehouseId: at })
    .returning();
  return { receiptId: receipt!.id, lotId: lot!.id, boxIds: [box!.id] };
}

/** A departed truck — the departure ledger is the membership (`riders.ts`). */
async function mintTruck(boxIds: string[], leg: { from: string; to: string; departedAt: string }) {
  const [batch] = await db
    .insert(batches)
    .values({
      code: `FST${RUN}-${made.batches.length}`,
      originWarehouseId: leg.from,
      destWarehouseId: leg.to,
      status: 'unloaded',
      departedAt: new Date(leg.departedAt),
      createdBy: actorId,
    })
    .returning();
  made.batches.push(batch!.id);
  await db.insert(boxMovements).values(
    boxIds.map((boxId) => ({
      boxId,
      fromWarehouseId: leg.from,
      toWarehouseId: leg.to,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batch!.id,
      actorId,
    })),
  );
  return { id: batch!.id, code: batch!.code };
}

/** A truck still FORMING — no departure, so the live pointer is its membership (`riders.ts`). */
async function mintFormingTruck(boxIds: string[], leg: { from: string; to: string }) {
  const [batch] = await db
    .insert(batches)
    .values({
      code: `FST${RUN}-${made.batches.length}`,
      originWarehouseId: leg.from,
      destWarehouseId: leg.to,
      status: 'loading',
      createdBy: actorId,
    })
    .returning();
  made.batches.push(batch!.id);
  await db.update(boxes).set({ currentBatchId: batch!.id, status: 'loading' }).where(inArray(boxes.id, boxIds));
  return { id: batch!.id, code: batch!.code };
}

/** One truck's landed cost by the fence's three parts: its own bills, «shu reysgacha», «keyingi yo'l». */
async function legsOf(batchId: string) {
  const lots = [...((await batchLandedCostTotals([batchId])).get(batchId)?.values() ?? [])];
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    own: round(lots.reduce((sum, lot) => sum + lot.batchUsd, 0)),
    prev: round(lots.reduce((sum, lot) => sum + (lot.totalUsd - lot.batchUsd - lot.laterUsd), 0)),
    later: round(lots.reduce((sum, lot) => sum + lot.laterUsd, 0)),
  };
}

async function bill(batchId: string, amount: number, over: Partial<Parameters<typeof addCostEntry>[0]> = {}, as = actorId) {
  const entry = await addCostEntry(
    {
      scope: 'batch',
      batchId,
      costTypeId: freightType,
      amount,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'freight',
      ...over,
    },
    ctx(as),
  );
  made.costs.push(entry.id);
  return entry;
}

/** The lot door's own correction of a one-carton mixed lot's weight. */
async function reweigh(lotId: string, kg: number, m3: number) {
  await editLot(
    {
      lotId,
      productNameZh: '测试货',
      productNameRu: '',
      boxCount: 1,
      totalWeightKg: kg,
      totalVolumeM3: m3,
      note: null,
    } as Parameters<typeof editLot>[0],
    manager(),
    ctx(),
  );
}

async function sweepPrivateZones() {
  const zones = (await db.selectDistinct({ zone: calcFreightTariffs.zone }).from(calcFreightTariffs))
    .map((r) => r.zone)
    .filter((z) => SWEEP.test(z));
  const mapped = (await db.select({ zone: warehouseTariffColumns.tariffZone }).from(warehouseTariffColumns))
    .map((r) => r.zone)
    .filter((z) => SWEEP.test(z));
  const all = [...new Set([...zones, ...mapped])];
  if (all.length) {
    await db.delete(warehouseTariffColumns).where(inArray(warehouseTariffColumns.tariffZone, all));
    await db.delete(calcFreightTariffs).where(inArray(calcFreightTariffs.zone, all));
  }
}

const mkUser = async (tail: string, name: string) =>
  (
    await db
      .insert(users)
      .values({ phone: `+99893${RUN}${tail}`, fullName: `FS ${name} ${RUN}`, passwordHash: 'x', active: true })
      .returning()
  )[0]!.id;

beforeAll(async () => {
  await sweepPrivateZones();
  actorId = await mkUser('1', 'manager');
  accountantId = await mkUser('2', 'buxgalter');
  vedId = await mkUser('3', 'VED');
  whW = await mintWarehouse(`SW${RUN}`.slice(0, 8), 'CN');
  whK = await mintWarehouse(`SK${RUN}`.slice(0, 8), 'CN');
  whD = await mintWarehouse(`SD${RUN}`.slice(0, 8), 'UZ');
  whE = await mintWarehouse(`SE${RUN}`.slice(0, 8), 'UZ');
  whF = await mintWarehouse(`SF${RUN}`.slice(0, 8), 'KZ');
  whG = await mintWarehouse(`SG${RUN}`.slice(0, 8), 'KZ');
  await db.insert(currencies).values({ code: NO_RATE, name: `FS no rate ${RUN}`, active: false }).onConflictDoNothing();
  freightType = (await db.query.costTypes.findFirst({ where: eq(costTypes.code, 'freight') }))!.id;
  const [k] = await db
    .insert(moneyAccounts)
    .values({ name: `FS kassa ${RUN}`, currency: 'USD' })
    .returning({ id: moneyAccounts.id });
  till = k!.id;
  // 1-100 $110, 101-500 $200, 501-999 $300, 1000+ $0.55/kg — round shares.
  await db.insert(calcFreightTariffs).values(
    (
      [
        [1, 100, 110, false],
        [101, 500, 200, false],
        [501, 999, 300, false],
        [1000, null, 0.55, true],
      ] as const
    ).map(([min, max, price, perKg]) => ({
      zone: ZONE,
      minDensity: min.toFixed(2),
      maxDensity: max === null ? null : max.toFixed(2),
      priceUsd: String(price),
      perKg,
      effectiveDate: TARIFF_DAY,
    })),
  );
  // W for the internal and the export legs, D for the Uzbek leg after, F for
  // the Kazakh leg after the second crossing.
  await db.transaction(async (tx) => {
    await setTariffColumnInTx(tx, whW, ZONE);
    await setTariffColumnInTx(tx, whK, ZONE);
    await setTariffColumnInTx(tx, whD, ZONE);
    await setTariffColumnInTx(tx, whF, ZONE);
  });
});

afterAll(async () => {
  await pgClient.end();
});

describe('10 — a held bill on the cargo’s OTHER leg is named on the truck whose tannarx it feeds', () => {
  it('«shu reysgacha»: an internal truck’s held bill is reported on the export truck, and fixing the lot moves the money in', async () => {
    const H = await mintClient('PH');
    const L = await mintClient('PL');
    const h = await mintLot(H, 600, 1); // 600 kg/m³ → $300 × 1 = 300
    const l = await mintLot(L, 1, 3); // 1 kg / 3 m³ → 0 kg/m³: HOLDS the bill
    const cargo = [...h.boxIds, ...l.boxIds];
    // T1: W → K, both ends in China (an internal leg); T2: K → D, crosses.
    const t1 = await mintTruck(cargo, { from: whW, to: whK, departedAt: '1648-03-10T08:00:00Z' });
    const t2 = await mintTruck(cargo, { from: whK, to: whD, departedAt: '1648-03-12T08:00:00Z' });

    const entry = await bill(t1.id, 100);
    expect(entry.verdict?.kind).toBe('held');

    expect(await carriedUnsplitBills(t2.id)).toEqual([
      {
        batchId: t1.id,
        code: t1.code,
        originWarehouseId: whW,
        destWarehouseId: whK,
        leg: 'prev',
        usd: 100,
        unconverted: 0,
        clientIds: [H, L].sort(),
      },
    ]);
    // The internal truck names its OWN bill on its own surfaces, never as
    // somebody else's leg.
    expect(await carriedUnsplitBills(t1.id)).toEqual([]);
    expect(await unsplitCountFor(t1.id, ALL_COSTS)).toBe(1);
    expect(await unsplitCountFor(t2.id, ALL_COSTS)).toBe(0);
    // «Partiya foydasi»'s ⚠ is the same sentence (`noShareSql`).
    const trips = await profitByBatch('1648-03-01', '1648-03-31');
    expect(trips.find((row) => row.batchId === t1.id)?.unallocatedUsd).toBe(100);
    // The export truck's tannarx is missing exactly that money.
    const prevOf = async () =>
      [...((await batchLandedCostTotals([t2.id])).get(t2.id)?.values() ?? [])].reduce(
        (sum, lot) => sum + (lot.totalUsd - lot.batchUsd - lot.laterUsd),
        0,
      );
    expect(await prevOf()).toBe(0);

    // The lot door re-splits T1's bill by itself; the warning is gone and
    // «shu reysgacha» carries the money.
    await reweigh(l.lotId, 300, 3); // 100 kg/m³ → $110 × 3 = 330
    expect(await carriedUnsplitBills(t2.id)).toEqual([]);
    expect(Math.round((await prevOf()) * 100) / 100).toBe(100);
  });

  it('«keyingi yo’l»: a held bill on the Uzbek leg AFTER the export truck is reported on the export truck', async () => {
    const H = await mintClient('LH');
    const L = await mintClient('LL');
    const h = await mintLot(H, 600, 1);
    const l = await mintLot(L, 1, 3);
    const cargo = [...h.boxIds, ...l.boxIds];
    // T2: W → D crosses (bears the price); T3: D → E, an Uzbek leg that does
    // not bear it — its road is T2's «keyingi yo'l».
    const t2 = await mintTruck(cargo, { from: whW, to: whD, departedAt: '1648-04-10T08:00:00Z' });
    const t3 = await mintTruck(cargo, { from: whD, to: whE, departedAt: '1648-04-12T08:00:00Z' });

    const entry = await bill(t3.id, 80);
    expect(entry.verdict?.kind).toBe('held');
    expect(await carriedUnsplitBills(t2.id)).toEqual([
      {
        batchId: t3.id,
        code: t3.code,
        originWarehouseId: whD,
        destWarehouseId: whE,
        leg: 'later',
        usd: 80,
        unconverted: 0,
        clientIds: [H, L].sort(),
      },
    ]);
    // T3 GIVES its cartons' road back to T2: nothing is this page's to name.
    expect(await carriedUnsplitBills(t3.id)).toEqual([]);

    await reweigh(l.lotId, 300, 3);
    expect(await carriedUnsplitBills(t2.id)).toEqual([]);
    const later = [...((await batchLandedCostTotals([t2.id])).get(t2.id)?.values() ?? [])].reduce(
      (sum, lot) => sum + lot.laterUsd,
      0,
    );
    expect(Math.round(later * 100) / 100).toBe(80);
  });
});

describe('11 — the Balans: a held yo’lkira bill is its own sentence, never «void it»', () => {
  it('a kassa-paid held bill leaves the line and noBox alone and lands in freightUnsplit; fixing the lot moves the share into the line', async () => {
    const P = await mintClient('BP');
    const U = await mintClient('BU');
    const p = await mintLot(P, 600, 1); // $300 × 1 = 300
    const u = await mintLot(U, 1, 3); // light — fixed below to 100 kg/m³: $110 × 3 = 330
    const t = await mintTruck([...p.boxIds, ...u.boxIds], { from: whW, to: whD, departedAt: '1648-05-10T08:00:00Z' });
    // P is priced on the truck: its share is never on the line. U is not.
    const charged = await addTransaction(
      { clientId: P, type: 'charge', amount: 500, currency: 'USD', txDate: tashkentDay(), batchId: t.id },
      ctx(),
    );
    made.charges.push((charged as { id: string }).id);
    made.charged.push(t.id);

    const before = (await companyBalance()).unpricedCargo;
    const lineBefore = (await companyBalance()).unpricedCargoUsd;
    const entry = await bill(t.id, 630, { accountId: till });
    expect(entry.verdict?.kind).toBe('held');

    const held = await companyBalance();
    expect(Math.round((held.unpricedCargoUsd - lineBefore) * 100) / 100).toBe(0);
    expect(held.unpricedCargo.noBox).toEqual(before.noBox);
    expect(held.unpricedCargo.freightUnsplit.count - before.freightUnsplit.count).toBe(1);
    expect(Math.round((held.unpricedCargo.freightUnsplit.usd - before.freightUnsplit.usd) * 100) / 100).toBe(630);
    expect(held.unpricedCargo.freightUnsplit.batchIds).toContain(t.id);
    // The profit link's `from`: no later than this truck's own departure day.
    expect(held.unpricedCargo.freightUnsplit.firstDeparted! <= '1648-05-10').toBe(true);

    await reweigh(u.lotId, 300, 3);
    const fixed = await companyBalance();
    expect(Math.round((fixed.unpricedCargoUsd - lineBefore) * 100) / 100).toBe(330);
    expect(fixed.unpricedCargo.freightUnsplit.count).toBe(before.freightUnsplit.count);
    expect(fixed.unpricedCargo.freightUnsplit.usd).toBe(before.freightUnsplit.usd);
    expect(fixed.unpricedCargo.noBox).toEqual(before.noBox);
  });
});

describe('12 — the truck card’s todo counts under the reader’s own sight', () => {
  it('the accountant’s held bill is 0 for the VED and 1 for her; the VED’s own is 1 for him', async () => {
    const accountant = costSightFor({ id: accountantId, permissions: new Set(['finance.manage', 'finance.reports']) });
    const ved = costSightFor({ id: vedId, permissions: new Set(['ved.docs', 'finance.manage']) });
    expect(accountant.ownOnly).toBeNull();
    expect(ved.ownOnly).toBe(vedId);

    const C = await mintClient('TC');
    const c = await mintLot(C, 1, 3);
    const t = await mintTruck(c.boxIds, { from: whW, to: whD, departedAt: '1648-07-10T08:00:00Z' });

    await bill(t.id, 40, {}, accountantId);
    expect(await unsplitCountFor(t.id, ved)).toBe(0);
    expect(await unsplitCountFor(t.id, accountant)).toBe(1);

    await bill(t.id, 25, {}, vedId);
    expect(await unsplitCountFor(t.id, ved)).toBe(1);
    expect(await unsplitCountFor(t.id, accountant)).toBe(2);

    // The Σ suffix: the whole sight reads both bills' dollars, the VED none.
    expect((await batchCostSheet(t.id, accountant)).unsplitUsd).toBe(65);
    expect((await batchCostSheet(t.id, ved)).unsplitUsd).toBeNull();
  });
});

describe('13 — the fence’s two windows also LEAVE OUT: a held bill outside them is not this page’s', () => {
  it('«shu reysgacha» stops at the carton’s previous non-internal truck: an earlier Uzbek leg that bore its own price is not named', async () => {
    const H = await mintClient('WH');
    const L = await mintClient('WL');
    // Walk-ins received in Andijan (D, UZ): EVERY Uzbek leg bears their price
    // (`bearsPriceSql`), so T3 and T5 each carry their own road.
    const h = await mintLot(H, 600, 1, whD);
    const l = await mintLot(L, 1, 3, whD);
    const cargo = [...h.boxIds, ...l.boxIds];
    const t3 = await mintTruck(cargo, { from: whD, to: whE, departedAt: '1648-08-10T08:00:00Z' });
    const t5 = await mintTruck(cargo, { from: whE, to: whD, departedAt: '1648-08-12T08:00:00Z' });

    const entry = await bill(t3.id, 70);
    expect(entry.verdict?.kind).toBe('held');
    expect(await unsplitCountFor(t3.id, ALL_COSTS)).toBe(1);
    // T3 departed before T5 — inside «departed ≤ this one» — but it IS the
    // cartons' previous non-internal truck (`m.prev_at`), so its money was
    // never T5's tannarx and its held bill is not T5's to name.
    expect(await carriedUnsplitBills(t5.id)).toEqual([]);
    // Nor is T5 a later leg of T3: it bears its own price.
    expect(await carriedUnsplitBills(t3.id)).toEqual([]);

    // The fence agrees: split, T3's money stays on T3 and none of it reaches T5.
    await reweigh(l.lotId, 300, 3);
    expect(await unsplitCountFor(t3.id, ALL_COSTS)).toBe(0);
    expect(await legsOf(t3.id)).toEqual({ own: 70, prev: 0, later: 0 });
    expect(await legsOf(t5.id)).toEqual({ own: 0, prev: 0, later: 0 });
  });

  it('«keyingi yo’l» stops at the NEXT price-bearing truck: a held bill on the leg after it is that truck’s, never the first one’s', async () => {
    const H = await mintClient('UH');
    const L = await mintClient('UL');
    const h = await mintLot(H, 600, 1);
    const l = await mintLot(L, 1, 3);
    const cargo = [...h.boxIds, ...l.boxIds];
    // China cargo. T2 crosses (W, CN → D, UZ) and bears its price; T3 is the
    // Uzbek leg after it (T2's road). T4 crosses again (E, UZ → F, KZ) and
    // bears it from there; T5 is the Kazakh leg after T4 (T4's road).
    const t2 = await mintTruck(cargo, { from: whW, to: whD, departedAt: '1648-09-10T08:00:00Z' });
    const t3 = await mintTruck(cargo, { from: whD, to: whE, departedAt: '1648-09-12T08:00:00Z' });
    const t4 = await mintTruck(cargo, { from: whE, to: whF, departedAt: '1648-09-14T08:00:00Z' });
    const t5 = await mintTruck(cargo, { from: whF, to: whG, departedAt: '1648-09-16T08:00:00Z' });

    expect((await bill(t3.id, 60)).verdict?.kind).toBe('held');
    expect((await bill(t5.id, 50)).verdict?.kind).toBe('held');
    const later = (t: { id: string; code: string }, from: string, to: string, usd: number) => ({
      batchId: t.id,
      code: t.code,
      originWarehouseId: from,
      destWarehouseId: to,
      leg: 'later',
      usd,
      unconverted: 0,
      clientIds: [H, L].sort(),
    });
    // T2's road runs to T3 (`m.upto`) and no further: T5 departed after T2
    // but beyond T4, which took the price over.
    expect(await carriedUnsplitBills(t2.id)).toEqual([later(t3, whD, whE, 60)]);
    // And T4 names T5 — never T3, which lies before its previous
    // non-internal departure (the other window, from the other side).
    expect(await carriedUnsplitBills(t4.id)).toEqual([later(t5, whF, whG, 50)]);

    // The fence agrees once both split: T2 carries T3's road, T4 carries T5's.
    await reweigh(l.lotId, 300, 3);
    expect(await carriedUnsplitBills(t2.id)).toEqual([]);
    expect(await carriedUnsplitBills(t4.id)).toEqual([]);
    expect(await legsOf(t2.id)).toEqual({ own: 0, prev: 0, later: 60 });
    expect(await legsOf(t4.id)).toEqual({ own: 0, prev: 0, later: 50 });
  });
});

describe('14 — a feeding truck’s bill with no rate yet is named too: no dollars, counted', () => {
  it('an unconverted bill on the internal leg is reported on the export truck with usd null and unconverted 1', async () => {
    const H = await mintClient('RH');
    const L = await mintClient('RL');
    // Both heavy: it is the RATE that keeps the bill off the boxes, not the cargo.
    const h = await mintLot(H, 600, 1);
    const l = await mintLot(L, 600, 1);
    const cargo = [...h.boxIds, ...l.boxIds];
    const t1 = await mintTruck(cargo, { from: whW, to: whK, departedAt: '1648-10-10T08:00:00Z' });
    const t2 = await mintTruck(cargo, { from: whK, to: whD, departedAt: '1648-10-12T08:00:00Z' });

    const entry = await bill(t1.id, 900, { currency: NO_RATE });
    expect(entry.amountUsd).toBeNull();
    expect(entry.verdict?.kind).toBe('unconverted');
    // Not «on no box» in `noShareSql`'s words — it has no dollars to put on one.
    expect(await unsplitCountFor(t1.id, ALL_COSTS)).toBe(0);
    expect(await carriedUnsplitBills(t2.id)).toEqual([
      {
        batchId: t1.id,
        code: t1.code,
        originWarehouseId: whW,
        destWarehouseId: whK,
        leg: 'prev',
        usd: null,
        unconverted: 1,
        clientIds: [H, L].sort(),
      },
    ]);
  });
});

describe('15 — a direct bill on a feeding truck is its OWN client’s money', () => {
  it('names only that client, and a truck that carries none of that client’s cargo is not told at all', async () => {
    const H = await mintClient('DH');
    const L = await mintClient('DL');
    const M = await mintClient('DM');
    const h = await mintLot(H, 600, 1);
    const l = await mintLot(L, 600, 1);
    const m = await mintLot(M, 600, 1);
    // T1 (internal) carries all three; T2 takes H and L across, T2b takes M.
    const t1 = await mintTruck([...h.boxIds, ...l.boxIds, ...m.boxIds], {
      from: whW,
      to: whK,
      departedAt: '1648-11-10T08:00:00Z',
    });
    const t2 = await mintTruck([...h.boxIds, ...l.boxIds], { from: whK, to: whD, departedAt: '1648-11-12T08:00:00Z' });
    const t2b = await mintTruck(m.boxIds, { from: whK, to: whE, departedAt: '1648-11-13T08:00:00Z' });

    // A direct bill whose client rode sits on no box only while it has no
    // rate: with dollars it splits over that client's cartons.
    const entry = await bill(t1.id, 45, { currency: NO_RATE, allocationBasis: 'direct_to_client', clientId: L });
    expect(entry.verdict?.kind).toBe('unconverted');
    // Missing from L's tannarx alone — H rode T1 and T2 too and loses nothing.
    expect(await carriedUnsplitBills(t2.id)).toEqual([
      {
        batchId: t1.id,
        code: t1.code,
        originWarehouseId: whW,
        destWarehouseId: whK,
        leg: 'prev',
        usd: null,
        unconverted: 1,
        clientIds: [L],
      },
    ]);
    // M's cartons rode T1 as well, but L is not aboard T2b: nothing of T2b's
    // tannarx is missing, so the truck is not reported at all.
    expect(await carriedUnsplitBills(t2b.id)).toEqual([]);
  });
});

describe('16 — trucks that have not left: the «bo’linmagan» list names them beside the departed table', () => {
  it('a held bill on a FORMING truck is listed with its dollars; a departed truck’s and a cancelled one’s are not', async () => {
    const A = await mintClient('NA');
    const B = await mintClient('NB');
    const C = await mintClient('NC');
    const a = await mintLot(A, 1, 3);
    const b = await mintLot(B, 1, 3);
    const c = await mintLot(C, 1, 3);
    const forming = await mintFormingTruck(a.boxIds, { from: whW, to: whD });
    const departed = await mintTruck(b.boxIds, { from: whW, to: whD, departedAt: '1648-12-10T08:00:00Z' });
    const dropped = await mintFormingTruck(c.boxIds, { from: whW, to: whE });

    expect((await bill(forming.id, 40)).verdict?.kind).toBe('held');
    expect((await bill(departed.id, 30)).verdict?.kind).toBe('held');
    expect((await bill(dropped.id, 20)).verdict?.kind).toBe('held');
    // `cancelBatch` refuses a truck with a live cost (batch_has_costs), so the
    // status clause is a belt — the state is written directly.
    await db.update(batches).set({ status: 'cancelled' }).where(eq(batches.id, dropped.id));

    const mine = [forming.id, departed.id, dropped.id];
    expect((await unsplitOnFormingTrucks()).filter((row) => mine.includes(row.batchId))).toEqual([
      { batchId: forming.id, code: forming.code, originWarehouseId: whW, destWarehouseId: whD, count: 1, usd: 40 },
    ]);
    // The same bill the forming truck's own todo counts.
    expect(await unsplitCountFor(forming.id, ALL_COSTS)).toBe(1);
  });
});

describe('cleanup', () => {
  it('FINAL — deletes the run’s column, tariff rows, costs, charges and no-rate currency; deactivates the rest; no prefixed zone left', async () => {
    await db.transaction(async (tx) => {
      await tx.delete(warehouseTariffColumns).where(like(warehouseTariffColumns.tariffZone, `t\\_%${RUN}\\_wten`));
      await tx
        .delete(warehouseTariffColumns)
        .where(inArray(warehouseTariffColumns.warehouseId, [whW, whK, whD, whE, whF, whG]));
      if (made.costs.length) await tx.delete(costEntries).where(inArray(costEntries.id, made.costs));
      await tx.delete(calcFreightTariffs).where(like(calcFreightTariffs.zone, `t\\_%${RUN}\\_wten`));
    });
    if (made.charges.length) {
      await db
        .update(clientTransactions)
        .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' })
        .where(inArray(clientTransactions.id, made.charges));
    }
    const lotIds = (
      await db.select({ id: receiptLots.id }).from(receiptLots).where(inArray(receiptLots.receiptId, made.receipts))
    ).map((r) => r.id);
    if (lotIds.length) {
      const boxIds = (await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))).map((b) => b.id);
      if (boxIds.length) {
        await db.delete(events).where(inArray(events.entityId, boxIds));
        await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
        await db.delete(boxes).where(inArray(boxes.id, boxIds));
      }
      await db.delete(events).where(inArray(events.entityId, lotIds));
      await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
    }
    if (made.receipts.length) {
      await db.delete(events).where(inArray(events.entityId, made.receipts));
      await db.delete(receipts).where(inArray(receipts.id, made.receipts));
    }
    const gone = made.batches.filter((id) => !made.charged.includes(id));
    if (gone.length) await db.delete(batches).where(inArray(batches.id, gone));
    if (made.charged.length) {
      await db.update(batches).set({ status: 'cancelled' }).where(inArray(batches.id, made.charged));
    }
    await db.update(clients).set({ active: false }).where(inArray(clients.id, made.clients));
    await db.update(moneyAccounts).set({ active: false, openingDate: null }).where(eq(moneyAccounts.id, till));
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whW, whK, whD, whE, whF, whG]));
    // The no-rate currency goes once nothing names it — a killed run's bills
    // would keep it (inactive) until a run that can delete them.
    await db.execute(sql`
      DELETE FROM currencies c
       WHERE c.code = ${NO_RATE}
         AND NOT EXISTS (SELECT 1 FROM cost_entries ce WHERE ce.currency = c.code)`);
    await db.update(users).set({ active: false }).where(inArray(users.id, [actorId, accountantId, vedId]));
    const left = await db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM calc_freight_tariffs WHERE zone LIKE ${`t\\_%${RUN}\\_wten`})
           + (SELECT count(*) FROM warehouse_tariff_columns WHERE tariff_zone LIKE ${`t\\_%${RUN}\\_wten`}) AS n
    `);
    expect(Number(left[0]!.n)).toBe(0);
  });
});
