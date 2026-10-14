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
 * - 12: as the truck card's todo, under the reader's own sight.
 *
 * Money parked in 1648 (no other file's year), so the trucks fall in no
 * other file's profit window. Tariff columns under ONE private run prefix
 * `t_<n><run>_wten`, swept before and deleted as a FINAL TEST (#824). A
 * warehouse column is CONFIGURATION (#183); the private warehouses and the
 * kassa are deactivated, never deleted (audit FK). Every Balans figure is a
 * DELTA: CI runs every file on one database.
 */
const RUN = String(Date.now()).slice(-6);
let counter = 0;
const ZONE = `t_${(counter += 1)}${RUN}_wten`;
const SWEEP = /^t_[0-9a-z]+_wten$/;
const TARIFF_DAY = '1648-01-01';
const DAY = '1648-06-14';

let actorId = '';
let accountantId = '';
let vedId = '';
let freightType = '';
let till = '';
let whW = '';
let whK = '';
let whD = '';
let whE = '';
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

/** A confirmed prixod at W with one MIXED lot of one carton (totals). */
async function mintLot(client: string, kg: number, m3: number) {
  const [receipt] = await db
    .insert(receipts)
    .values({ warehouseId: whW, clientId: client, status: 'confirmed', confirmedAt: new Date(), createdBy: actorId })
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
    .values({ lotId: lot!.id, shortCode: `FS${RUN}-${(seq += 1)}`, seqInLot: 1, status: 'in_stock', currentWarehouseId: whW })
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
  // W for the internal and the export legs, D for the Uzbek leg after.
  await db.transaction(async (tx) => {
    await setTariffColumnInTx(tx, whW, ZONE);
    await setTariffColumnInTx(tx, whK, ZONE);
    await setTariffColumnInTx(tx, whD, ZONE);
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

describe('cleanup', () => {
  it('FINAL — deletes the run’s column, tariff rows, costs and charges; deactivates the rest; no prefixed zone left', async () => {
    await db.transaction(async (tx) => {
      await tx.delete(warehouseTariffColumns).where(like(warehouseTariffColumns.tariffZone, `t\\_%${RUN}\\_wten`));
      await tx.delete(warehouseTariffColumns).where(inArray(warehouseTariffColumns.warehouseId, [whW, whK, whD, whE]));
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
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whW, whK, whD, whE]));
    await db.update(users).set({ active: false }).where(inArray(users.id, [actorId, accountantId, vedId]));
    const left = await db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM calc_freight_tariffs WHERE zone LIKE ${`t\\_%${RUN}\\_wten`})
           + (SELECT count(*) FROM warehouse_tariff_columns WHERE tariff_zone LIKE ${`t\\_%${RUN}\\_wten`}) AS n
    `);
    expect(Number(left[0]!.n)).toBe(0);
  });
});
