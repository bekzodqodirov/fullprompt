import 'dotenv/config';
import ExcelJS from 'exceljs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxes,
  clientTransactions,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { confirmReceipt, markBoxLost } from '@/modules/wms/receipts/service';
import { assignReceiptClient } from '@/modules/wms/receipts/edit';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ingestLoadScans } from '@/modules/wms/scanning/service';
import { finishUnload, ingestUnloadScans, resolveMissing } from '@/modules/wms/scanning/unload';
import { acceptFoundBox } from '@/modules/wms/inventory/service';
import { issueBoxes } from '@/modules/wms/issue/service';
import { returnUnclaimedToSender } from '@/modules/wms/unclaimed/return';
import {
  addCostEntry,
  addReceiptCostsBulk,
  batchClientCostBreakdown,
  batchCostSheet,
  batchLandedCostByClient,
  batchLandedCostByLot,
  batchReceiptRows,
  boxLandedCost,
  recomputeAll,
} from '@/modules/wms/costing/service';
import { applyRiderRepair, riderRepairPlan } from '@/modules/wms/costing/rider-repair';
import { batchLots } from '@/modules/wms/batches/lots';
import { addTransaction, batchCharges } from '@/modules/wms/finance/service';
import { clientCargo } from '@/modules/wms/finance/client-cargo';
import { pricingView } from '@/modules/wms/finance/pricing-view';
import {
  clientProfitGaps,
  profitAndLoss,
  profitByBatch,
  profitByClient,
  unbatchedMoney,
} from '@/modules/wms/accounting/reports';
import { cargoRiskList } from '@/modules/wms/reports/business';
import { buildProfitXlsx } from '@/modules/wms/accounting/xlsx';
import { reportLabels } from '@/modules/wms/reports/labels';

/**
 * Who REALLY rode a truck for money, and each allocation counted on one
 * priced truck (audit 2026-09-25: U16, U17, U25, U18, U35, U37, U19).
 *
 * Every step goes through the real doors — confirmReceipt, the plan and its
 * verdict, the loading scans, departBatch, the unload scans, finishUnload,
 * resolveMissing, acceptFoundBox, the grid — and every figure is read from
 * the real report functions, because each defect here was two correct halves
 * that disagreed about membership.
 *
 * Money lives in 1637 (no other file's period; each block its own month, so
 * a block's P&L is that block's entries), cargo in five private warehouses.
 * Trucks depart TODAY (the doors stamp now()), so the truck report is read
 * for today and filtered to this file's trucks.
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
let costTypeId: string;
/** 'customs' — the seeded code `calc_customs_cost_type_codes` names by default. */
let customsTypeId: string;
let formingId: string | null = null;
const W: Record<'yw' | 'ka' | 'and' | 'tas' | 'tas2', string> = { yw: '', ka: '', and: '', tas: '', tas2: '' };
const madeClients: string[] = [];
const madeTrucks: string[] = [];
const today = tashkentDay();
const ctx = () => ({ actorId });
const cents = (n: number) => Math.round(n * 100) / 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Riders ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let clientSeq = 0;
async function mkClient(tag: string) {
  clientSeq += 1;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `R${clientSeq}${tag}${S}`.slice(0, 10).toUpperCase(), name: `Riders ${tag} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(row!.id);
  return row!.id;
}

async function mkLot(clientId: string | null, boxCount: number, boxKg: number, warehouseId: string) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `riders/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId: clientId ?? undefined,
      unclaimedMarking: clientId ? '' : `MK${S}${boxCount}`,
      lots: [
        {
          id: lotId,
          productNameZh: '骑手货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 50,
          boxWidthCm: 40,
          boxHeightCm: 30,
          boxWeightKg: boxKg,
        },
      ],
      extraCosts: [],
    } as never,
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(boxes.seqInLot);
  return { receiptId, lotId, boxIds: rows.map((b) => b.id), codes: rows.map((b) => b.shortCode) };
}

const scan = (batchId: string, code: string) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'qr' as const,
  addedOnSpot: false,
  scannedAt: new Date().toISOString(),
});

/** Plan + approve + scan `codes` (of the reserved boxes) + finishLoading, not yet departed. */
async function loadTruck(lines: { lotId: string; take: number }[], codes: string[], origin: string, dest: string) {
  const sub = await submitPlan(
    { originWarehouseId: origin, destWarehouseId: dest, lines: lines.map((l) => ({ lotId: l.lotId, boxCount: l.take })) } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
  madeTrucks.push(batch!.id);
  for (const code of codes) {
    const [ack] = await ingestLoadScans([scan(batch!.id, code)], ctx());
    if (ack!.result !== 'ok') throw new Error(`load ${code}: ${ack!.result} ${ack!.detail ?? ''}`);
  }
  return batch!;
}

/** …and away. Departures a few ms apart: «shu reysgacha» is decided by departure time. */
async function truck(lines: { lotId: string; take: number }[], codes: string[], origin: string, dest: string) {
  const batch = await loadTruck(lines, codes, origin, dest);
  await finishLoading(batch.id, ctx());
  await sleep(15);
  await departBatch(batch.id, ctx());
  return batch;
}

async function unload(batchId: string, codes: string[]) {
  const acks = [];
  for (const code of codes) acks.push(...(await ingestUnloadScans([scan(batchId, code)], ctx())));
  return acks;
}

async function cost(input: {
  scope: 'batch' | 'receipt';
  batchId?: string;
  receiptId?: string;
  amount: number;
  day: string;
  typeId?: string;
}) {
  return addCostEntry(
    {
      scope: input.scope,
      batchId: input.batchId,
      receiptId: input.receiptId,
      costTypeId: input.typeId ?? costTypeId,
      amount: input.amount,
      currency: 'USD',
      costDate: input.day,
      allocationBasis: 'weight',
    },
    ctx(),
  );
}

async function charge(clientId: string, batchId: string | undefined, amount: number, day: string) {
  await addTransaction({ clientId, type: 'charge', amount, currency: 'USD', txDate: day, batchId }, ctx());
}

/** Rows of «Partiya foydasi» for this file's trucks, by truck id. */
async function truckRows() {
  const mine = new Set(madeTrucks);
  return new Map((await profitByBatch(today, today)).filter((row) => mine.has(row.batchId)).map((row) => [row.batchId, row]));
}

/** What «Partiya moliyasi» prints in its header, assembled as the page does. */
async function header(batchId: string) {
  return pricingView(
    await batchLots(batchId),
    await batchLandedCostByLot(batchId),
    (await batchCharges(batchId)).map(({ tx, clientCode, clientName }) => ({
      clientId: tx.clientId,
      clientCode,
      clientName,
      type: tx.type,
      amountUsd: Number(tx.amountUsd),
    })),
  );
}

async function allocated(entryId: string, boxId: string) {
  const [row] = await db
    .select({ usd: costAllocations.amountUsd })
    .from(costAllocations)
    .where(and(eq(costAllocations.costEntryId, entryId), eq(costAllocations.boxId, boxId)));
  return row ? Number(row.usd) : 0;
}

async function directTotal(from: string, to: string) {
  return (await profitAndLoss(from, to)).directTotal.total;
}

/** A downloaded sheet as its rows of cell values, the way a person reads it. */
async function sheetRows(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const out: unknown[][] = [];
  workbook.worksheets[0]!.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
  return out;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).where(eq(costTypes.code, 'freight')))[0]!.id;
  customsTypeId = (await db.select({ id: costTypes.id }).from(costTypes).where(eq(costTypes.code, 'customs')))[0]!.id;
  W.yw = await mintWarehouse(`RY${S}`, 'CN', 'origin');
  W.ka = await mintWarehouse(`RK${S}`, 'CN', 'hub');
  // A hub, so cargo lands `in_stock` and can be planned onward to Tashkent.
  W.and = await mintWarehouse(`RA${S}`, 'UZ', 'hub');
  W.tas = await mintWarehouse(`RT${S}`, 'UZ', 'distribution');
  W.tas2 = await mintWarehouse(`RS${S}`, 'UZ', 'distribution');
});

afterAll(async () => {
  // Money first (all of it in 1637, all of it this file's), then the
  // configuration: a warehouse an audited action touched is DEACTIVATED,
  // never deleted (audit_log FK). The cargo stays, as in m4-unload.
  if (madeClients.length) {
    await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
  }
  await db.execute(sql`DELETE FROM cost_entries WHERE cost_date BETWEEN '1637-01-01' AND '1637-12-31'`);
  // An empty forming truck would sit on the board for ever.
  if (formingId) await db.delete(batches).where(and(eq(batches.id, formingId), eq(batches.status, 'forming')));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('U16 — an allocation counts on exactly one priced truck', () => {
  it('Yiwu → Andijan then Andijan → Tashkent: the second truck carries only its own road', async () => {
    const x = await mkClient('X');
    const p = await mkLot(x, 2, 50, W.yw);
    await cost({ scope: 'receipt', receiptId: p.receiptId, amount: 40, day: '1637-03-01' });
    const t1 = await truck([{ lotId: p.lotId, take: 2 }], p.codes, W.yw, W.and);
    await cost({ scope: 'batch', batchId: t1.id, amount: 400, day: '1637-03-02' });
    await charge(x, t1.id, 700, '1637-03-05');
    await unload(t1.id, p.codes);
    await finishUnload(t1.id, ctx());

    const t2 = await truck([{ lotId: p.lotId, take: 2 }], p.codes, W.and, W.tas);
    await cost({ scope: 'batch', batchId: t2.id, amount: 60, day: '1637-03-06' });
    await charge(x, t2.id, 100, '1637-03-07');

    const rows = await truckRows();
    expect(rows.get(t1.id)).toMatchObject({ internal: false, revenueUsd: 700, costUsd: 440, prevUsd: 40, profitUsd: 260 });
    // The receipt's $40 and the cross-border $400 were counted AGAIN here.
    expect(rows.get(t2.id)).toMatchObject({ internal: false, revenueUsd: 100, costUsd: 60, prevUsd: 0, profitUsd: 40 });

    // The pricing screen says the same, header and breakdown.
    const view = await header(t2.id);
    expect(view.totals).toMatchObject({ costUsd: 60, prevUsd: 0 });
    const parts = (await batchClientCostBreakdown(t2.id)).get(x)!;
    expect(cents(parts.reduce((sum, part) => sum + part.usd, 0))).toBe(60);
    expect((await batchLandedCostByClient(t2.id)).get(x)).toMatchObject({ totalUsd: 60, batchUsd: 60 });

    // Disjoint rows: the priced trucks add up to the money spent, once.
    expect(cents(rows.get(t1.id)!.costUsd + rows.get(t2.id)!.costUsd)).toBe(
      await directTotal('1637-03-01', '1637-03-31'),
    );
  });

  it('internal → export → Uzbek leg: the export keeps the Chinese money, the Uzbek leg does not', async () => {
    const w = await mkClient('W');
    const lot = await mkLot(w, 1, 10, W.yw);
    await cost({ scope: 'receipt', receiptId: lot.receiptId, amount: 5, day: '1637-02-01' });
    const inner = await truck([{ lotId: lot.lotId, take: 1 }], lot.codes, W.yw, W.ka);
    await cost({ scope: 'batch', batchId: inner.id, amount: 30, day: '1637-02-02' });
    await unload(inner.id, lot.codes);
    await finishUnload(inner.id, ctx());
    const across = await truck([{ lotId: lot.lotId, take: 1 }], lot.codes, W.ka, W.and);
    await cost({ scope: 'batch', batchId: across.id, amount: 100, day: '1637-02-03' });
    await unload(across.id, lot.codes);
    await finishUnload(across.id, ctx());
    const uzLeg = await truck([{ lotId: lot.lotId, take: 1 }], lot.codes, W.and, W.tas);
    await cost({ scope: 'batch', batchId: uzLeg.id, amount: 7, day: '1637-02-04' });

    const rows = await truckRows();
    expect(rows.get(inner.id)).toMatchObject({ internal: true, costUsd: 35, profitUsd: null });
    expect(rows.get(across.id)).toMatchObject({ internal: false, costUsd: 135, prevUsd: 35 });
    expect(rows.get(uzLeg.id)).toMatchObject({ internal: false, costUsd: 7, prevUsd: 0 });
    // The internal row stays out of the totals (R2a); the priced ones are the P&L.
    expect(cents(rows.get(across.id)!.costUsd + rows.get(uzLeg.id)!.costUsd)).toBe(
      await directTotal('1637-02-01', '1637-02-28'),
    );
  });
});

describe('U17 — a carton scanned onto a truck but found back at its origin never rode it', () => {
  /*
   * The owner's rule for this carton (2026-09-25): «a mashinaga yuklanganda …
   * ywda qolib ketgani aniqlansa uni yolkira narxi yozilmasin, b partiyada
   * yozilsin, lekin rastamojka qilib qoygan bolsak shu rastamojka narxi ham
   * partiyada yozilishi kerak». A's ROAD cost leaves the carton; A's CUSTOMS
   * (it was declared) stays on it and is carried to B as «shu reysgacha».
   * THIS is the test to flip if he answers otherwise: the customs numbers
   * below (87.5 on P2, 607.5, 4132.5, 1107.5) are that rule.
   */
  it('resolveMissing(found_at_origin): road cost re-splits over the riders, customs stays and rides on to B', async () => {
    const x = await mkClient('PX');
    const y = await mkClient('PY');
    const z = await mkClient('PZ');
    const p = await mkLot(x, 2, 50, W.yw);
    const q = await mkLot(y, 3, 100, W.yw);
    await cost({ scope: 'receipt', receiptId: p.receiptId, amount: 40, day: '1637-04-01' });
    const a = await truck(
      [
        { lotId: p.lotId, take: 2 },
        { lotId: q.lotId, take: 3 },
      ],
      [...p.codes, ...q.codes],
      W.yw,
      W.tas,
    );
    const freight = await cost({ scope: 'batch', batchId: a.id, amount: 3500, day: '1637-04-02' });
    const customs = await cost({ scope: 'batch', batchId: a.id, amount: 700, day: '1637-04-02', typeId: customsTypeId });
    // P2 physically stayed in Yiwu: the truck arrives without it.
    await unload(a.id, [p.codes[0]!, ...q.codes]);
    const fin = await finishUnload(a.id, ctx(), { mayCloseWithMissing: true });
    expect(fin.missing).toEqual([p.codes[1]]);
    await resolveMissing({ boxId: p.boxIds[1]!, resolution: 'found_at_origin' }, ctx());

    // The door re-split the truck by itself (DECISIONS #15's missing half):
    // the freight over the 350 kg that rode, the customs over the 400 kg
    // that were declared.
    expect(await allocated(freight.id, p.boxIds[1]!)).toBe(0);
    expect(await allocated(freight.id, p.boxIds[0]!)).toBeCloseTo(500, 2);
    expect(await allocated(customs.id, p.boxIds[1]!)).toBeCloseTo(87.5, 2);
    expect(await allocated(customs.id, q.boxIds[0]!)).toBeCloseTo(175, 2);

    const sheet = await batchCostSheet(a.id);
    expect(sheet).toMatchObject({ boxCount: 4, kg: 350, usdPerKg: 12 });
    expect((await batchReceiptRows(a.id)).find((row) => row.receiptId === p.receiptId)).toMatchObject({ boxCount: 1, kg: 50 });
    const lotP = (await batchLots(a.id)).find((lot) => lot.lotId === p.lotId)!;
    expect(lotP).toMatchObject({ onBatch: 1, kg: 50, leftBehindCount: 1 });
    const onA = (await header(a.id)).clients.find((group) => group.clientId === x)!;
    expect(onA).toMatchObject({ boxes: 1, kg: 50, costUsd: 607.5 });

    // P2 really rides truck B.
    const r = await mkLot(z, 5, 10, W.yw);
    const b = await truck(
      [
        { lotId: p.lotId, take: 1 },
        { lotId: r.lotId, take: 5 },
      ],
      [p.codes[1]!, ...r.codes],
      W.yw,
      W.tas,
    );
    await cost({ scope: 'batch', batchId: b.id, amount: 1000, day: '1637-04-03' });
    // P2: its receipt 20 + A's customs 87.5 + B's freight 500 (no A freight).
    expect((await boxLandedCost(p.boxIds[1]!)).totalUsd).toBe(607.5);
    expect((await boxLandedCost(p.boxIds[0]!)).totalUsd).toBe(607.5);

    const rows = await truckRows();
    expect(rows.get(a.id)).toMatchObject({ boxCount: 4, kg: 350, costUsd: 4132.5, prevUsd: 20 });
    // P2's receipt money and its share of A's customs ride with it to the
    // first truck it really boarded — carried cost there, billed there.
    expect(rows.get(b.id)).toMatchObject({ boxCount: 6, kg: 100, costUsd: 1107.5, prevUsd: 107.5 });
    const onB = (await header(b.id)).clients.find((group) => group.clientId === x)!;
    expect(onB).toMatchObject({ boxes: 1, costUsd: 607.5, prevUsd: 107.5 });
    const aCode = (await db.select({ code: batches.code }).from(batches).where(eq(batches.id, a.id)))[0]!.code;
    expect((await batchClientCostBreakdown(b.id)).get(x)!.find((part) => part.source === aCode)!.usd).toBe(87.5);
    // Nothing counted twice: the priced trucks are the P&L.
    expect(cents(rows.get(a.id)!.costUsd + rows.get(b.id)!.costUsd)).toBe(await directTotal('1637-04-01', '1637-04-30'));

    // Data written before the rule: the old base left A's freight on P2.
    await db.insert(costAllocations).values({ costEntryId: freight.id, boxId: p.boxIds[1]!, clientId: x, amountUsd: '437.5' });
    const phantom = await cargoRiskList('phantom', [W.yw]);
    expect(phantom.map((row) => row.boxId)).toContain(p.boxIds[1]);
    const plan = await riderRepairPlan();
    expect(plan.leftBehind.find((row) => row.batchId === a.id)).toMatchObject({ boxes: 1, usd: 437.5 });
    // Only this truck: the plan is the whole database's.
    await applyRiderRepair({ leftBehind: plan.leftBehind.filter((row) => row.batchId === a.id), rogue: [], stampedCells: [] });
    expect(await allocated(freight.id, p.boxIds[1]!)).toBe(0);
    // The customs share is right where it is, and is no «phantom».
    expect(await allocated(customs.id, p.boxIds[1]!)).toBeCloseTo(87.5, 2);
    expect(await cargoRiskList('phantom', [W.yw])).toEqual([]);
  });

  it('acceptFoundBox at the origin (the loader\'s own door): no manager, no missing flag, same answer', async () => {
    const x = await mkClient('AX');
    const y = await mkClient('AY');
    const p = await mkLot(x, 2, 50, W.yw);
    const q = await mkLot(y, 3, 100, W.yw);
    const a = await truck(
      [
        { lotId: p.lotId, take: 2 },
        { lotId: q.lotId, take: 3 },
      ],
      [...p.codes, ...q.codes],
      W.yw,
      W.tas,
    );
    const freight = await cost({ scope: 'batch', batchId: a.id, amount: 3500, day: '1637-05-02' });
    expect(await allocated(freight.id, p.boxIds[1]!)).toBeCloseTo(437.5, 2);
    await acceptFoundBox({ warehouseId: W.yw, code: p.codes[1]! }, ctx());
    await unload(a.id, [p.codes[0]!, ...q.codes]);
    await finishUnload(a.id, ctx());

    expect(await allocated(freight.id, p.boxIds[1]!)).toBe(0);
    expect(await allocated(freight.id, p.boxIds[0]!)).toBeCloseTo(500, 2);
    expect(await batchCostSheet(a.id)).toMatchObject({ boxCount: 4, kg: 350, usdPerKg: 10 });
    expect((await truckRows()).get(a.id)).toMatchObject({ boxCount: 4, kg: 350, costUsd: 3500 });

    // The prixod's grid cells on this truck follow the same two rules: a
    // customs cell covers the declared cartons, any other cell the riders.
    await addReceiptCostsBulk(
      {
        batchId: a.id,
        currency: 'USD',
        costDate: '1637-05-04',
        cells: [
          { receiptId: p.receiptId, costTypeId: customsTypeId, amount: 100 },
          { receiptId: p.receiptId, costTypeId, amount: 60 },
        ],
      },
      ctx(),
    );
    const cells = await db
      .select({ id: costEntries.id, typeId: costEntries.costTypeId })
      .from(costEntries)
      .where(and(eq(costEntries.batchId, a.id), eq(costEntries.receiptId, p.receiptId)));
    const cellOf = (typeId: string) => cells.find((cell) => cell.typeId === typeId)!.id;
    expect(await allocated(cellOf(customsTypeId), p.boxIds[1]!)).toBeCloseTo(50, 2);
    expect(await allocated(cellOf(costTypeId), p.boxIds[1]!)).toBe(0);
    expect(await allocated(cellOf(costTypeId), p.boxIds[0]!)).toBeCloseTo(60, 2);
  });

  it('a carton found at a THIRD warehouse, or found here after a missing flag, is still a rider', async () => {
    const m = await mkClient('MX');
    const lot = await mkLot(m, 3, 50, W.yw);
    const a = await truck([{ lotId: lot.lotId, take: 3 }], lot.codes, W.yw, W.tas);
    const freight = await cost({ scope: 'batch', batchId: a.id, amount: 150, day: '1637-05-03' });
    // In transit to Tashkent, found standing in the other Tashkent warehouse:
    // that proves nothing about the road.
    await acceptFoundBox({ warehouseId: W.tas2, code: lot.codes[2]! }, ctx());
    await unload(a.id, [lot.codes[0]!]);
    await finishUnload(a.id, ctx(), { mayCloseWithMissing: true });
    await resolveMissing({ boxId: lot.boxIds[1]!, resolution: 'found_here' }, ctx());
    await recomputeAll({ batchId: a.id });
    for (const boxId of lot.boxIds) expect(await allocated(freight.id, boxId)).toBeCloseTo(50, 2);
    expect((await batchLots(a.id))[0]).toMatchObject({ onBatch: 3, leftBehindCount: 0 });
  });
});

describe('U25 — a carton that rode without a load scan is that truck\'s cargo', () => {
  it('a planned box the scanner missed, short-loaded, and on the truck anyway pays its share', async () => {
    const u = await mkClient('UU');
    const v = await mkClient('UV');
    const lu = await mkLot(u, 2, 50, W.yw);
    const lv = await mkLot(v, 3, 100, W.yw);
    const e = await truck(
      [
        { lotId: lv.lotId, take: 3 },
        { lotId: lu.lotId, take: 1 },
      ],
      lv.codes,
      W.yw,
      W.tas,
    );
    const freight = await cost({ scope: 'batch', batchId: e.id, amount: 3000, day: '1637-06-02' });
    const acks = await unload(e.id, [...lv.codes, lu.codes[0]!]);
    expect(acks.map((ack) => ack.result)).toEqual(['ok', 'ok', 'ok', 'auto_transfer']);
    await finishUnload(e.id, ctx());

    // The unload's own re-split: 3000 over 350 kg.
    expect(await allocated(freight.id, lu.boxIds[0]!)).toBeCloseTo(428.57, 2);
    expect(await allocated(freight.id, lv.boxIds[0]!)).toBeCloseTo(857.14, 2);
    const lotU = (await batchLots(e.id)).find((lot) => lot.lotId === lu.lotId);
    expect(lotU).toMatchObject({ onBatch: 1, kg: 50 });
    expect((await truckRows()).get(e.id)).toMatchObject({ boxCount: 4, kg: 350, costUsd: 3000 });
    expect(await batchCostSheet(e.id)).toMatchObject({ boxCount: 4, kg: 350 });
    // …so the client card asks for its price.
    expect((await clientCargo(u)).trips.map((trip) => trip.batchId)).toContain(e.id);
  });
});

describe('U18 — a grid cell is its truck\'s part of the prixod', () => {
  it('a prixod split over two trucks: each truck carries its own customs, and together the P&L', async () => {
    const c = await mkClient('GC');
    const lot = await mkLot(c, 4, 10, W.yw);
    const first = await truck([{ lotId: lot.lotId, take: 2 }], lot.codes.slice(0, 2), W.yw, W.tas);
    const second = await truck([{ lotId: lot.lotId, take: 2 }], lot.codes.slice(2), W.yw, W.tas);
    for (const [batchId, amount] of [
      [first.id, 60],
      [second.id, 100],
    ] as const) {
      const result = await addReceiptCostsBulk(
        { batchId, currency: 'USD', costDate: '1637-07-02', cells: [{ receiptId: lot.receiptId, costTypeId, amount }] },
        ctx(),
      );
      expect(result.error).toBeNull();
    }
    const firstLot = (await batchLandedCostByLot(first.id)).get(lot.lotId)!;
    const secondLot = (await batchLandedCostByLot(second.id)).get(lot.lotId)!;
    // It was 30 and 80-with-30-of-it-«shu reysgacha»: $50 on no truck at all.
    expect(firstLot).toMatchObject({ totalUsd: 60, batchUsd: 60 });
    expect(secondLot).toMatchObject({ totalUsd: 100, batchUsd: 100 });
    const rows = await truckRows();
    expect(cents(rows.get(first.id)!.costUsd + rows.get(second.id)!.costUsd)).toBe(
      await directTotal('1637-07-01', '1637-07-31'),
    );
  });

  it('a cell typed while loading re-splits over what departed', async () => {
    const c = await mkClient('GL');
    const lot = await mkLot(c, 3, 10, W.yw);
    const z = await loadTruck([{ lotId: lot.lotId, take: 3 }], lot.codes.slice(0, 2), W.yw, W.tas);
    await addReceiptCostsBulk(
      { batchId: z.id, currency: 'USD', costDate: '1637-08-02', cells: [{ receiptId: lot.receiptId, costTypeId, amount: 90 }] },
      ctx(),
    );
    await finishLoading(z.id, ctx()); // the third box is short-loaded
    await departBatch(z.id, ctx());
    await recomputeAll({ batchId: z.id }); // what departBatchAction enqueues
    const [cell] = await db
      .select({ id: costEntries.id })
      .from(costEntries)
      .where(and(eq(costEntries.batchId, z.id), eq(costEntries.receiptId, lot.receiptId)));
    expect(await allocated(cell!.id, lot.boxIds[0]!)).toBeCloseTo(45, 2);
    expect(await allocated(cell!.id, lot.boxIds[2]!)).toBe(0);
  });

  it('an internal leg\'s stamped cell reaches the export truck as «shu reysgacha»', async () => {
    const c = await mkClient('GI');
    const lot = await mkLot(c, 1, 10, W.yw);
    const inner = await truck([{ lotId: lot.lotId, take: 1 }], lot.codes, W.yw, W.ka);
    await addReceiptCostsBulk(
      { batchId: inner.id, currency: 'USD', costDate: '1637-08-03', cells: [{ receiptId: lot.receiptId, costTypeId, amount: 40 }] },
      ctx(),
    );
    await unload(inner.id, lot.codes);
    await finishUnload(inner.id, ctx());
    const across = await truck([{ lotId: lot.lotId, take: 1 }], lot.codes, W.ka, W.and);
    await cost({ scope: 'batch', batchId: across.id, amount: 100, day: '1637-08-04' });
    expect((await truckRows()).get(across.id)).toMatchObject({ costUsd: 140, prevUsd: 40 });
  });
});

describe('U35 — the pricing screen says which cartons did not arrive', () => {
  it('missing, lost and back-at-origin are counted beside the cargo; the cost does not move for lost', async () => {
    const [ca, cb, cc] = [await mkClient('FA'), await mkClient('FB'), await mkClient('FC')];
    const a = await mkLot(ca, 2, 50, W.yw);
    const b = await mkLot(cb, 3, 50, W.yw);
    const c = await mkLot(cc, 2, 50, W.yw);
    const t = await truck(
      [
        { lotId: a.lotId, take: 2 },
        { lotId: b.lotId, take: 3 },
        { lotId: c.lotId, take: 2 },
      ],
      [...a.codes, ...b.codes, ...c.codes],
      W.yw,
      W.tas,
    );
    await cost({ scope: 'batch', batchId: t.id, amount: 1400, day: '1637-09-02' });
    // In transit, nobody is missing yet.
    expect((await batchLots(t.id)).every((lot) => lot.missingCount === 0)).toBe(true);
    await unload(t.id, [...a.codes, b.codes[0]!, b.codes[1]!, c.codes[0]!]);
    await finishUnload(t.id, ctx(), { mayCloseWithMissing: true });

    const lotB = () => batchLots(t.id).then((lots) => lots.find((lot) => lot.lotId === b.lotId)!);
    expect(await lotB()).toMatchObject({ onBatch: 3, kg: 150, missingCount: 1, lostCount: 0, arrivedKg: 100 });
    const groupB = (await header(t.id)).clients.find((group) => group.clientId === cb)!;
    expect(groupB.fate).toMatchObject({ missing: 1, arrivedBoxes: 2, arrivedKg: 100 });

    await resolveMissing({ boxId: b.boxIds[2]!, resolution: 'found_here' }, ctx());
    await markBoxLost({ boxId: b.boxIds[2]!, reason: 'ezilgan', atWarehouseId: W.tas }, ctx());
    expect(await lotB()).toMatchObject({ onBatch: 3, missingCount: 0, lostCount: 1, arrivedKg: 100 });
    // #833: a write-off does not move money — the lot still carries 150 kg of freight.
    expect((await batchLandedCostByLot(t.id)).get(b.lotId)!.totalUsd).toBe(600);

    await resolveMissing({ boxId: c.boxIds[1]!, resolution: 'found_at_origin' }, ctx());
    const lotC = (await batchLots(t.id)).find((lot) => lot.lotId === c.lotId)!;
    expect(lotC).toMatchObject({ onBatch: 1, missingCount: 0, leftBehindCount: 1 });
    // The three money screens still agree to the cent.
    const view = await header(t.id);
    const row = (await truckRows()).get(t.id)!;
    expect(view.totals.costUsd).toBe(row.costUsd);
    expect(row.costUsd).toBe(1400);
  });
});

describe('U37 — cost on cargo that rode no priced truck is named', () => {
  it('lost at the origin, returned, handed over locally, still waiting: the trucks plus the four parts are the P&L', async () => {
    const day = '1637-10-02';
    const ca = await mkClient('NA');
    const la = await mkLot(ca, 10, 10, W.yw);
    await cost({ scope: 'receipt', receiptId: la.receiptId, amount: 100, day });
    await markBoxLost({ boxId: la.boxIds[9]!, reason: 'ezilgan', atWarehouseId: W.yw }, ctx());
    const t = await truck([{ lotId: la.lotId, take: 8 }], la.codes.slice(0, 8), W.yw, W.tas);
    await cost({ scope: 'batch', batchId: t.id, amount: 800, day });

    const lb = await mkLot(null, 5, 10, W.yw);
    await cost({ scope: 'receipt', receiptId: lb.receiptId, amount: 50, day });
    await returnUnclaimedToSender(
      { handoverId: uuidv4(), receiptId: lb.receiptId, personName: 'Sender Li', personPhone: '+8613800000000' },
      ctx(),
    );

    const cc = await mkClient('NC');
    const lc = await mkLot(cc, 3, 10, W.tas);
    await cost({ scope: 'receipt', receiptId: lc.receiptId, amount: 30, day });
    await issueBoxes(
      { handoverId: uuidv4(), clientId: cc, warehouseId: W.tas, boxIds: lc.boxIds, personName: 'Mijoz C', personPhone: '+998900000000', debtOk: true },
      ctx(),
    );

    const unbatched = await unbatchedMoney('1637-10-01', '1637-10-31');
    expect(unbatched.noTruckCost).toEqual({ lostUsd: 10, issuedUsd: 80, waitingUsd: 10 });
    const truckCost = (await truckRows()).get(t.id)!.costUsd;
    expect(truckCost).toBe(880);
    const parts = unbatched.noTruckCost;
    expect(cents(truckCost + parts.lostUsd + parts.issuedUsd + parts.waitingUsd)).toBe(
      await directTotal('1637-10-01', '1637-10-31'),
    );
    // The download says it too, as a TEXT note under the table (the screen
    // and its file must not disagree, #532d).
    const L = reportLabels('uz');
    const file = await sheetRows(await buildProfitXlsx('batch', '1637-10-01', '1637-10-31', 'uz'));
    expect(
      file.some(
        (row) =>
          row.length === 1 &&
          row[0] ===
            `${L.unbatchedCostNote}: ${L.noTruckLost} $10.00 · ${L.noTruckIssued} $80.00 · ${L.noTruckWaiting} $10.00`,
      ),
    ).toBe(true);
  });
});

describe('U19 — «Mijoz foydasi» reconciles to the P&L', () => {
  it('names unclaimed cargo and money that reached no box, and the unclaimed half follows a claim', async () => {
    const day = '1637-11-02';
    const from = '1637-11-01';
    const to = '1637-11-30';
    const x = await mkClient('CX');
    const y = await mkClient('CY');
    const lx = await mkLot(x, 1, 50, W.yw);
    const lu = await mkLot(null, 1, 50, W.yw);
    const t = await truck(
      [
        { lotId: lx.lotId, take: 1 },
        { lotId: lu.lotId, take: 1 },
      ],
      [...lx.codes, ...lu.codes],
      W.yw,
      W.tas,
    );
    await cost({ scope: 'batch', batchId: t.id, amount: 1000, day });
    await cost({ scope: 'receipt', receiptId: lu.receiptId, amount: 40, day });
    // A truck cost typed while the truck is still empty.
    const [forming] = await db
      .insert(batches)
      .values({ code: `RF${S}`, originWarehouseId: W.yw, destWarehouseId: W.tas, status: 'forming', createdBy: actorId })
      .returning({ id: batches.id });
    madeTrucks.push(forming!.id);
    formingId = forming!.id;
    await cost({ scope: 'batch', batchId: forming!.id, amount: 77, day });
    // A share named for a client who has no box in the scope.
    await addCostEntry(
      { scope: 'receipt', receiptId: lx.receiptId, costTypeId, amount: 30, currency: 'USD', costDate: day, allocationBasis: 'direct_to_client', clientId: y },
      ctx(),
    );
    await charge(x, t.id, 1500, day);

    const rows = await profitByClient(from, to);
    const gaps = await clientProfitGaps(from, to);
    const pnl = await profitAndLoss(from, to);
    expect(gaps.unclaimed).toEqual({ usd: 540, receipts: 1 });
    expect(gaps.unallocated).toMatchObject({ usd: 107, count: 2 });
    expect(gaps.unallocated.byScope.map((row) => row.scope).sort()).toEqual(['batch', 'receipt']);
    const rowCost = cents(rows.reduce((sum, row) => sum + row.costUsd, 0));
    expect(cents(rowCost + gaps.unclaimed.usd + gaps.unallocated.usd)).toBe(pnl.directTotal.total);
    expect(cents(rows.reduce((sum, row) => sum + row.revenueUsd, 0))).toBe(pnl.revenue.total);
    expect(rows.find((row) => row.clientId === x)).toMatchObject({ revenueUsd: 1500, costUsd: 500 });

    // The file reconciles like the tab: the unclaimed row sits inside the
    // JAMI, and the money that reached no box is a note carrying no number
    // a hand SUM of the cost column could reach into.
    const L = reportLabels('uz');
    const file = await sheetRows(await buildProfitXlsx('client', from, to, 'uz'));
    const head = file.findIndex((row) => row.includes(`${L.cost} $`));
    const jami = file.findIndex((row) => row[0] === L.total);
    const costCol = file[head]!.indexOf(`${L.cost} $`);
    const unclaimedRow = file.find((row) => row[0] === L.unclaimedCargo);
    expect(unclaimedRow?.[costCol]).toBe(540);
    const summed = file
      .slice(head + 1, jami)
      .reduce((acc: number, row) => acc + (typeof row[costCol] === 'number' ? (row[costCol] as number) : 0), 0);
    expect(cents(summed)).toBe(cents(rowCost + gaps.unclaimed.usd));
    expect(file[jami]![costCol]).toBe(cents(rowCost + gaps.unclaimed.usd));
    const note = file.find((row) => String(row[0]).startsWith(`⚠ ${L.clientUnallocatedNote}: $107.00`));
    expect(note).toHaveLength(1);
    expect(String(note![0])).toContain(`${L.gapScopeBatch} ×1`);

    await assignReceiptClient(lu.receiptId, x, ctx());
    expect((await clientProfitGaps(from, to)).unclaimed.usd).toBe(0);
    expect((await profitByClient(from, to)).find((row) => row.clientId === x)).toMatchObject({ costUsd: 1040 });
  });
});
