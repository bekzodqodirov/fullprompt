import 'dotenv/config';
import ExcelJS from 'exceljs';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  calcFreightTariffs,
  clients,
  costEntries,
  costTypes,
  dealStages,
  deals,
  events,
  receiptLots,
  receipts,
  users,
  warehouses,
  warehouseTariffColumns,
} from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { addCostEntry } from '@/modules/wms/costing/service';
import { setTariffColumnInTx } from '@/modules/wms/costing/tariff-column';
import { editLot } from '@/modules/wms/receipts/edit';
import { clientProfitGaps, pnlGaps, profitAndLoss, profitByClient } from '@/modules/wms/accounting/reports';
import { buildPnlXlsx, buildProfitXlsx } from '@/modules/wms/accounting/xlsx';
import { heldFreightCosts, landedCostByClient } from '@/modules/wms/reports/queries';
import { buildLandedCostXlsx } from '@/modules/wms/reports/xlsx';
import { reportLabels } from '@/modules/wms/reports/labels';
import { dealProfit } from '@/modules/wms/deals/service';

/**
 * Four money screens that read «money on no box» and must not misname a HELD
 * yo'lkira bill (his rule 6: saved, converted, not split — docs/YOLKIRA-
 * TAQSIMOT.md §6): the P&L's gap note, «Mijoz foydasi»'s unallocated note,
 * the landed-cost report's caveat and the deal card's profit. Each splits it
 * out by the one fragment, `heldFreightSql`, and each test watches the bill
 * leave the warning the moment the lot is fixed (the cure is the lot, never
 * a void — §6.7).
 *
 * Money parked in 1649 (no other file's year), one month per test, so every
 * period read is this file's alone. Tariff rows and the warehouse column under
 * ONE private run prefix `t_<n><run>_wfhr`, swept before and deleted as a
 * FINAL TEST (#824) — a column is CONFIGURATION (#183). The landed-cost
 * report is all-time and company-wide, so its figures are DELTAS: CI runs
 * every file on one database. The private warehouses, clients and users are
 * deactivated, never deleted (audit FK).
 */
const RUN = String(Date.now()).slice(-6);
let counter = 0;
const ZONE = `t_${(counter += 1)}${RUN}_wfhr`;
const SWEEP = /^t_[0-9a-z]+_wfhr$/;
const TARIFF_DAY = '1649-01-01';

let actorId = '';
let freightType = '';
let whW = '';
let whD = '';
const made = {
  receipts: [] as string[],
  batches: [] as string[],
  costs: [] as string[],
  clients: [] as string[],
  deals: [] as string[],
};
let seq = 0;

const ctx = () => ({ actorId, ip: null, userAgent: null });
const manager = () =>
  ({
    id: actorId,
    fullName: `FH manager ${RUN}`,
    roles: ['warehouse_manager'],
    permissions: new Set(['receipts.edit', 'receipts.void']),
  }) as unknown as Actor;
const cents = (n: number) => Math.round(n * 100) / 100;

async function mintWarehouse(code: string, country: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, name: `FH ${code}`, country, type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
    .returning();
  return row!.id;
}

async function mintClient(label: string) {
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `H${label}${RUN}`.slice(0, 10), name: `FH ${label} ${RUN}` })
    .returning();
  made.clients.push(c!.id);
  return c!.id;
}

/** A confirmed prixod at W with one MIXED lot of one carton (totals), on `dealId` when given. */
async function mintLot(client: string, kg: number, m3: number, dealId: string | null = null) {
  const [receipt] = await db
    .insert(receipts)
    .values({ warehouseId: whW, clientId: client, dealId, status: 'confirmed', confirmedAt: new Date(), createdBy: actorId })
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
    .values({ lotId: lot!.id, shortCode: `FH${RUN}-${(seq += 1)}`, seqInLot: 1, status: 'in_stock', currentWarehouseId: whW })
    .returning();
  return { receiptId: receipt!.id, lotId: lot!.id, boxIds: [box!.id] };
}

/** A departed W → D truck (it crosses, so it bears the price) — the departure ledger is the membership. */
async function mintTruck(boxIds: string[], departedAt: string) {
  const [batch] = await db
    .insert(batches)
    .values({
      code: `FHT${RUN}-${made.batches.length}`,
      originWarehouseId: whW,
      destWarehouseId: whD,
      status: 'unloaded',
      departedAt: new Date(departedAt),
      createdBy: actorId,
    })
    .returning();
  made.batches.push(batch!.id);
  if (boxIds.length) {
    await db.insert(boxMovements).values(
      boxIds.map((boxId) => ({
        boxId,
        fromWarehouseId: whW,
        toWarehouseId: whD,
        fromStatus: 'loading',
        toStatus: 'in_transit',
        cause: 'batch_departed',
        refType: 'batch',
        refId: batch!.id,
        actorId,
      })),
    );
  }
  return { id: batch!.id, code: batch!.code };
}

/** A truck still forming with NOTHING aboard — a bill on it sits on no box («yuki yo'q mashina»). */
async function mintEmptyTruck() {
  const [batch] = await db
    .insert(batches)
    .values({
      code: `FHT${RUN}-${made.batches.length}`,
      originWarehouseId: whW,
      destWarehouseId: whD,
      status: 'loading',
      createdBy: actorId,
    })
    .returning();
  made.batches.push(batch!.id);
  return { id: batch!.id, code: batch!.code };
}

async function bill(
  batchId: string,
  amount: number,
  costDate: string,
  basis: 'freight' | 'weight' | 'direct_to_client' = 'freight',
  clientId: string | null = null,
) {
  const entry = await addCostEntry(
    {
      scope: 'batch',
      batchId,
      costTypeId: freightType,
      amount,
      currency: 'USD',
      costDate,
      allocationBasis: basis,
      ...(clientId ? { clientId } : {}),
    },
    ctx(),
  );
  made.costs.push(entry.id);
  return entry;
}

/** The lot door's own correction of a one-carton mixed lot — it re-splits every cost touching the lot. */
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

/**
 * The light pair every test holds a bill over: H at 600 kg/m³ ($300 × 1 m³),
 * L at 1 kg / 3 m³ = 0 kg/m³ (under 10 — the bill is HELD). Fixing L to
 * 300 kg / 3 m³ = 100 kg/m³ ($110 × 3) splits a $100 bill 300 : 330.
 */
async function lightPair(prefix: string, departedAt: string, dealId: string | null = null) {
  const H = await mintClient(`${prefix}H`);
  const L = await mintClient(`${prefix}L`);
  const h = await mintLot(H, 600, 1, dealId);
  const l = await mintLot(L, 1, 3);
  const truck = await mintTruck([...h.boxIds, ...l.boxIds], departedAt);
  return { H, L, h, l, truck };
}

async function sheetRows(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const out: unknown[][] = [];
  workbook.worksheets[0]!.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
  return out;
}
const texts = (rows: unknown[][]) => rows.map((row) => String(row[0] ?? ''));

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

beforeAll(async () => {
  await sweepPrivateZones();
  actorId = (
    await db
      .insert(users)
      .values({ phone: `+99898${RUN}1`, fullName: `FH manager ${RUN}`, passwordHash: 'x', active: true })
      .returning()
  )[0]!.id;
  whW = await mintWarehouse(`HW${RUN}`.slice(0, 8), 'CN');
  whD = await mintWarehouse(`HD${RUN}`.slice(0, 8), 'UZ');
  freightType = (await db.query.costTypes.findFirst({ where: eq(costTypes.code, 'freight') }))!.id;
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
  await db.transaction(async (tx) => {
    await setTariffColumnInTx(tx, whW, ZONE);
  });
});

afterAll(async () => {
  await pgClient.end();
});

describe('1 — the P&L’s gap note: a held yo’lkira bill is its own figure, «on no box» keeps every other basis', () => {
  const FROM = '1649-06-01';
  const TO = '1649-06-30';

  it('a held bill lands in freightHeld and never in onNoBox; an empty truck’s weight bill stays in onNoBox; the file says both apart', async () => {
    const before = await pnlGaps(FROM, TO);
    const { l, truck } = await lightPair('P', '1649-06-10T08:00:00Z');
    expect((await bill(truck.id, 100, '1649-06-14')).verdict?.kind).toBe('held');
    const empty = await mintEmptyTruck();
    expect((await bill(empty.id, 40, '1649-06-15', 'weight')).verdict?.kind).toBe('nothing');
    // A yo'lkira bill typed before the loading: freight basis, but its truck
    // carries nothing — the pool's «nothing», never «held» (review of the
    // build: keyed on the basis alone it was told «do not void, fix the lot»).
    expect((await bill(empty.id, 15, '1649-06-15', 'freight')).verdict?.kind).toBe('nothing');

    const after = await pnlGaps(FROM, TO);
    expect(after.freightHeld.count - before.freightHeld.count).toBe(1);
    expect(cents(after.freightHeld.usd - before.freightHeld.usd)).toBe(100);
    // «On no box» keeps its old meaning for every bill that is not held —
    // the empty truck's weight AND freight bills — and only those.
    expect(after.onNoBox.count - before.onNoBox.count).toBe(2);
    expect(cents(after.onNoBox.usd - before.onNoBox.usd)).toBe(55);

    // The file carries the held bill under its own words, and «on no box»
    // counts exactly the screen's figure.
    const L = reportLabels('uz');
    const file = texts(await sheetRows(await buildPnlXlsx(FROM, TO, 'uz')));
    expect(file).toContain(`⚠ ${L.gapFreightHeld}: ${after.freightHeld.count} · $${after.freightHeld.usd.toFixed(2)}`);
    expect(file).toContain(`⚠ ${L.gapNoBox}: ${after.onNoBox.count} · $${after.onNoBox.usd.toFixed(2)}`);

    // The cure is the lot: fixing it splits the bill and it leaves the note.
    await reweigh(l.lotId, 300, 3);
    const fixed = await pnlGaps(FROM, TO);
    expect(fixed.freightHeld.count - before.freightHeld.count).toBe(0);
    expect(cents(fixed.freightHeld.usd - before.freightHeld.usd)).toBe(0);
    expect(fixed.onNoBox.count - before.onNoBox.count).toBe(2);
  });
});

describe('2 — «Mijoz foydasi»: a held bill is its own bucket, never «yuki yo’q mashina»', () => {
  const FROM = '1649-07-01';
  const TO = '1649-07-31';

  it('the held bill leaves the batch scope for heldFreight; the total still reconciles to the P&L; the file names the bucket', async () => {
    const before = await clientProfitGaps(FROM, TO);
    const scopeOf = (gaps: typeof before, scope: string) =>
      gaps.unallocated.byScope.find((row) => row.scope === scope) ?? { usd: 0, count: 0 };
    const { l, truck } = await lightPair('C', '1649-07-10T08:00:00Z');
    expect((await bill(truck.id, 100, '1649-07-14')).verdict?.kind).toBe('held');
    const empty = await mintEmptyTruck();
    expect((await bill(empty.id, 40, '1649-07-15', 'weight')).verdict?.kind).toBe('nothing');
    // A yo'lkira bill on the empty truck IS «yuki yo'q mashina», whatever its basis.
    expect((await bill(empty.id, 15, '1649-07-15', 'freight')).verdict?.kind).toBe('nothing');

    const after = await clientProfitGaps(FROM, TO);
    expect(after.unallocated.heldFreight.count - before.unallocated.heldFreight.count).toBe(1);
    expect(cents(after.unallocated.heldFreight.usd - before.unallocated.heldFreight.usd)).toBe(100);
    // The truck with no cargo is the batch scope's alone — both of its bills.
    expect(scopeOf(after, 'batch').count - scopeOf(before, 'batch').count).toBe(2);
    expect(cents(scopeOf(after, 'batch').usd - scopeOf(before, 'batch').usd)).toBe(55);
    // The total is still every dollar that reached no client …
    expect(after.unallocated.count - before.unallocated.count).toBe(3);
    expect(cents(after.unallocated.usd - before.unallocated.usd)).toBe(155);
    const parts = after.unallocated.byScope.reduce((sum, row) => sum + row.usd, 0) + after.unallocated.heldFreight.usd;
    expect(cents(parts)).toBe(after.unallocated.usd);
    // … so the tab still reconciles to the P&L (U19).
    const rows = await profitByClient(FROM, TO);
    const pnl = await profitAndLoss(FROM, TO);
    const rowCost = rows.reduce((sum, row) => sum + row.costUsd, 0);
    expect(cents(rowCost + after.unclaimed.usd + after.unallocated.usd)).toBe(pnl.directTotal.total);

    const L = reportLabels('uz');
    const note = texts(await sheetRows(await buildProfitXlsx('client', FROM, TO, 'uz'))).find((row) =>
      row.startsWith(`⚠ ${L.clientUnallocatedNote}:`),
    );
    expect(note).toContain(`${L.gapScopeBatch} ×${scopeOf(after, 'batch').count}`);
    expect(note).toContain(
      `${L.gapScopeFreightHeld} ×${after.unallocated.heldFreight.count} ($${after.unallocated.heldFreight.usd.toFixed(2)})`,
    );

    // Fixed lot: the bucket empties and the money reaches the clients.
    await reweigh(l.lotId, 300, 3);
    const fixed = await clientProfitGaps(FROM, TO);
    expect(fixed.unallocated.heldFreight.count - before.unallocated.heldFreight.count).toBe(0);
    expect(cents(fixed.unallocated.usd - before.unallocated.usd)).toBe(55);
  });
});

describe('3 — the landed-cost report names held bills with count and dollars, on screen and in the file', () => {
  it('a held bill is counted until the lot is fixed, when its dollars appear in the clients’ rows', async () => {
    const before = await heldFreightCosts();
    const { H, L, l, truck } = await lightPair('L', '1649-08-10T08:00:00Z');
    expect((await bill(truck.id, 100, '1649-08-14')).verdict?.kind).toBe('held');

    const after = await heldFreightCosts();
    expect(after.count - before.count).toBe(1);
    expect(cents(after.usd - before.usd)).toBe(100);
    const landedOf = async () =>
      cents(
        (await landedCostByClient())
          .filter((row) => row.clientId === H || row.clientId === L)
          .reduce((sum, row) => sum + row.totalUsd, 0),
      );
    // The clients the bill is held over read short by the whole of it.
    expect(await landedOf()).toBe(0);

    const labels = reportLabels('uz');
    // The builder's own formatting: the figure is all-time and company-wide,
    // so on a long-lived database it can pass $1,000 (review of the tests).
    const usdText = after.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const line = `⚠ ${labels.landedFreightHeld}: ${after.count} · $${usdText}`;
    expect(texts(await sheetRows(await buildLandedCostXlsx(undefined, 'uz')))).toContain(line);
    // The drill-down is the same report: the same caveat.
    expect(texts(await sheetRows(await buildLandedCostXlsx(H, 'uz')))).toContain(line);

    await reweigh(l.lotId, 300, 3);
    const fixed = await heldFreightCosts();
    expect(fixed.count - before.count).toBe(0);
    expect(cents(fixed.usd - before.usd)).toBe(0);
    expect(await landedOf()).toBe(100);
  });
});

describe('4 — the deal card: a held bill on a truck the deal’s cartons rode is named; the profit arithmetic is untouched', () => {
  it('names the truck and its dollars, not a truck the cartons never rode; fixing the lot moves the share into the cost', async () => {
    const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
    const owner = await mintClient('DO');
    const [deal] = await db
      .insert(deals)
      .values({ code: `FH-${RUN}`, clientId: owner, stageId: stage!.id, title: `FH ${RUN}`, createdBy: actorId })
      .returning({ id: deals.id });
    made.deals.push(deal!.id);
    const { l, truck } = await lightPair('D', '1649-09-10T08:00:00Z', null);
    // The deal's own carton rides the light truck beside H and L.
    const mine = await mintLot(owner, 600, 1, deal!.id);
    await db.insert(boxMovements).values({
      boxId: mine.boxIds[0]!,
      fromWarehouseId: whW,
      toWarehouseId: whD,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: truck.id,
      actorId,
    });
    expect((await bill(truck.id, 100, '1649-09-14')).verdict?.kind).toBe('held');
    // A held bill on a truck the deal's cartons never rode is not this deal's.
    const stranger = await mintClient('DS');
    const s = await mintLot(stranger, 1, 3);
    const other = await mintTruck(s.boxIds, '1649-09-11T08:00:00Z');
    expect((await bill(other.id, 70, '1649-09-14')).verdict?.kind).toBe('held');
    // Money on no box beside the held bill, on the deal's own truck, that is
    // NOT a held yo'lkira bill: a direct fee for a client with no carton
    // aboard (the pool's «nothing») — never named here.
    expect((await bill(truck.id, 25, '1649-09-14', 'direct_to_client', stranger)).verdict?.kind).toBe('nothing');

    // The trucks are the bill's own RIDERS (review of the build): a carton
    // that rode with no load scan — the unloader took it off — counts …
    const light2 = await mintLot(await mintClient('D2'), 1, 3);
    const unscanned = await mintTruck(light2.boxIds, '1649-09-12T08:00:00Z');
    const mine2 = await mintLot(owner, 600, 1, deal!.id);
    await db.insert(boxMovements).values({
      boxId: mine2.boxIds[0]!,
      fromWarehouseId: whW,
      toWarehouseId: whD,
      fromStatus: 'in_stock',
      toStatus: 'ready_for_pickup',
      cause: 'undocumented_transfer',
      refType: 'batch',
      refId: unscanned.id,
      actorId,
    });
    expect((await bill(unscanned.id, 40, '1649-09-14')).verdict?.kind).toBe('held');
    // … and a carton found back at the origin after it departed does not.
    const light3 = await mintLot(await mintClient('D3'), 1, 3);
    const mine3 = await mintLot(owner, 600, 1, deal!.id);
    const foundBack = await mintTruck([...light3.boxIds, ...mine3.boxIds], '1649-09-13T08:00:00Z');
    await db.insert(boxMovements).values({
      boxId: mine3.boxIds[0]!,
      fromWarehouseId: whD,
      toWarehouseId: whW,
      fromStatus: 'in_transit',
      toStatus: 'in_stock',
      cause: 'found_at_origin',
      refType: 'batch',
      refId: foundBack.id,
      actorId,
    });
    expect((await bill(foundBack.id, 30, '1649-09-14')).verdict?.kind).toBe('held');

    const held = await dealProfit(deal!.id);
    const byTruck = (rows: typeof held.heldFreight) => [...rows].sort((a, b) => a.batchId.localeCompare(b.batchId));
    expect(byTruck(held.heldFreight)).toEqual(
      byTruck([
        { batchId: truck.id, code: truck.code, originWarehouseId: whW, destWarehouseId: whD, count: 1, usd: 100 },
        { batchId: unscanned.id, code: unscanned.code, originWarehouseId: whW, destWarehouseId: whD, count: 1, usd: 40 },
      ]),
    );
    // Said, never folded in: the cost is the allocations, and there are none.
    expect(held).toMatchObject({ revenueUsd: 0, costUsd: 0, profitUsd: 0 });

    // H 300 + the deal's carton 300 + L 330 (fixed): the deal's share is 300/930 of $100.
    await reweigh(l.lotId, 300, 3);
    const fixed = await dealProfit(deal!.id);
    expect(fixed.heldFreight.map((row) => row.batchId)).toEqual([unscanned.id]);
    expect(fixed.costUsd).toBe(32.26);
    expect(fixed.profitUsd).toBe(-32.26);
  });
});

describe('cleanup', () => {
  it('FINAL — deletes the run’s column, tariff rows, costs and cargo; deactivates the rest; no prefixed zone left', async () => {
    await db.transaction(async (tx) => {
      await tx.delete(warehouseTariffColumns).where(like(warehouseTariffColumns.tariffZone, `t\\_%${RUN}\\_wfhr`));
      await tx.delete(warehouseTariffColumns).where(inArray(warehouseTariffColumns.warehouseId, [whW, whD]));
      if (made.costs.length) await tx.delete(costEntries).where(inArray(costEntries.id, made.costs));
      await tx.delete(calcFreightTariffs).where(like(calcFreightTariffs.zone, `t\\_%${RUN}\\_wfhr`));
    });
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
    if (made.deals.length) await db.delete(deals).where(inArray(deals.id, made.deals));
    if (made.batches.length) await db.delete(batches).where(inArray(batches.id, made.batches));
    await db.update(clients).set({ active: false }).where(inArray(clients.id, made.clients));
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whW, whD]));
    await db.update(users).set({ active: false }).where(eq(users.id, actorId));
    const left = await db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM calc_freight_tariffs WHERE zone LIKE ${`t\\_%${RUN}\\_wfhr`})
           + (SELECT count(*) FROM warehouse_tariff_columns WHERE tariff_zone LIKE ${`t\\_%${RUN}\\_wfhr`}) AS n
    `);
    expect(Number(left[0]!.n)).toBe(0);
    expect(
      (await db.select({ id: costEntries.id }).from(costEntries).where(inArray(costEntries.id, made.costs))).length,
    ).toBe(0);
  });
});
