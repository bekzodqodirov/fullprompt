import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  clients,
  clientTransactions,
  costAllocations,
  costEntries,
  costTypes,
  dealStages,
  deals,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { clientProfitGaps, profitByClient } from '@/modules/wms/accounting/reports';
import { sellerPerformanceAll, sellerPerformanceOwn } from '@/modules/wms/crm/seller-report';
import { companyMoneySight } from '@/modules/wms/finance/scope';
import type { Exec } from '@/modules/wms/staff/cargo';
import { staffProfit } from '@/modules/wms/staff/seller-profit';
import { stampUnattributedCargo } from '@/modules/wms/staff/stamp';
import { costByStamp } from '@/modules/wms/staff/stamp-cost';
import { revenueByStamp } from '@/modules/wms/staff/stamp-revenue';

/**
 * 4a against a real database (his «Mijoz boshqa sotuvchiga o'tsa, dashboarddagi
 * foyda kimga yoziladi? — a) yuk kelgan kundagi sotuvchiga»): a price belongs
 * to the seller STAMPED on the prixod(s) it prices, and a cost to its carton's
 * prixod's stamp — never to the client's seller NOW, except for a client that
 * had no prixod at all.
 *
 * The fixtures sit in AUGUST 2018 — a period no other file writes a ledger row
 * in — because the report sums the WHOLE database for its period (#380).
 * Exact figures are asserted only about this file's minted sellers and
 * clients; the whole-database ones are two-sided reconciliations or ≥.
 *
 * Every red proof of this round is anchored on a fixture where the stripped
 * clause is the ONLY route (#1239's lesson): c12 is cNew's only price and cNew
 * has no prixod, so only the book reaches C; the compensation carries a deal
 * that would split it, so only the receipt branch lands it whole on B.
 */

const S = String(Date.now()).slice(-6);
const PERIOD = {
  from: new Date('2018-07-31T19:00:00Z'),
  to: new Date('2018-08-31T19:00:00Z'),
  dan: '2018-08-01',
  gacha: '2018-08-31',
};

let actorId = '';
let stageId = '';
let costTypeId = '';
let cn = '';
let uz = '';
let uz2 = '';
let A = '';
let B = '';
let C = '';
let D = '';
let cMoved = '';
let cStay = '';
let cNobody = '';
let cNew = '';
let cMix = '';
const T: Record<string, string> = {};
const DEAL: Record<string, string> = {};
const BOX: Record<string, string> = {};
const R: Record<string, string> = {};

const madeWarehouses: string[] = [];
const madeClients: string[] = [];
const madeDeals: string[] = [];
const madeBatches: string[] = [];
const madeReceipts: string[] = [];
const madeLots: string[] = [];
const madeBoxes: string[] = [];
const madeEntries: string[] = [];
let seq = 0;

const sight = companyMoneySight({ id: 'x', permissions: new Set(['finance.manage', 'finance.reports']) })!;

async function mintWarehouse(code: string, country: string) {
  const id = (
    await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name: `Stamp ${code}`, country, type: 'origin', timezone: 'Asia/Tashkent' })
      .returning({ id: warehouses.id })
  )[0]!.id;
  madeWarehouses.push(id);
  return id;
}

async function mintUser(tag: string) {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${S}${tag.charCodeAt(0) % 10}`, fullName: `Stamp ${tag} ${S}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  return u!.id;
}

async function mintClient(tag: string, managerId: string | null) {
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `SP${S}${tag}`, name: `Stamp ${tag}`, salesManagerId: managerId })
    .returning({ id: clients.id });
  madeClients.push(c!.id);
  return c!.id;
}

async function mintDeal(tag: string, clientId: string) {
  const [d] = await db
    .insert(deals)
    .values({ code: `SP${S}-${tag}`, clientId, stageId, title: `Stamp deal ${tag}`, createdBy: actorId })
    .returning({ id: deals.id });
  madeDeals.push(d!.id);
  return d!.id;
}

async function mintTruck(tag: string, origin: string, dest: string, status: 'in_transit' | 'loading') {
  const id = uuidv4();
  await db.insert(batches).values({
    id,
    code: `SP${S}-${tag}`,
    originWarehouseId: origin,
    destWarehouseId: dest,
    status,
    departedAt: status === 'in_transit' ? new Date('2018-08-02T10:00:00+05:00') : null,
    createdBy: actorId,
  });
  madeBatches.push(id);
  return id;
}

/** One confirmed prixod of one lot; `boxes` are the cartons' names in this file. */
async function prixod(opts: {
  tag: string;
  clientId: string | null;
  stamp: string | null;
  dealId?: string | null;
  day: string;
  m3: string;
  kg: string;
  cartons: string[];
}) {
  const [r] = await db
    .insert(receipts)
    .values({
      warehouseId: cn,
      clientId: opts.clientId,
      salesManagerId: opts.stamp,
      dealId: opts.dealId ?? null,
      status: 'confirmed',
      unclaimedMarking: opts.clientId === null ? `SP${S}MARK` : null,
      receivedAt: new Date(`${opts.day}T10:00:00+05:00`),
      confirmedAt: new Date(`${opts.day}T10:00:00+05:00`),
      createdBy: actorId,
    })
    .returning({ id: receipts.id });
  madeReceipts.push(r!.id);
  R[opts.tag] = r!.id;
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: r!.id,
      seq: 1,
      productNameZh: `货${S}${opts.tag}`,
      boxCount: opts.cartons.length,
      totalWeightKg: opts.kg,
      totalVolumeM3: opts.m3,
    })
    .returning({ id: receiptLots.id });
  madeLots.push(lot!.id);
  let n = 0;
  for (const name of opts.cartons) {
    n += 1;
    seq += 1;
    const [b] = await db
      .insert(boxes)
      .values({ lotId: lot!.id, shortCode: `SP${S}X${seq}`, seqInLot: n, status: 'in_stock', currentWarehouseId: cn })
      .returning({ id: boxes.id });
    madeBoxes.push(b!.id);
    BOX[name] = b!.id;
  }
  return r!.id;
}

/** The carton rode the truck: its departure movement, the rider rule's own evidence. */
async function depart(box: string, truck: string, from: string, to: string) {
  await db
    .update(boxes)
    .set({ status: 'in_transit', currentWarehouseId: null })
    .where(eq(boxes.id, BOX[box]!));
  await db.insert(boxMovements).values({
    boxId: BOX[box]!,
    fromWarehouseId: from,
    toWarehouseId: to,
    fromStatus: 'loading',
    toStatus: 'in_transit',
    cause: 'batch_departed',
    refType: 'batch',
    refId: truck,
    actorId,
  });
}

async function tx(opts: {
  clientId: string;
  type?: 'charge' | 'payment' | 'compensation';
  amount: string;
  date: string;
  batchId?: string;
  dealId?: string;
  receiptId?: string;
  note?: string;
  voided?: boolean;
}) {
  const type = opts.type ?? 'charge';
  await db.insert(clientTransactions).values({
    clientId: opts.clientId,
    type,
    amount: opts.amount,
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: opts.amount,
    txDate: opts.date,
    batchId: opts.batchId ?? null,
    dealId: opts.dealId ?? null,
    receiptId: opts.receiptId ?? null,
    method: type === 'payment' ? 'cash' : null,
    note: opts.note ?? null,
    createdBy: actorId,
    ...(opts.voided ? { voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' } : {}),
  });
}

async function cost(opts: {
  scope: 'batch' | 'receipt';
  target: string;
  amount: string;
  date: string;
  voided?: boolean;
  allocations: [box: string, clientId: string | null, usd: string][];
}) {
  const [e] = await db
    .insert(costEntries)
    .values({
      scope: opts.scope,
      batchId: opts.scope === 'batch' ? opts.target : null,
      receiptId: opts.scope === 'receipt' ? opts.target : null,
      costTypeId,
      amount: opts.amount,
      currency: 'USD',
      amountUsd: opts.amount,
      fxRateUsed: '1',
      costDate: opts.date,
      enteredBy: actorId,
      ...(opts.voided ? { voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' } : {}),
    })
    .returning({ id: costEntries.id });
  madeEntries.push(e!.id);
  for (const [box, clientId, usd] of opts.allocations) {
    await db.insert(costAllocations).values({ costEntryId: e!.id, boxId: BOX[box]!, clientId, amountUsd: usd });
  }
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  costTypeId = (await db.query.costTypes.findFirst({ where: eq(costTypes.active, true) }))!.id;
  cn = await mintWarehouse(`SC${S}`, 'CN');
  uz = await mintWarehouse(`SU${S}`, 'UZ');
  uz2 = await mintWarehouse(`SV${S}`, 'UZ');
  A = await mintUser('A');
  B = await mintUser('B');
  C = await mintUser('C');
  D = await mintUser('D');

  cMoved = await mintClient('M', B); // moved from A to B
  cStay = await mintClient('S', C); // book C, stamp A — the carton rules cannot hide behind the book
  cNobody = await mintClient('N', null);
  cNew = await mintClient('W', C); // book C and NO prixod: the book is its only route
  cMix = await mintClient('X', D);

  DEAL.A = await mintDeal('DA', cMoved);
  DEAL.B = await mintDeal('DB', cMoved);
  DEAL.M = await mintDeal('DM', cMoved);
  DEAL.empty = await mintDeal('DE', cMoved);

  T.T1 = await mintTruck('T1', cn, uz, 'in_transit');
  T.T2 = await mintTruck('T2', cn, uz, 'in_transit');
  T.T3 = await mintTruck('T3', cn, uz, 'loading');
  T.T4 = await mintTruck('T4', cn, uz, 'in_transit'); // carries nothing
  T.T5 = await mintTruck('T5', uz, uz2, 'in_transit'); // a LOCAL Uzbek leg
  T.T6 = await mintTruck('T6', cn, uz, 'in_transit');

  await prixod({ tag: 'R1', clientId: cMoved, stamp: A, dealId: DEAL.A, day: '2018-07-05', m3: '3', kg: '300', cartons: ['1a', '1b', '1c'] });
  await prixod({ tag: 'R8', clientId: cMoved, stamp: A, dealId: DEAL.M, day: '2018-07-06', m3: '1.5', kg: '150', cartons: ['8a'] });
  await prixod({ tag: 'R2', clientId: cMoved, stamp: B, dealId: DEAL.B, day: '2018-08-10', m3: '0.5', kg: '50', cartons: ['2a'] });
  await prixod({ tag: 'R7', clientId: cMoved, stamp: B, dealId: DEAL.M, day: '2018-08-11', m3: '0.5', kg: '50', cartons: ['7a'] });
  await prixod({ tag: 'R3', clientId: cStay, stamp: A, day: '2018-07-10', m3: '1', kg: '100', cartons: ['3a', '3b'] });
  await prixod({ tag: 'R3n', clientId: cStay, stamp: C, day: '2018-08-01', m3: '0.2', kg: '20', cartons: ['3n'] });
  await prixod({ tag: 'R4', clientId: cNobody, stamp: null, day: '2018-07-12', m3: '0.3', kg: '30', cartons: ['4a'] });
  await prixod({ tag: 'R9', clientId: cMix, stamp: A, day: '2018-07-15', m3: '1', kg: '10', cartons: ['9a'] });
  await prixod({ tag: 'R10', clientId: cMix, stamp: D, day: '2018-07-16', m3: '0', kg: '30', cartons: ['10a'] });
  await prixod({ tag: 'R5', clientId: null, stamp: null, day: '2018-07-20', m3: '0.1', kg: '10', cartons: ['5a'] });

  await depart('1a', T.T1, cn, uz);
  await depart('1b', T.T2, cn, uz);
  await depart('1c', T.T5, uz, uz2);
  await depart('2a', T.T2, cn, uz);
  await depart('4a', T.T1, cn, uz);
  await depart('9a', T.T6, cn, uz);
  await depart('10a', T.T6, cn, uz);
  // 3a is planned onto the truck that has not left: the live pointer, no movement.
  await db.update(boxes).set({ status: 'planned', currentBatchId: T.T3 }).where(eq(boxes.id, BOX['3a']!));
  await db.update(boxes).set({ status: 'lost' }).where(inArray(boxes.id, [BOX['3b']!, BOX['7a']!]));

  await tx({ clientId: cMoved, amount: '300.00', date: '2018-08-15', batchId: T.T1 }); // c1 → A
  await tx({ clientId: cMoved, amount: '100.00', date: '2018-08-16', batchId: T.T2 }); // c2 → A 66.67 / B 33.33
  await tx({ clientId: cStay, amount: '120.00', date: '2018-08-15', batchId: T.T3 }); // c3 → A (live pointer)
  await tx({ clientId: cMoved, amount: '70.00', date: '2018-08-12', batchId: T.T4, dealId: DEAL.A }); // c4 → B
  await tx({ clientId: cMoved, amount: '50.00', date: '2018-08-17', batchId: T.T5 }); // c5 → A (local leg)
  await tx({ clientId: cMoved, amount: '60.00', date: '2018-08-18', dealId: DEAL.A }); // c6 → A
  await tx({ clientId: cMoved, amount: '80.00', date: '2018-08-19', dealId: DEAL.B }); // c7 → B
  await tx({ clientId: cMoved, amount: '20.00', date: '2018-08-06', dealId: DEAL.empty }); // c8 → A (R8)
  await tx({ clientId: cMoved, amount: '40.00', date: '2018-08-05' }); // c9 → A (R8)
  await tx({ clientId: cMoved, amount: '35.00', date: '2018-08-20' }); // c9b → B (R7)
  await tx({ clientId: cNobody, amount: '15.00', date: '2018-08-15' }); // c10 → «—» (R4)
  await tx({ clientId: cNobody, amount: '30.00', date: '2018-08-16', batchId: T.T1 }); // c11 → «—» (4a)
  await tx({ clientId: cNew, amount: '11.00', date: '2018-08-20' }); // c12 → C (the book)
  await tx({ clientId: cMix, amount: '400.00', date: '2018-08-22', batchId: T.T6 }); // c13 → A 100 / D 300 by kg
  // Production's shape: a compensation names its prixod AND that prixod's deal.
  await tx({
    clientId: cMoved,
    type: 'compensation',
    amount: '25.00',
    date: '2018-08-21',
    receiptId: R.R7,
    dealId: DEAL.M,
    note: 'yo‘qolgan yuk',
  });
  // Out of the figures: voided, after the period, not revenue.
  await tx({ clientId: cMoved, amount: '999.00', date: '2018-08-11', voided: true });
  await tx({ clientId: cMoved, amount: '555.00', date: '2018-09-01' });
  await tx({ clientId: cMoved, type: 'payment', amount: '100.00', date: '2018-08-15' });

  await cost({
    scope: 'batch',
    target: T.T2,
    amount: '20.01',
    date: '2018-08-10',
    allocations: [
      ['1b', cMoved, '10.0045'],
      ['2a', cMoved, '10.0035'],
    ],
  }); // E1
  await cost({ scope: 'receipt', target: R.R3!, amount: '7.00', date: '2018-08-11', allocations: [['3b', cStay, '7.0000']] }); // E2
  await cost({ scope: 'receipt', target: R.R5!, amount: '5.00', date: '2018-08-12', allocations: [['5a', null, '5.0000']] }); // E3
  await cost({ scope: 'batch', target: T.T1, amount: '3.00', date: '2018-08-13', voided: true, allocations: [['1a', cMoved, '3.0000']] }); // E4
  await cost({ scope: 'batch', target: T.T1, amount: '9.00', date: '2018-07-31', allocations: [['1a', cMoved, '9.0000']] }); // E5
  await cost({ scope: 'receipt', target: R.R4!, amount: '4.00', date: '2018-08-14', allocations: [['4a', cNobody, '4.0000']] }); // E6
});

afterAll(async () => {
  if (madeEntries.length > 0) {
    await db.delete(costAllocations).where(inArray(costAllocations.costEntryId, madeEntries));
    await db.delete(costEntries).where(inArray(costEntries.id, madeEntries));
  }
  if (madeClients.length > 0) await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
  if (madeBoxes.length > 0) {
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, madeBoxes));
    await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  }
  if (madeLots.length > 0) await db.delete(receiptLots).where(inArray(receiptLots.id, madeLots));
  if (madeReceipts.length > 0) await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  if (madeDeals.length > 0) await db.delete(deals).where(inArray(deals.id, madeDeals));
  if (madeBatches.length > 0) await db.delete(batches).where(inArray(batches.id, madeBatches));
  if (madeClients.length > 0) await db.delete(clients).where(inArray(clients.id, madeClients));
  if (madeWarehouses.length > 0) await db.delete(warehouses).where(inArray(warehouses.id, madeWarehouses));
  // Deactivated, never deleted (house rule: an audited person stays).
  const minted = [A, B, C, D].filter(Boolean);
  if (minted.length > 0) await db.update(users).set({ active: false }).where(inArray(users.id, minted));
  await pgClient.end();
});

const mine = () => new Set(madeClients);
async function revenueRows(scope: Parameters<typeof revenueByStamp>[2] = { kind: 'all' }) {
  const out = await revenueByStamp(db, PERIOD, scope);
  return { ...out, rows: out.rows.filter((r) => mine().has(r.clientId)) };
}
const rowOf = <Row extends { clientId: string; sellerId: string | null }>(
  rows: Row[],
  clientId: string,
  sellerId: string | null,
) => rows.find((r) => r.clientId === clientId && r.sellerId === sellerId);
const sellerRow = async (id: string | null) => (await sellerPerformanceAll(PERIOD)).rows.find((r) => r.managerId === id)!;

describe('who a price belongs to (4a)', () => {
  it('a client moved A→B: the truck price on A’s cargo stays with A', async () => {
    const { rows } = await sellerPerformanceAll(PERIOD);
    const at = (id: string) => rows.find((r) => r.managerId === id)!;
    expect(at(A).revenueUsd).toBe(756.67);
    expect(at(B).revenueUsd).toBe(193.33);
    expect(at(C).revenueUsd).toBe(11);
    expect(at(D).revenueUsd).toBe(300);
    expect(at(A).costUsd).toBe(17.01);
    expect(at(B).costUsd).toBe(10);
    expect(at(A).profitUsd).toBe(739.66);
    expect(at(B).profitUsd).toBe(183.33);
    expect(at(C).profitUsd).toBe(11);
    expect(at(D).profitUsd).toBe(300);
  });

  it('one price over two sellers’ cargo is split by m³, to the cent', async () => {
    const { rows } = await revenueRows();
    expect(rowOf(rows, cMoved, A)).toMatchObject({ cents: 53667, unlinkedCents: 6000, splitCents: 6667 });
    expect(rowOf(rows, cMoved, B)).toMatchObject({ cents: 19333, unlinkedCents: 10500, splitCents: 3333 });
  });

  it('a rider with no m³ is not a $0 rider — the split falls to kg', async () => {
    const { rows } = await revenueRows();
    expect(rowOf(rows, cMix, A)).toMatchObject({ cents: 10000, unlinkedCents: 0, splitCents: 10000 });
    expect(rowOf(rows, cMix, D)).toMatchObject({ cents: 30000, unlinkedCents: 0, splitCents: 30000 });
  });

  it('a truck price whose cargo is not aboard falls back to the prixods, never to its deal', async () => {
    // c4 names T4 (nothing of cMoved aboard) and D_A (A's prixod): it must land
    // on B through the newest prixod by 08-12 (R7), never on A through D_A.
    const { rows } = await revenueRows();
    expect(rowOf(rows, cMoved, B)!.unlinkedCents).toBe(10500); // c4 + c9b
    expect(rowOf(rows, cMoved, A)!.cents).toBe(53667); // no 70 in it
  });

  it('the price door’s relation, not the gate’s: the live pointer and a local leg both count', async () => {
    const { rows } = await revenueRows();
    // c3: 3a is only PLANNED onto T3 — the fallback would have been R3n's C.
    expect(rowOf(rows, cStay, A)).toMatchObject({ cents: 12000, unlinkedCents: 0 });
    expect(rowOf(rows, cStay, C)).toBeUndefined();
    // c5 on the UZ→UZ2 leg is inside A's 53667 (the gate's `covers` rejects it).
    expect(rowOf(rows, cMoved, A)!.cents - 30000 - 6667 - 6000 - 2000 - 4000).toBe(5000);
  });

  it('a compensation lowers its prixod’s seller, whatever its deal or its client’s book', async () => {
    // D_M carries A's R8 and B's R7: through the deal the −25 would split
    // 18.75 A / 6.25 B. A row that names a prixod is never asked about its
    // deal or a fallback, so with the receipt branch stripped it falls to the
    // BOOK — which is B here too. The book is moved to D for this test, so
    // the receipt is the ONLY route that lands the −25 on B (#1239's lesson).
    await db.update(clients).set({ salesManagerId: D }).where(eq(clients.id, cMoved));
    try {
      expect((await sellerRow(B)).revenueUsd).toBe(193.33);
      expect((await sellerRow(A)).revenueUsd).toBe(756.67);
      expect((await sellerRow(D)).revenueUsd).toBe(300);
    } finally {
      await db.update(clients).set({ salesManagerId: B }).where(eq(clients.id, cMoved));
    }
  });
});

describe('the reconciliation', () => {
  it('per client the sellers sum to «Mijoz foydasi»’s row, and the totals are Σ of its rows', async () => {
    const [revenue, costs, byClient, all] = await Promise.all([
      revenueRows(),
      costByStamp(db, PERIOD),
      profitByClient(PERIOD.dan, PERIOD.gacha),
      sellerPerformanceAll(PERIOD),
    ]);
    const cents = (n: number) => Math.round(n * 100);
    for (const clientId of [cMoved, cStay, cNobody, cNew, cMix]) {
      const oracle = byClient.find((r) => r.clientId === clientId)!;
      const rev = revenue.rows.filter((r) => r.clientId === clientId).reduce((t, r) => t + r.cents, 0);
      const cost = costs.filter((r) => r.clientId === clientId).reduce((t, r) => t + r.cents, 0);
      expect(rev, clientId).toBe(cents(oracle.revenueUsd));
      expect(cost, clientId).toBe(cents(oracle.costUsd));
      expect(rev - cost, clientId).toBe(cents(oracle.profitUsd));
    }
    // The oracle's own figures for this file's clients, so the test above is not
    // reconciling two readers that are wrong the same way.
    const o = (id: string) => byClient.find((r) => r.clientId === id)!;
    expect([o(cMoved).revenueUsd, o(cMoved).costUsd, o(cMoved).profitUsd]).toEqual([730, 20.01, 709.99]);
    expect([o(cStay).revenueUsd, o(cStay).costUsd]).toEqual([120, 7]);
    expect([o(cNobody).revenueUsd, o(cNobody).costUsd]).toEqual([45, 4]);
    expect([o(cNew).revenueUsd, o(cMix).revenueUsd]).toEqual([11, 400]);

    // Two-sided, whole database: this holds for ANY data in the period.
    const sum = (pick: (r: (typeof byClient)[number]) => number) =>
      byClient.reduce((t, r) => t + Math.round(pick(r) * 100), 0) / 100;
    expect(all.totals.revenueUsd).toBe(sum((r) => r.revenueUsd));
    expect(all.totals.costUsd).toBe(sum((r) => r.costUsd));
    expect(all.totals.profitUsd).toBe(sum((r) => r.profitUsd));

    // Unclaimed cargo cost money, and it is nobody's score: the report is the
    // CLIENT rows' sum, never the profit tab's Jami.
    const gaps = await clientProfitGaps(PERIOD.dan, PERIOD.gacha);
    expect(gaps.unclaimed.usd).toBeGreaterThanOrEqual(5);
    expect(costs.some((r) => r.clientId === null)).toBe(false);
  });

  it('cost follows the carton, lost or not, and never unclaimed cargo', async () => {
    const every = await costByStamp(db, PERIOD);
    // E3 sits on unclaimed cargo: no row of nobody's client, anywhere.
    expect(every.some((r) => r.clientId === null)).toBe(false);
    const costs = every.filter((r) => mine().has(r.clientId));
    // E2 sits on 3b — LOST, and its client's book is C: the stamp is A.
    expect(rowOf(costs, cStay, A)).toMatchObject({ cents: 700 });
    expect(rowOf(costs, cStay, C)).toBeUndefined();
    // E1's target is 2001¢: the .45 remainder takes the cent.
    expect(rowOf(costs, cMoved, A)).toMatchObject({ cents: 1001 });
    expect(rowOf(costs, cMoved, B)).toMatchObject({ cents: 1000 });
    expect(rowOf(costs, cNobody, null)).toMatchObject({ cents: 400 });
    expect(costs).toHaveLength(4);
  });
});

describe('the seller’s own card', () => {
  it('own equals all, fallback included, and carries only own money', async () => {
    const { rows } = await sellerPerformanceAll(PERIOD);
    for (const [id, usd] of [
      [A, 756.67],
      [B, 193.33],
      [C, 11],
      [D, 300],
    ] as const) {
      const own = await sellerPerformanceOwn(id, PERIOD);
      expect(own.revenueUsd, id).toBe(usd);
      expect(own.revenueUsd, id).toBe(rows.find((r) => r.managerId === id)!.revenueUsd);
    }

    const ownB = await revenueByStamp(db, PERIOD, { kind: 'own', userId: B });
    expect(ownB.rows.every((r) => r.sellerId === B)).toBe(true);
    expect(ownB.split).toEqual({ charges: 1, cents: 3333 });
    expect(ownB.unlinked).toEqual({ charges: 2, cents: 10500 });

    const ownA = await revenueByStamp(db, PERIOD, { kind: 'own', userId: A });
    expect(ownA.rows.every((r) => r.sellerId === A)).toBe(true);
    expect(ownA.split).toEqual({ charges: 2, cents: 16667 });
    expect(ownA.unlinked).toEqual({ charges: 2, cents: 6000 });
  });

  it('the dashboard card is the report', async () => {
    const card = await staffProfit({ from: PERIOD.dan, to: PERIOD.gacha }, sight);
    const row = (id: string) => card.rows.find((r) => r.sellerId === id)!;
    expect(row(A).cargoProfitUsd).toBe(739.66);
    expect(row(B).cargoProfitUsd).toBe(183.33);
    expect(row(D).cargoProfitUsd).toBe(300);
    for (const id of [A, B, D]) expect(row(id).sellerActive).toBe(true);
  });

  it('a fixed number of statements for any number of rows (#432)', async () => {
    let calls = 0;
    const counting: Exec = {
      execute: ((q: Parameters<typeof db.execute>[0]) => {
        calls += 1;
        return db.execute(q);
      }) as typeof db.execute,
    };
    await revenueByStamp(counting, PERIOD, { kind: 'all' });
    expect(calls).toBe(4); // the ledger, the riders, the job prixods, the fallback
    calls = 0;
    await costByStamp(counting, PERIOD);
    expect(calls).toBe(1);
  });
});

describe('moving the book', () => {
  it('moving the client again moves no money — only «Mijozlar»', async () => {
    const before = await sellerPerformanceAll(PERIOD);
    const clientsOf = (all: typeof before, id: string) => all.rows.find((r) => r.managerId === id)?.clients ?? 0;
    await db.update(clients).set({ salesManagerId: D }).where(eq(clients.id, cMoved));
    try {
      const after = await sellerPerformanceAll(PERIOD);
      expect(after.rows.find((r) => r.managerId === A)!.revenueUsd).toBe(756.67);
      expect(after.rows.find((r) => r.managerId === B)!.revenueUsd).toBe(193.33);
      expect(clientsOf(after, B)).toBe(clientsOf(before, B) - 1);
      expect(clientsOf(after, D)).toBe(clientsOf(before, D) + 1);
    } finally {
      await db.update(clients).set({ salesManagerId: B }).where(eq(clients.id, cMoved));
    }
  });

  it('only a client with no prixod follows the book', async () => {
    await db.update(clients).set({ salesManagerId: D }).where(eq(clients.id, cNew));
    try {
      const { rows } = await sellerPerformanceAll(PERIOD);
      expect(rows.find((r) => r.managerId === C)!.revenueUsd).toBe(0);
      expect(rows.find((r) => r.managerId === D)!.revenueUsd).toBe(311);
    } finally {
      await db.update(clients).set({ salesManagerId: C }).where(eq(clients.id, cNew));
    }
  });

  it('a deactivated seller keeps their money and is marked', async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, D));
    try {
      const d = await sellerRow(D);
      expect(d.managerActive).toBe(false);
      expect(d.revenueUsd).toBe(300);
      const card = await staffProfit({ from: PERIOD.dan, to: PERIOD.gacha }, sight);
      expect(card.rows.find((r) => r.sellerId === D)!.sellerActive).toBe(false);
    } finally {
      await db.update(users).set({ active: true }).where(eq(users.id, D));
    }
  });

  it('the figures the full table names under itself (whole database, ≥)', async () => {
    const all = await sellerPerformanceAll(PERIOD);
    expect(all.unlinked.charges).toBeGreaterThanOrEqual(6); // c4 c8 c9 c9b c10 c12
    expect(all.unlinked.usd).toBeGreaterThanOrEqual(191);
    expect(all.split.charges).toBeGreaterThanOrEqual(2); // c2 c13
    expect(all.split.usd).toBeGreaterThanOrEqual(500);
  });

  // LAST on purpose: it changes a past period, as naming a first seller does.
  it('naming the first seller moves the «—» money too', async () => {
    await db.update(clients).set({ salesManagerId: C }).where(eq(clients.id, cNobody));
    expect(await stampUnattributedCargo(db, cNobody, C, { actorId })).toBe(1);
    const { rows } = await revenueRows();
    const costs = await costByStamp(db, PERIOD);
    expect(rowOf(rows, cNobody, null)).toBeUndefined();
    expect(rowOf(costs, cNobody, null)).toBeUndefined();
    expect(rowOf(rows, cNobody, C)).toMatchObject({ cents: 4500 });
    expect(rowOf(costs, cNobody, C)).toMatchObject({ cents: 400 });
    const c = await sellerRow(C);
    expect(c.revenueUsd).toBe(56);
    expect(c.costUsd).toBe(4);
  });
});
