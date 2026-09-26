import 'dotenv/config';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxes,
  clientNotices,
  clientTransactions,
  clients,
  fxRates,
  notifications,
  receipts,
  users,
  warehouses,
  deals,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { createDeal } from '@/modules/wms/deals/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ingestLoadScans, removeLoadedCode } from '@/modules/wms/scanning/service';
import { finishUnload, ingestUnloadScans } from '@/modules/wms/scanning/unload';
import { acceptFoundBox } from '@/modules/wms/inventory/service';
import {
  FinanceError,
  addTransaction,
  batchCharges,
  moveCharge,
  voidTransaction,
} from '@/modules/wms/finance/service';
import { offTruckPrices, pricedElsewhereFor } from '@/modules/wms/finance/off-truck';
import { unpricedGate, unpricedReceiptsOn } from '@/modules/wms/finance/unpriced';
import { clientCargo } from '@/modules/wms/finance/client-cargo';
import { pricingView } from '@/modules/wms/finance/pricing-view';
import { batchLots } from '@/modules/wms/batches/lots';
import { riderLoad } from '@/modules/wms/batches/riders';
import { batchLandedCostByLot } from '@/modules/wms/costing/service';
import { arAging, profitAndLoss, profitByBatch, profitByRoute } from '@/modules/wms/accounting/reports';
import { tripTotals } from '@/modules/wms/reports/dashboard-math';
import { tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * A price whose cargo left the truck (owner, 2026-09-25: Q21a «ogohlantirish
 * bersin», Q2 the found-back carton, U31 the door) and «🚚 Ko'chirish», the
 * one press that puts it where the cargo went.
 *
 * Every step goes through the real doors — confirmReceipt, the plan, the
 * load scans and removals, finishLoading, departBatch, the unload,
 * acceptFoundBox, addTransaction, moveCharge — because each warning is a
 * disagreement between the moment of a price and the moment a carton left.
 *
 * Money lives in 1614 (no other file's year). The one rate this file needs
 * (UZS, case 11) is its own row, dated in 1614 and deleted afterwards.
 */

const S = String(Date.now()).slice(-6);
const DAY = '1614-06-10';
const AUG = '1614-08-28';
let actorId: string;
const W: Record<'yw' | 'ka' | 'tas', string> = { yw: '', ka: '', tas: '' };
const madeClients: string[] = [];
let fxRowId: string | null = null;
const ctx = () => ({ actorId });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = new Date();
const today = () => tashkentDay();

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Ketmagan ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let clientSeq = 0;
async function mkClient(tag: string) {
  clientSeq += 1;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `K${clientSeq}${tag}${S}`.slice(0, 10).toUpperCase(), name: `Ketmagan ${tag} ${S}` })
    .returning({ id: clients.id, code: clients.clientCode });
  madeClients.push(row!.id);
  return row!;
}

async function mkLot(clientId: string, boxCount: number, warehouseId: string) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `ketmagan/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId,
      dealId: null,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '离车货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 50,
          boxWidthCm: 40,
          boxHeightCm: 30,
          boxWeightKg: 20,
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

/** Plan + approve + scan `codes` — planned/loading, not departed. */
async function loadTruck(lines: { lotId: string; take: number }[], codes: string[], origin: string, dest: string) {
  const sub = await submitPlan(
    { originWarehouseId: origin, destWarehouseId: dest, lines: lines.map((l) => ({ lotId: l.lotId, boxCount: l.take })) } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
  for (const code of codes) {
    const [ack] = await ingestLoadScans([scan(batch!.id, code)], ctx());
    if (ack!.result !== 'ok') throw new Error(`load ${code}: ${ack!.result} ${ack!.detail ?? ''}`);
  }
  return batch!;
}

async function depart(batchId: string) {
  await finishLoading(batchId, ctx());
  await sleep(15);
  await departBatch(batchId, ctx());
}

async function truck(lines: { lotId: string; take: number }[], codes: string[], origin: string, dest: string) {
  const batch = await loadTruck(lines, codes, origin, dest);
  await depart(batch.id);
  return batch;
}

async function unload(batchId: string, codes: string[]) {
  for (const code of codes) await ingestUnloadScans([scan(batchId, code)], ctx());
  await finishUnload(batchId, ctx(), { mayCloseWithMissing: true });
}

async function charge(clientId: string, amount: number, where: { batchId?: string; txDate?: string; currency?: string } = {}) {
  return addTransaction(
    {
      clientId,
      type: 'charge',
      amount,
      currency: where.currency ?? 'USD',
      txDate: where.txDate ?? DAY,
      batchId: where.batchId,
    },
    ctx(),
  );
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    if (err instanceof FinanceError) return err.code;
    throw err;
  }
}

const pricedLeftTexts = async () =>
  (
    await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.type, 'PricedCargoLeft'), gte(notifications.createdAt, startedAt)))
  ).map((n) => String((n.payload as { text?: string }).text ?? ''));

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  W.yw = await mintWarehouse(`KY${S}`, 'CN', 'origin');
  // A second Chinese warehouse, so an INTERNAL leg (CN → CN) exists.
  W.ka = await mintWarehouse(`KK${S}`, 'CN', 'hub');
  W.tas = await mintWarehouse(`KT${S}`, 'UZ', 'distribution');
});

afterAll(async () => {
  // Money first (all of it this file's clients'), then this file's one rate,
  // then the configuration: a warehouse an audited action touched is
  // DEACTIVATED, never deleted (audit_log FK). The cargo stays.
  if (madeClients.length) {
    await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
    // The unloads' «yukingiz keldi» claims — the notice drain's queue is
    // capped and read by later files (the unpriced file's reason).
    await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
  }
  if (fxRowId) await db.delete(fxRates).where(eq(fxRates.id, fxRowId));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('Q21 — a price whose cargo was left at loading', () => {
  // Shared by cases 1, 5, 6, 7 and 8: T leaves with B's cargo and none of A's.
  const q21 = {} as {
    a: Awaited<ReturnType<typeof mkClient>>;
    b: Awaited<ReturnType<typeof mkClient>>;
    c: Awaited<ReturnType<typeof mkClient>>;
    la: Awaited<ReturnType<typeof mkLot>>;
    lb: Awaited<ReturnType<typeof mkLot>>;
    t: { id: string; code: string };
    t2: { id: string; code: string };
  };

  it('1: finishLoading names the price whose cargo stayed — only THIS press’s cartons, and a second press says nothing', async () => {
    q21.a = await mkClient('A');
    q21.b = await mkClient('B');
    q21.c = await mkClient('C');
    q21.la = await mkLot(q21.a.id, 4, W.yw);
    q21.lb = await mkLot(q21.b.id, 6, W.yw);
    const lc = await mkLot(q21.c.id, 1, W.yw);
    const t = await loadTruck(
      [
        { lotId: q21.la.lotId, take: 4 },
        { lotId: q21.lb.lotId, take: 6 },
        { lotId: lc.lotId, take: 1 },
      ],
      [...q21.lb.codes, lc.codes[0]!],
      W.yw,
      W.tas,
    );
    q21.t = t;
    // Priced while planned — the live pointer makes both clients aboard.
    await charge(q21.a.id, 600, { batchId: t.id });
    await charge(q21.b.id, 400, { batchId: t.id });
    await charge(q21.c.id, 50, { batchId: t.id });
    // C's one carton is taken off BY HAND after its price: a drop, but not
    // this finishLoading's — the push must not name it.
    await removeLoadedCode(t.id, lc.codes[0]!, ctx());

    await finishLoading(t.id, ctx());
    const rows = await offTruckPrices(db, { batchIds: [t.id] });
    const aRow = rows.find((row) => row.clientId === q21.a.id)!;
    expect(aRow).toMatchObject({ kind: 'no_cargo', chargedUsd: 600, dropCause: 'short_loaded' });
    expect([...aRow.droppedBoxIds].sort()).toEqual([...q21.la.boxIds].sort());
    expect(rows.find((row) => row.clientId === q21.c.id)).toMatchObject({ kind: 'no_cargo', chargedUsd: 50 });
    // B rides: no row at all.
    expect(rows.some((row) => row.clientId === q21.b.id)).toBe(false);

    const told = (await pricedLeftTexts()).filter((text) => text.includes(t.code));
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((text) => text.includes(`${q21.a.code} $600.00`))).toBe(true);
    expect(told.some((text) => text.includes(q21.c.code))).toBe(false);

    // A second press short-loads nothing, so it announces nothing.
    await finishLoading(t.id, ctx());
    expect((await pricedLeftTexts()).filter((text) => text.includes(t.code)).length).toBe(told.length);
    await sleep(15);
    await departBatch(t.id, ctx());
  });

  it('5: the next truck — A’s cargo rides T2, the row names T2, and T2’s page keeps it by `droppedTo`', async () => {
    const t2 = await truck([{ lotId: q21.la.lotId, take: 4 }], q21.la.codes, W.yw, W.tas);
    q21.t2 = t2;
    const rows = await offTruckPrices(db, { clientIds: [q21.a.id] });
    const onT = rows.find((row) => row.batchId === q21.t.id)!;
    expect(onT.droppedTo).toEqual([{ batchId: t2.id, code: t2.code, boxes: 4 }]);
    expect(pricedElsewhereFor(rows, t2.id).map((row) => row.batchId)).toEqual([q21.t.id]);
    // T's own page is not the next truck's.
    expect(pricedElsewhereFor(rows, q21.t.id)).toEqual([]);
  });

  it('6 + 7: «Partiya moliyasi» and «Partiya foydasi» name the same no-cargo part, over the same riders', async () => {
    const t = q21.t;
    const [lots, lotCost, charges] = await Promise.all([batchLots(t.id), batchLandedCostByLot(t.id), batchCharges(t.id)]);
    const view = pricingView(
      lots,
      lotCost,
      charges.map(({ tx, clientCode, clientName }) => ({
        clientId: tx.clientId,
        clientCode,
        clientName,
        type: tx.type,
        amountUsd: Number(tx.amountUsd),
      })),
    );
    const batchRow = (await profitByBatch(today(), today())).find((row) => row.batchId === t.id)!;
    // His (a): the orphans stay IN the revenue, named as a part of it.
    expect(view.totals.chargedUsd).toBe(1050);
    expect(batchRow.revenueUsd).toBe(view.totals.chargedUsd);
    expect(view.totals.noCargoUsd).toBe(650);
    expect(batchRow.noCargoChargeUsd).toBe(view.totals.noCargoUsd);
    expect(tripTotals([batchRow]).noCargo).toBe(650);
    // The corridor reads only trucks marked «Partiya» (0107).
    await db.update(batches).set({ profitTracked: true }).where(eq(batches.id, t.id));
    const route = (await profitByRoute(today(), today())).find((row) => row.route === batchRow.route)!;
    expect(route.noCargoChargeUsd).toBeGreaterThanOrEqual(650);

    // 7: three readers, one set of clients.
    const orphans = view.orphans.map((row) => row.clientId).sort();
    const noCargo = (await offTruckPrices(db, { batchIds: [t.id] }))
      .filter((row) => row.kind === 'no_cargo')
      .map((row) => row.clientId)
      .sort();
    const riders = (await riderLoad([t.id])).get(t.id)!.clientIds;
    const charged = [...new Set(charges.map(({ tx }) => tx.clientId))];
    expect(orphans).toEqual([q21.a.id, q21.c.id].sort());
    expect(noCargo).toEqual(orphans);
    expect(charged.filter((id) => !riders.includes(id)).sort()).toEqual(orphans);
  });

  it('8: the client card — the price lands in offTrip, and trips + offTrip + unassigned add up to what is owed', async () => {
    await charge(q21.a.id, 100); // card-only, no truck, no deal
    await addTransaction(
      { clientId: q21.a.id, type: 'payment', amount: 50, currency: 'USD', method: 'cash', txDate: '1614-06-20' },
      ctx(),
    );
    const cargo = await clientCargo(q21.a.id);
    expect(cargo.offTrip).toEqual([
      expect.objectContaining({ batchId: q21.t.id, reason: 'no_cargo', chargedUsd: 600, owedUsd: 550, droppedTo: [q21.t2.code] }),
    ]);
    const owed =
      cargo.trips.reduce((a, trip) => a + trip.owedUsd, 0) +
      cargo.offTrip.reduce((a, off) => a + off.owedUsd, 0) +
      cargo.unassignedOwedUsd;
    expect(Math.round(owed * 100) / 100).toBe(cargo.balanceUsd);
    expect(cargo.balanceUsd).toBe(650);

    // Before departure the same kind of row reads «loading».
    const h = await mkClient('H');
    const lh = await mkLot(h.id, 2, W.yw);
    const t3 = await loadTruck([{ lotId: lh.lotId, take: 2 }], [], W.yw, W.tas);
    await charge(h.id, 300, { batchId: t3.id });
    expect((await clientCargo(h.id)).offTrip).toEqual([
      expect.objectContaining({ batchId: t3.id, reason: 'loading', chargedUsd: 300 }),
    ]);
  });
});

describe('the timing and the shape of a drop', () => {
  it('2: a price typed AFTER a hand removal is not warned about; one typed before is; void + re-enter clears it', async () => {
    const d = await mkClient('D');
    const e = await mkClient('E');
    const ld = await mkLot(d.id, 2, W.yw);
    const le = await mkLot(e.id, 2, W.yw);
    const t = await loadTruck(
      [
        { lotId: ld.lotId, take: 2 },
        { lotId: le.lotId, take: 2 },
      ],
      [...ld.codes, ...le.codes],
      W.yw,
      W.tas,
    );
    const dPrice = await charge(d.id, 200, { batchId: t.id });
    await sleep(5);
    await removeLoadedCode(t.id, ld.codes[1]!, ctx());
    await removeLoadedCode(t.id, le.codes[1]!, ctx());
    await sleep(5);
    await charge(e.id, 200, { batchId: t.id });

    let rows = await offTruckPrices(db, { batchIds: [t.id] });
    expect(rows.map((row) => row.clientId)).toEqual([d.id]);
    expect(rows[0]).toMatchObject({ kind: 'partial', dropCause: 'short_loaded' });
    expect(rows[0]!.droppedBoxIds).toEqual([ld.boxIds[1]]);

    // The accountant re-enters D's price seeing the truck as it is now.
    await voidTransaction(dPrice.id, 'qayta', ctx(), { mayMoveTill: true });
    await charge(d.id, 100, { batchId: t.id });
    rows = await offTruckPrices(db, { batchIds: [t.id] });
    expect(rows).toEqual([]);
  });

  it('3: a partial short-load warns inside the client, and stays OUT of the no-cargo part (the client rides)', async () => {
    const f = await mkClient('F');
    const lf = await mkLot(f.id, 6, W.yw);
    const t = await loadTruck([{ lotId: lf.lotId, take: 6 }], lf.codes.slice(0, 4), W.yw, W.tas);
    await charge(f.id, 900, { batchId: t.id });
    await depart(t.id);
    const rows = await offTruckPrices(db, { batchIds: [t.id] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: f.id, kind: 'partial', dropCause: 'short_loaded' });
    expect(rows[0]!.droppedBoxIds).toHaveLength(2);
    const batchRow = (await profitByBatch(today(), today())).find((row) => row.batchId === t.id)!;
    expect(batchRow.revenueUsd).toBe(900);
    expect(batchRow.noCargoChargeUsd).toBe(0);
    const trip = (await clientCargo(f.id)).trips.find((row) => row.batchId === t.id)!;
    expect(trip.dropped).toMatchObject({ boxes: 2, cause: 'short_loaded' });
  });

  it('4: Q2 — found back AFTER the price is a found-back drop that names the next truck; found back BEFORE is nothing', async () => {
    const g = await mkClient('G');
    const lg = await mkLot(g.id, 5, W.yw);
    const a = await truck([{ lotId: lg.lotId, take: 5 }], lg.codes, W.yw, W.tas);
    await charge(g.id, 600, { batchId: a.id });
    await sleep(5);
    await acceptFoundBox({ warehouseId: W.yw, code: lg.codes[4]! }, ctx());
    await unload(a.id, lg.codes.slice(0, 4));
    let rows = await offTruckPrices(db, { batchIds: [a.id] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: g.id, kind: 'partial', dropCause: 'found_back', originCode: `KY${S}` });
    expect(rows[0]!.droppedBoxIds).toEqual([lg.boxIds[4]]);
    expect(rows[0]!.droppedTo).toEqual([]);

    const b = await truck([{ lotId: lg.lotId, take: 1 }], [lg.codes[4]!], W.yw, W.tas);
    await unload(b.id, [lg.codes[4]!]);
    rows = await offTruckPrices(db, { clientIds: [g.id] });
    expect(rows.find((row) => row.batchId === a.id)!.droppedTo).toEqual([{ batchId: b.id, code: b.code, boxes: 1 }]);
    expect(pricedElsewhereFor(rows, b.id).map((row) => row.batchId)).toEqual([a.id]);

    // 9 (found-back half): A priced, the found carton rides B unpriced → B's
    // trip is unpriced and A's is not (Q2).
    const trips = (await clientCargo(g.id)).trips;
    expect(trips.find((row) => row.batchId === a.id)!.unpriced).toBe(false);
    expect(trips.find((row) => row.batchId === b.id)!.unpriced).toBe(true);

    // Found back BEFORE the price: the price saw the truck without it.
    const hg = await mkClient('HG');
    const lhg = await mkLot(hg.id, 3, W.yw);
    const a2 = await truck([{ lotId: lhg.lotId, take: 3 }], lhg.codes, W.yw, W.tas);
    await acceptFoundBox({ warehouseId: W.yw, code: lhg.codes[2]! }, ctx());
    await sleep(5);
    await charge(hg.id, 300, { batchId: a2.id });
    expect(await offTruckPrices(db, { batchIds: [a2.id] })).toEqual([]);
  });

  it('9: the trip chip is the unpriced rule — a split prixod priced once is priced on both trucks', async () => {
    const j = await mkClient('J');
    const lj = await mkLot(j.id, 4, W.yw);
    const t1 = await truck([{ lotId: lj.lotId, take: 2 }], lj.codes.slice(0, 2), W.yw, W.tas);
    const t2 = await truck([{ lotId: lj.lotId, take: 2 }], lj.codes.slice(2), W.yw, W.tas);
    await unload(t1.id, lj.codes.slice(0, 2));
    await unload(t2.id, lj.codes.slice(2));
    await charge(j.id, 400, { batchId: t1.id });
    let trips = (await clientCargo(j.id)).trips;
    expect(trips.find((row) => row.batchId === t1.id)!.unpriced).toBe(false);
    expect(trips.find((row) => row.batchId === t2.id)!).toMatchObject({ unpriced: false, chargedUsd: 0 });

    // Unpriced, landed — and unpriced still on the road.
    const k = await mkClient('K');
    const lk = await mkLot(k.id, 2, W.yw);
    const tk = await truck([{ lotId: lk.lotId, take: 2 }], lk.codes, W.yw, W.tas);
    trips = (await clientCargo(k.id)).trips;
    expect(trips.find((row) => row.batchId === tk.id)!.unpriced).toBe(true);
    await unload(tk.id, lk.codes);
    trips = (await clientCargo(k.id)).trips;
    expect(trips.find((row) => row.batchId === tk.id)!.unpriced).toBe(true);
  });
});

describe('the door (U31) and «🚚 Ko‘chirish»', () => {
  it('10: no cargo aboard is refused; planned cargo is accepted; an internal truck still says internal_batch first', async () => {
    const m = await mkClient('M');
    const other = await mkClient('MO');
    const lo = await mkLot(other.id, 1, W.yw);
    const t = await truck([{ lotId: lo.lotId, take: 1 }], lo.codes, W.yw, W.tas);
    expect(await refusal(() => charge(m.id, 100, { batchId: t.id }))).toBe('client_not_aboard');
    expect(
      await db
        .select({ id: clientTransactions.id })
        .from(clientTransactions)
        .where(and(eq(clientTransactions.clientId, m.id), eq(clientTransactions.batchId, t.id))),
    ).toEqual([]);

    const lm = await mkLot(m.id, 1, W.yw);
    const planned = await loadTruck([{ lotId: lm.lotId, take: 1 }], [], W.yw, W.tas);
    expect(await refusal(() => charge(m.id, 100, { batchId: planned.id }))).toBe('ok');

    const lo2 = await mkLot(other.id, 1, W.yw);
    const internal = await truck([{ lotId: lo2.lotId, take: 1 }], lo2.codes, W.yw, W.ka);
    expect(await refusal(() => charge(m.id, 100, { batchId: internal.id }))).toBe('internal_batch');
  });

  it('11: one part — a card-only UZS price moves onto its truck keeping every clock, and leaves the list', async () => {
    const [fx] = await db
      .insert(fxRates)
      .values({ currency: 'UZS', rateToUsd: '0.000080000000', effectiveDate: '1614-08-01', enteredBy: actorId })
      .returning({ id: fxRates.id });
    fxRowId = fx!.id;
    const n = await mkClient('N');
    const ln = await mkLot(n.id, 2, W.yw);
    const t = await truck([{ lotId: ln.lotId, take: 2 }], ln.codes, W.yw, W.tas);
    await unload(t.id, ln.codes);
    const card = await charge(n.id, 625000, { currency: 'UZS', txDate: AUG });
    expect(Number(card.amountUsd)).toBe(50);

    const gate = await unpricedGate();
    expect((await unpricedReceiptsOn(db, { kind: 'clients', clientIds: [n.id] }, gate)).map((r) => r.receiptId)).toEqual([
      ln.receiptId,
    ]);
    const pnlBefore = (await profitAndLoss('1614-08-01', '1614-08-31')).revenue.total;
    const agingOf = async () => (await arAging('1614-09-15')).find((row) => row.clientId === n.id);
    const agingBefore = await agingOf();

    // The day's rate is corrected afterwards — a move must not look like FX.
    await db.update(fxRates).set({ rateToUsd: '0.000100000000' }).where(eq(fxRates.id, fxRowId));
    const { ids } = await moveCharge({ txId: card.id, parts: [{ batchId: t.id, amount: 625000 }] }, ctx());
    const [moved] = await db.select().from(clientTransactions).where(eq(clientTransactions.id, ids[0]!));
    expect(moved).toMatchObject({
      batchId: t.id,
      currency: 'UZS',
      amountUsd: card.amountUsd,
      rateToUsd: card.rateToUsd,
      txDate: AUG,
    });
    expect(moved!.createdAt.getTime()).toBe(card.createdAt.getTime());
    const [old] = await db.select().from(clientTransactions).where(eq(clientTransactions.id, card.id));
    expect(old!.voidedAt).not.toBeNull();

    expect((await profitAndLoss('1614-08-01', '1614-08-31')).revenue.total).toBe(pnlBefore);
    expect(await agingOf()).toEqual(agingBefore);
    expect(await unpricedReceiptsOn(db, { kind: 'clients', clientIds: [n.id] }, gate)).toEqual([]);

    expect(await refusal(() => moveCharge({ txId: card.id, parts: [{ batchId: t.id, amount: 625000 }] }, ctx()))).toBe(
      'not_movable',
    );
    expect(await refusal(() => moveCharge({ txId: ids[0]!, parts: [{ batchId: t.id, amount: 625000 }] }, ctx()))).toBe(
      'move_noop',
    );
  });

  it('12: a split — Q2 before the find: 480 stays on A, 120 goes to B, the dollars add up to the cent and the warning CLEARS', async () => {
    const o = await mkClient('O');
    const lo = await mkLot(o.id, 5, W.yw);
    const a = await truck([{ lotId: lo.lotId, take: 5 }], lo.codes, W.yw, W.tas);
    const price = await charge(o.id, 600, { batchId: a.id });
    await sleep(5);
    await acceptFoundBox({ warehouseId: W.yw, code: lo.codes[4]! }, ctx());
    await unload(a.id, lo.codes.slice(0, 4));
    const b = await truck([{ lotId: lo.lotId, take: 1 }], [lo.codes[4]!], W.yw, W.tas);
    await unload(b.id, [lo.codes[4]!]);

    expect(
      await refusal(() =>
        moveCharge(
          {
            txId: price.id,
            parts: [
              { batchId: a.id, amount: 480 },
              { batchId: b.id, amount: 119.99 },
            ],
          },
          ctx(),
        ),
      ),
    ).toBe('move_sum_mismatch');

    // Before the split A warns: its price was typed before the find.
    const warned = (await offTruckPrices(db, { batchIds: [a.id] })).find((row) => row.clientId === o.id)!;
    expect(warned).toMatchObject({ kind: 'partial', dropCause: 'found_back', chargedUsd: 600 });
    expect(warned.droppedTo).toEqual([{ batchId: b.id, code: b.code, boxes: 1 }]);
    await sleep(5);

    const { ids } = await moveCharge(
      {
        txId: price.id,
        parts: [
          { batchId: a.id, amount: 480 },
          { batchId: b.id, amount: 120 },
        ],
      },
      ctx(),
    );
    const parts = await db.select().from(clientTransactions).where(inArray(clientTransactions.id, ids));
    expect(parts.map((row) => Number(row.amountUsd)).reduce((x, y) => x + y, 0)).toBe(600);
    expect(parts.every((row) => row.txDate === DAY)).toBe(true);
    expect(parts.every((row) => row.createdAt.getTime() === price.createdAt.getTime())).toBe(true);
    // The split IS the accountant's answer (review, U24): A's remaining part
    // keeps its row clock for the kurs farqi order, but it was DECIDED after
    // the find — the banner, the chip and the door all stop asking. Before,
    // it warned for ever, and the door's default moved the whole 480 too.
    const onA = (await offTruckPrices(db, { batchIds: [a.id] })).find((row) => row.clientId === o.id);
    expect(onA?.kind ?? 'none').not.toBe('partial');
    expect(onA?.droppedTo ?? []).toEqual([]);
  });

  it('12b: a moved price keeps its OWN job — the target truck’s derived deal only fills a blank (review, R3a’s order)', async () => {
    const d = await mkClient('D');
    const dealX = await createDeal({ clientId: d.id, title: `X ${S}` } as Parameters<typeof createDeal>[0], ctx());
    const dealY = await createDeal({ clientId: d.id, title: `Y ${S}` } as Parameters<typeof createDeal>[0], ctx());
    const la = await mkLot(d.id, 1, W.yw);
    const lb = await mkLot(d.id, 1, W.yw);
    await db.update(receipts).set({ dealId: dealX }).where(eq(receipts.id, la.receiptId));
    await db.update(receipts).set({ dealId: dealY }).where(eq(receipts.id, lb.receiptId));
    const a = await truck([{ lotId: la.lotId, take: 1 }], la.codes, W.yw, W.tas);
    const b = await truck([{ lotId: lb.lotId, take: 1 }], lb.codes, W.yw, W.tas);
    const price = await charge(d.id, 300, { batchId: a.id });
    expect(price.dealId).toBe(dealX);
    const { ids } = await moveCharge({ txId: price.id, parts: [{ batchId: b.id, amount: 300 }] }, ctx());
    const [moved] = await db.select().from(clientTransactions).where(eq(clientTransactions.id, ids[0]!));
    expect(moved!.dealId).toBe(dealX);
    // A deal is the client's and would outlive the client's own cleanup.
    await db.update(receipts).set({ dealId: null }).where(inArray(receipts.id, [la.receiptId, lb.receiptId]));
    await db.update(clientTransactions).set({ dealId: null }).where(eq(clientTransactions.clientId, d.id));
    await db.delete(deals).where(inArray(deals.id, [dealX, dealY]));
  });

  it('13: a split can CLOSE a so‘m cycle between its parts — the kurs farqi is written in the same press (0103, F2)', async () => {
    // Two rates of this test's own, after case 11's August row and deleted
    // below: the advance at 0.00008, the price at 0.0001.
    const rates = await db
      .insert(fxRates)
      .values([
        { currency: 'UZS', rateToUsd: '0.000080000000', effectiveDate: '1614-10-01', enteredBy: actorId },
        { currency: 'UZS', rateToUsd: '0.000100000000', effectiveDate: '1614-11-01', enteredBy: actorId },
      ])
      .returning({ id: fxRates.id });
    try {
      const p = await mkClient('P');
      const l1 = await mkLot(p.id, 1, W.yw);
      const l2 = await mkLot(p.id, 1, W.yw);
      const a = await loadTruck([{ lotId: l1.lotId, take: 1 }], [], W.yw, W.tas);
      const b = await loadTruck([{ lotId: l2.lotId, take: 1 }], [], W.yw, W.tas);
      // An advance of 2,500,000 ($200), then a 5,000,000 price on the card ($500).
      await addTransaction({ clientId: p.id, type: 'payment', amount: 2_500_000, currency: 'UZS', txDate: '1614-10-05' }, ctx());
      const card = await charge(p.id, 5_000_000, { currency: 'UZS', txDate: '1614-11-05' });
      const fxRowsOf = () =>
        db
          .select()
          .from(clientTransactions)
          .where(and(eq(clientTransactions.clientId, p.id), eq(clientTransactions.type, 'fx_diff')));
      expect(await fxRowsOf()).toEqual([]);

      // Halves: after the first one the account reads 0 so'm — a closed
      // cycle holding −$200 + $250 — whichever half sorts first.
      const { ids } = await moveCharge(
        {
          txId: card.id,
          parts: [
            { batchId: a.id, amount: 2_500_000 },
            { batchId: b.id, amount: 2_500_000 },
          ],
        },
        ctx(),
      );
      const fx = await fxRowsOf();
      expect(fx).toHaveLength(1);
      expect(fx[0]).toMatchObject({ currency: 'UZS', amount: '0.00', amountUsd: '-50.00', voidedAt: null });
      expect(ids).toContain(fx[0]!.fxAnchorId);
    } finally {
      await db.delete(fxRates).where(inArray(fxRates.id, rates.map((r) => r.id)));
    }
  });
});
