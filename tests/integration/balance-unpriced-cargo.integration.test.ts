import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clientNotices,
  clientTransactions,
  clients,
  costEntries,
  costTypes,
  currencies,
  dealStages,
  deals,
  moneyAccounts,
  partnerTransactions,
  partnerTypes,
  partners,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt, markBoxLost } from '@/modules/wms/receipts/service';
import { assignReceiptClient } from '@/modules/wms/receipts/edit';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ingestLoadScans } from '@/modules/wms/scanning/service';
import { finishUnload, ingestUnloadScans } from '@/modules/wms/scanning/unload';
import { acceptFoundBox } from '@/modules/wms/inventory/service';
import { IssueError, issueBoxes } from '@/modules/wms/issue/service';
import { addTransaction, moveCharge } from '@/modules/wms/finance/service';
import { linkReceipt } from '@/modules/wms/deals/service';
import {
  addCostEntry,
  placeCostAccount,
  recomputeAll,
  setCostStaffPayer,
  unplacedCostSince,
  voidCostEntry,
} from '@/modules/wms/costing/service';
import {
  CARD_PRICE_RULE,
  companyBalance,
  kassaRatesToday,
  unpricedCargoMoney,
  type CardRule,
} from '@/modules/wms/accounting/reports';
import { balanceLines } from '@/modules/wms/accounting/balance-lines';
import {
  uncoveredCtes,
  uncoveredMoneyCtes,
  unpricedGate,
  unpricedScopeSql,
  type GateSince,
} from '@/modules/wms/finance/unpriced';
import { tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * «Narxi hali yozilmagan yukka sarflangan» (U03, the owner's Q16 A): the
 * money we already spent carrying cargo whose price is not written yet is
 * ADDED into Sof holat — so paying a truck's cost moves the net by nothing,
 * and pricing moves it by the price minus the cost. Not counted: unclaimed
 * cargo, lost cartons, cargo handed over before the ban, and — his (i) — the
 * cargo of a client whose price names no cargo, dated on or after it.
 *
 * Real doors only: confirmReceipt, the plan and its verdict, the load scans,
 * departBatch, the unload, addCostEntry (kassa / firm / queue),
 * addTransaction, placeCostAccount, setCostStaffPayer, acceptFoundBox,
 * markBoxLost, assignReceiptClient, linkReceipt, moveCharge, issueBoxes,
 * voidCostEntry, recomputeAll. Every figure is a DELTA of `companyBalance()`
 * (CI runs every suite on one database), and every client, kassa and firm is
 * this file's own.
 *
 * Money lives in 1663 (no other file's year). A price that must retire
 * TODAY's cargo is dated `tashkentDay()` (R5). An «old» cost — typed before
 * `cost_kassa_since` — is minted by moving its `created_at` back, and dated
 * in 1663: every kassa in CI, seeded or left by another file, was counted
 * after 1663, so an old cost is «inside every count» by construction, and a
 * test that wants one OUT says so with an early-count fixture kassa that it
 * DELETES in its own `finally` (a retired kassa stays in the old-cost set).
 * The blocks that need no stray kassa PARK every active one and put them
 * back exactly as found (#183). The ban's instant is never written: a carton
 * that must count as handed over BEFORE it has its own issue movement moved
 * to 2020. Money is voided at the end, never deleted; the cargo stays.
 */

const S = String(Date.now()).slice(-6);
const Y = '1663';
let actorId = '';
let stageId = '';
let freightType = '';
let customsType = '';
let gate: GateSince;
let K = ''; // a USD kassa with no count: every row it pays lowers it
let firmId = '';
let staffId = '';
const W: Record<'yw' | 'ka' | 'and' | 'tas', string> = { yw: '', ka: '', and: '', tas: '' };
const madeClients: string[] = [];
const madeCosts: string[] = [];
const madeTills: string[] = [];
const ctx = () => ({ actorId });
const cents = (value: number) => Math.round(value * 100) / 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `Balans ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let clientSeq = 0;
async function mkClient(tag: string) {
  clientSeq += 1;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `B${clientSeq}${tag}${S}`.slice(0, 10).toUpperCase(), name: `Balans ${tag} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(row!.id);
  return row!.id;
}

let dealSeq = 0;
async function mkDeal(clientId: string) {
  dealSeq += 1;
  const [row] = await db
    .insert(deals)
    .values({ code: `BL${S}-${dealSeq}`, clientId, stageId, title: `Balans bitim ${dealSeq}`, createdBy: actorId })
    .returning({ id: deals.id });
  return row!.id;
}

async function till(name: string, over: Partial<typeof moneyAccounts.$inferInsert> = {}) {
  const [row] = await db
    .insert(moneyAccounts)
    .values({ name: `Balans ${name} ${S}`, currency: 'USD', ...over })
    .returning({ id: moneyAccounts.id });
  madeTills.push(row!.id);
  return row!.id;
}

async function mkLot(clientId: string | null, boxCount: number, warehouseId: string, dealId: string | null = null) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `balans/${lotId}`,
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
      dealId,
      unclaimedMarking: clientId ? '' : `BLM${S}${boxCount}`,
      lots: [
        {
          id: lotId,
          productNameZh: '货',
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

type Pay = { accountId?: string; partnerId?: string };
async function cost(
  where: { batchId: string } | { receiptId: string },
  amount: number,
  pay: Pay = {},
  opts: { type?: string; day?: string } = {},
) {
  const entry = await addCostEntry(
    {
      scope: 'batchId' in where ? 'batch' : 'receipt',
      ...where,
      costTypeId: opts.type ?? freightType,
      amount,
      currency: 'USD',
      costDate: opts.day ?? `${Y}-06-10`,
      allocationBasis: 'weight',
      ...pay,
    } as never,
    ctx(),
  );
  madeCosts.push(entry.id);
  return entry.id;
}

/** An «old» cost: typed before `cost_kassa_since`, never on the queue. */
async function backdate(costId: string) {
  await db.update(costEntries).set({ createdAt: new Date('2000-01-01T00:00:00Z') }).where(eq(costEntries.id, costId));
}

async function charge(clientId: string, amount: number, where: { batchId?: string; dealId?: string; txDate?: string } = {}) {
  return addTransaction(
    {
      clientId,
      type: 'charge',
      amount,
      currency: 'USD',
      txDate: where.txDate ?? tashkentDay(),
      batchId: where.batchId,
      dealId: where.dealId,
    },
    ctx(),
  );
}

async function issue(clientId: string, warehouseId: string, boxIds: string[]) {
  try {
    await issueBoxes(
      {
        handoverId: uuidv4(),
        clientId,
        warehouseId,
        boxIds,
        personName: 'Oluvchi',
        personPhone: '+998901112233',
        debtOk: true,
        priceOk: true,
      },
      ctx(),
    );
    return 'ok';
  } catch (err) {
    if (err instanceof IssueError) return err.code;
    throw err;
  }
}

async function snap() {
  const b = await companyBalance();
  return { net: b.netUsd, line: b.unpricedCargoUsd, cash: b.cashUsd, payable: b.payableUsd, c: b.unpricedCargo, b };
}
type Snap = Awaited<ReturnType<typeof snap>>;
const delta = (from: Snap, to: Snap, key: 'net' | 'line' | 'cash' | 'payable') => cents(to[key] - from[key]);

async function inputs() {
  const [since, rates] = await Promise.all([unplacedCostSince(), kassaRatesToday()]);
  const ratedCurrencies = [...rates].filter(([, r]) => r !== null && r > 0).map(([c]) => c);
  return { since, ratedCurrencies, gate };
}
/** The line under a card rule and a history mode — the switch's own read. */
async function lineUnder(cardRule: CardRule, history: 'since_gate' | 'all' = 'since_gate') {
  return unpricedCargoMoney({ ...(await inputs()), cardRule, history });
}
/** Sof holat as it would read under `rule`: today's net with the line swapped. */
async function netUnder(rule: CardRule) {
  const b = await companyBalance();
  return cents(b.netUsd - b.unpricedCargoUsd + (await lineUnder(rule)).lineUsd);
}

async function parkActiveKassas(): Promise<string[]> {
  const parked = (
    await db.select({ id: moneyAccounts.id }).from(moneyAccounts).where(eq(moneyAccounts.active, true))
  ).map((row) => row.id);
  if (parked.length) await db.update(moneyAccounts).set({ active: false }).where(inArray(moneyAccounts.id, parked));
  return parked;
}
async function unpark(parked: string[]) {
  if (parked.length) await db.update(moneyAccounts).set({ active: true }).where(inArray(moneyAccounts.id, parked));
}

/**
 * A kassa counted EARLY (its opening date on or before a 1663 cost's day):
 * the fixture that takes an old cost OUT of the line. Holds no money and no
 * row names it, so it is DELETED — left behind it would push every later old
 * cost in CI out (a retired kassa stays in the old-cost set).
 */
async function withEarlyCount<T>(openingDate: string, body: () => Promise<T>): Promise<T> {
  const [row] = await db
    .insert(moneyAccounts)
    .values({ name: `Balans erta sanoq ${S}`, currency: 'USD', openingDate, active: false })
    .returning({ id: moneyAccounts.id });
  try {
    return await body();
  } finally {
    await db.delete(moneyAccounts).where(eq(moneyAccounts.id, row!.id));
  }
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  const types = await db.select({ id: costTypes.id, code: costTypes.code }).from(costTypes);
  freightType = (types.find((t) => t.code === 'freight') ?? types[0]!).id;
  customsType = (types.find((t) => t.code === 'customs') ?? types[1] ?? types[0]!).id;
  gate = await unpricedGate();
  W.yw = await mintWarehouse(`BY${S}`, 'CN', 'origin');
  // A Chinese hub for the internal leg, and a Uzbek one to plan onward from.
  W.ka = await mintWarehouse(`BK${S}`, 'CN', 'hub');
  W.and = await mintWarehouse(`BA${S}`, 'UZ', 'hub');
  W.tas = await mintWarehouse(`BT${S}`, 'UZ', 'distribution');
  K = await till('USD kassa');
  const [transport] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'transport'));
  const [staffType] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'staff'));
  firmId = (
    await db
      .insert(partners)
      .values({ name: `Balans firma ${S}`, typeId: (transport ?? staffType)!.id, createdBy: actorId })
      .returning({ id: partners.id })
  )[0]!.id;
  staffId = (
    await db
      .insert(partners)
      .values({ name: `Balans hodim ${S}`, typeId: staffType!.id, createdBy: actorId })
      .returning({ id: partners.id })
  )[0]!.id;
});

afterAll(async () => {
  // Money is voided, never deleted: the file's live costs go back through
  // the door, which also voids each derived debt in the same transaction.
  const live = madeCosts.length
    ? await db
        .select({ id: costEntries.id })
        .from(costEntries)
        .where(and(inArray(costEntries.id, madeCosts), sql`${costEntries.voidedAt} IS NULL`))
    : [];
  for (const { id } of live) {
    await voidCostEntry(id, 'test', ctx(), { mayMoveTill: true }).catch(() => undefined);
  }
  if (madeClients.length) {
    // Every unload here claims a «yukingiz keldi» row for a fixture client;
    // left pending they are the notice drain's input for every later file.
    await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
    await db
      .update(clientTransactions)
      .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' })
      .where(and(inArray(clientTransactions.clientId, madeClients), sql`${clientTransactions.voidedAt} IS NULL`));
  }
  // The file's tills: emptied by the voids above, retired so no picker
  // offers them; a count day of TODAY (no opening date), so they move no old
  // cost in or out for any later file.
  if (madeTills.length) {
    await db.update(moneyAccounts).set({ active: false, openingDate: null }).where(inArray(moneyAccounts.id, madeTills));
  }
  await db.update(partners).set({ active: false }).where(inArray(partners.id, [firmId, staffId].filter(Boolean)));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W).filter(Boolean)));
  await pgClient.end();
});

describe('the rule — paying a cargo cost moves Sof holat by nothing, pricing by the margin', () => {
  it('shape: the line and its notes precede the tills in the AI slice, and the arithmetic adds up (31)', async () => {
    const b = await companyBalance();
    const json = JSON.stringify(b);
    const cut = json.indexOf('"cashRows"');
    for (const key of ['"unpricedCargoUsd"', '"unpricedCargo"', '"netUsd"']) {
      expect([key, json.indexOf(key) >= 0 && json.indexOf(key) < cut && json.indexOf(key) < 6000]).toEqual([key, true]);
    }
    const c = await lineUnder(CARD_PRICE_RULE);
    expect(cents(c.grossUsd - c.cardUsd - c.elsewhereUsd)).toBe(c.lineUsd);
    expect(cents(c.awayUsd + c.stockUsd + c.issuedUsd)).toBe(c.grossUsd);
    expect(c.lineUsd).toBe(b.unpricedCargoUsd);
  });

  let firstCost = '';
  it('1: a receipt cost from a kassa on a client prixod — line +C, cash −C, net 0', async () => {
    const c = await mkClient('A');
    const p = await mkLot(c, 2, W.yw);
    const before = await snap();
    firstCost = await cost({ receiptId: p.receiptId }, 100, { accountId: K });
    const after = await snap();
    expect(delta(before, after, 'line')).toBe(100);
    expect(delta(before, after, 'cash')).toBe(-100);
    expect(delta(before, after, 'net')).toBe(0);
    expect(cents(after.c.awayUsd - before.c.awayUsd)).toBe(100);
  });

  let truck2 = { id: '', client: '' };
  it('2: a truck — freight from a kassa, customs on a firm’s credit — line = the allocations, payable +600, net 0', async () => {
    const c = await mkClient('B');
    const p = await mkLot(c, 2, W.yw);
    const t = await truck([{ lotId: p.lotId, take: 2 }], p.codes, W.yw, W.tas);
    truck2 = { id: t.id, client: c };
    const before = await snap();
    await cost({ batchId: t.id }, 1000, { accountId: K });
    await cost({ batchId: t.id }, 600, { partnerId: firmId }, { type: customsType });
    const after = await snap();
    expect(delta(before, after, 'line')).toBe(1600);
    expect(delta(before, after, 'payable')).toBe(600);
    expect(delta(before, after, 'net')).toBe(0);
  });

  it('3: priced on the truck — line −W, receivable +c, net = c − W', async () => {
    const before = await snap();
    await charge(truck2.client, 2400, { batchId: truck2.id });
    const after = await snap();
    expect(delta(before, after, 'line')).toBe(-1600);
    expect(delta(before, after, 'net')).toBe(800);
  });

  it('4: a charge on the prixod’s deal retires it', async () => {
    const c = await mkClient('C');
    const dealId = await mkDeal(c);
    const p = await mkLot(c, 1, W.yw, dealId);
    await cost({ receiptId: p.receiptId }, 300, { accountId: K });
    const before = await snap();
    await charge(c, 500, { dealId });
    const after = await snap();
    expect(delta(before, after, 'line')).toBe(-300);
    expect(delta(before, after, 'net')).toBe(200);
  });

  it('23: voiding a kassa-paid cost — line −C, cash +C, net 0', async () => {
    const before = await snap();
    await voidCostEntry(firstCost, 'test', ctx(), { mayMoveTill: true });
    const after = await snap();
    expect(delta(before, after, 'line')).toBe(-100);
    expect(delta(before, after, 'cash')).toBe(100);
    expect(delta(before, after, 'net')).toBe(0);
  });
});

describe('his (i): a price that names no cargo takes its client’s cargo off the line, dated', () => {
  it('5 (E2): a $50 card fee on $900 on the road — net −850 (the stated cost of (i)); priced on the truck +350', async () => {
    const c = await mkClient('E2');
    const p = await mkLot(c, 1, W.yw);
    const t = await truck([{ lotId: p.lotId, take: 1 }], p.codes, W.yw, W.tas);
    const start = await snap();
    await cost({ batchId: t.id }, 900, { accountId: K });
    const paid = await snap();
    expect(delta(start, paid, 'net')).toBe(0);
    await charge(c, 50);
    const fee = await snap();
    expect(delta(paid, fee, 'net')).toBe(-850);
    expect(cents(fee.c.cardUsd - paid.c.cardUsd)).toBe(900);
    expect(fee.c.cardClients - paid.c.cardClients).toBe(1);
    await charge(c, 1200, { batchId: t.id });
    const priced = await snap();
    expect(delta(start, priced, 'net')).toBe(350);
  });

  it('6 (E3): an old prixod card-priced after it does not take NEW cargo off — its payment moves the net by 0', async () => {
    const c = await mkClient('E3');
    const old = await mkLot(c, 1, W.yw);
    await db
      .update(receipts)
      .set({ confirmedAt: new Date(`${Y}-03-01T10:00:00+05:00`) })
      .where(eq(receipts.id, old.receiptId));
    await cost({ receiptId: old.receiptId }, 1000, { accountId: K });
    await charge(c, 1400, { txDate: `${Y}-03-15` });
    const fresh = await mkLot(c, 1, W.yw);
    const before = await snap();
    await cost({ receiptId: fresh.receiptId }, 800, { accountId: K });
    const after = await snap();
    expect(delta(before, after, 'line')).toBe(800);
    expect(delta(before, after, 'net')).toBe(0);
  });

  it('7 (S7): a card price below cost reads the loss exactly', async () => {
    const c = await mkClient('S7');
    const p = await mkLot(c, 1, W.yw);
    const start = await snap();
    await cost({ receiptId: p.receiptId }, 1000, { accountId: K });
    await charge(c, 600);
    const after = await snap();
    expect(delta(start, after, 'net')).toBe(-400);
  });

  it('8 (S6): a card bill typed BEFORE its cargo was confirmed stays in the line — the pinned residual (+1000, truth +200)', async () => {
    // Advance billing; #126 puts prices after customs, and neither rule can
    // see which cargo an earlier bill was for. Pinned so a change is seen,
    // not red-proven: a red proof says a gate works, never that it should
    // not exist (#974).
    const c = await mkClient('S6');
    const start = await snap();
    await charge(c, 1000, { txDate: `${Y}-05-01` });
    const p = await mkLot(c, 1, W.yw);
    await cost({ receiptId: p.receiptId }, 800, { accountId: K });
    const after = await snap();
    expect(delta(start, after, 'net')).toBe(1000);
  });

  it('9: a deal price whose deal carries NO prixod names no cargo; linking a prixod to it brings the rest back', async () => {
    const c = await mkClient('D9');
    const dealId = await mkDeal(c);
    const p = await mkLot(c, 1, W.yw);
    const q = await mkLot(c, 1, W.yw);
    await cost({ receiptId: p.receiptId }, 300, { accountId: K });
    await cost({ receiptId: q.receiptId }, 200, { accountId: K });
    const before = await snap();
    await charge(c, 1000, { dealId });
    const priced = await snap();
    // Both prixods out (his (i), card-like b): +1000 of receivable, −500 of line.
    expect(delta(before, priced, 'line')).toBe(-500);
    expect(delta(before, priced, 'net')).toBe(500);
    await linkReceipt(p.receiptId, dealId, ctx());
    const linked = await snap();
    // Now the price names P (clause 1) — Q is somebody's cargo with no price
    // again: information, +200.
    expect(delta(priced, linked, 'line')).toBe(200);
    expect(delta(priced, linked, 'net')).toBe(200);
  });

  it('10: a truck price on a truck the client never touched names no cargo (card-like c)', async () => {
    // `client_not_aboard` refuses this at the door since 0104, so only an
    // older row can have this shape — written as a fixture.
    const c = await mkClient('T10');
    const p = await mkLot(c, 1, W.yw);
    await cost({ receiptId: p.receiptId }, 200, { accountId: K });
    const stranger = await mkLot(await mkClient('T10X'), 1, W.yw);
    const t = await truck([{ lotId: stranger.lotId, take: 1 }], stranger.codes, W.yw, W.tas);
    const before = await snap();
    await db.insert(clientTransactions).values({
      clientId: c,
      type: 'charge',
      amount: '500',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '500',
      txDate: tashkentDay(),
      batchId: t.id,
      createdBy: actorId,
    });
    const after = await snap();
    expect(delta(before, after, 'line')).toBe(-200);
    expect(delta(before, after, 'net')).toBe(300);
  });

  it('29: «🚚 Ko‘chirish» of a card price onto its truck covers the prixod and lifts the exclusion from the rest', async () => {
    const c = await mkClient('M29');
    const p1 = await mkLot(c, 1, W.yw);
    const t = await truck([{ lotId: p1.lotId, take: 1 }], p1.codes, W.yw, W.tas);
    await cost({ batchId: t.id }, 500, { accountId: K });
    const p2 = await mkLot(c, 1, W.yw);
    await cost({ receiptId: p2.receiptId }, 200, { accountId: K });
    const start = await snap();
    const card = await charge(c, 800);
    const carded = await snap();
    expect(delta(start, carded, 'net')).toBe(100);
    await moveCharge({ txId: card.id, parts: [{ batchId: t.id, amount: 800 }] }, ctx());
    const moved = await snap();
    expect(delta(carded, moved, 'line')).toBe(200);
    // = the price − the cost of the cargo it now names.
    expect(delta(start, moved, 'net')).toBe(300);
  });
});

describe('a price that named cargo never frees itself', () => {
  it('11 (S4): the priced prixod’s only carton LOST — another prixod’s cost stays, net 0', async () => {
    const c = await mkClient('S4');
    const p1 = await mkLot(c, 1, W.yw);
    const t1 = await truck([{ lotId: p1.lotId, take: 1 }], p1.codes, W.yw, W.tas);
    await unload(t1.id, p1.codes);
    await charge(c, 1000, { batchId: t1.id });
    const p2 = await mkLot(c, 1, W.yw);
    const t2 = await truck([{ lotId: p2.lotId, take: 1 }], p2.codes, W.yw, W.tas);
    await cost({ batchId: t2.id }, 300, { accountId: K });
    const before = await snap();
    await markBoxLost({ boxId: p1.boxIds[0]!, reason: 'yo‘qoldi', atWarehouseId: W.tas }, ctx());
    const after = await snap();
    expect(delta(before, after, 'net')).toBe(0);
  });

  it('12: a deal whose only prixod is lost still names cargo — net 0', async () => {
    const c = await mkClient('L12');
    const dealId = await mkDeal(c);
    const p1 = await mkLot(c, 1, W.yw, dealId);
    await charge(c, 700, { dealId });
    const p2 = await mkLot(c, 1, W.yw);
    await cost({ receiptId: p2.receiptId }, 300, { accountId: K });
    const before = await snap();
    await markBoxLost({ boxId: p1.boxIds[0]!, reason: 'yo‘qoldi', atWarehouseId: W.yw }, ctx());
    const after = await snap();
    expect(delta(before, after, 'net')).toBe(0);
  });

  it('28: an UNCOVERED carton marked lost leaves the line — the write-off lowers the net that day', async () => {
    const c = await mkClient('L28');
    const p = await mkLot(c, 1, W.yw);
    await cost({ receiptId: p.receiptId }, 150, { accountId: K });
    const before = await snap();
    await markBoxLost({ boxId: p.boxIds[0]!, reason: 'yo‘qoldi', atWarehouseId: W.yw }, ctx());
    const after = await snap();
    expect(delta(before, after, 'line')).toBe(-150);
    expect(delta(before, after, 'net')).toBe(-150);
  });
});

describe('a price on another truck the cargo touched (Q21, Q2)', () => {
  it('13 (S3): two prixods short-loaded off T ($400) ride T2 — the $400 is used ONCE', async () => {
    const c = await mkClient('S3');
    const p1 = await mkLot(c, 1, W.yw);
    const p2 = await mkLot(c, 1, W.yw);
    const q = await mkLot(c, 1, W.yw);
    const t = await loadTruck(
      [
        { lotId: p1.lotId, take: 1 },
        { lotId: p2.lotId, take: 1 },
        { lotId: q.lotId, take: 1 },
      ],
      q.codes,
      W.yw,
      W.tas,
    );
    await charge(c, 400, { batchId: t.id });
    await depart(t.id);
    const t2 = await truck(
      [
        { lotId: p1.lotId, take: 1 },
        { lotId: p2.lotId, take: 1 },
      ],
      [...p1.codes, ...p2.codes],
      W.yw,
      W.tas,
    );
    const start = await snap();
    await cost({ batchId: t2.id }, 600, { accountId: K });
    const freight = await snap();
    expect(delta(start, freight, 'net')).toBe(-400);
    await cost({ batchId: t2.id }, 300, { accountId: K }, { type: customsType });
    const customs = await snap();
    expect(delta(freight, customs, 'net')).toBe(0);
  });

  it('14 (S1): a deal prixod short-loaded off a truck priced with no deal is uncovered and tagged', async () => {
    const c = await mkClient('S1');
    const dealId = await mkDeal(c);
    const p = await mkLot(c, 2, W.yw, dealId);
    const q = await mkLot(c, 1, W.yw);
    const filler = await mkLot(await mkClient('S1X'), 1, W.yw);
    const t = await loadTruck(
      [
        { lotId: p.lotId, take: 2 },
        { lotId: q.lotId, take: 1 },
        { lotId: filler.lotId, take: 1 },
      ],
      [...q.codes, ...filler.codes],
      W.yw,
      W.tas,
    );
    await charge(c, 900, { batchId: t.id });
    await depart(t.id);
    const t2 = await truck([{ lotId: p.lotId, take: 2 }], p.codes, W.yw, W.tas);
    const start = await snap();
    await cost({ batchId: t2.id }, 400, { accountId: K });
    const freight = await snap();
    // On the line (gross) and retired by T's price (stated, §3.1 row 25).
    expect(cents(freight.c.grossUsd - start.c.grossUsd)).toBe(400);
    expect(cents(freight.c.elsewhereUsd - start.c.elsewhereUsd)).toBe(400);
    expect(delta(start, freight, 'net')).toBe(-400);
    await charge(c, 500, { batchId: t2.id });
    const priced = await snap();
    expect(delta(start, priced, 'net')).toBe(100);
  });

  it('15 (S2): found back AFTER A was priced — B’s freight is retired by A’s price (stated), B priced +500', async () => {
    const c = await mkClient('S2');
    const p = await mkLot(c, 2, W.yw);
    const a = await loadTruck([{ lotId: p.lotId, take: 2 }], p.codes, W.yw, W.tas);
    await depart(a.id);
    await cost({ batchId: a.id }, 400, { accountId: K });
    await charge(c, 1000, { batchId: a.id });
    await acceptFoundBox({ warehouseId: W.yw, code: p.codes[1]! }, ctx());
    await unload(a.id, [p.codes[0]!]);
    const b = await truck([{ lotId: p.lotId, take: 1 }], [p.codes[1]!], W.yw, W.tas);
    const start = await snap();
    await cost({ batchId: b.id }, 300, { accountId: K });
    const freight = await snap();
    expect(delta(start, freight, 'net')).toBe(-300);
    await charge(c, 500, { batchId: b.id });
    const priced = await snap();
    expect(delta(freight, priced, 'net')).toBe(500);
  });
});

describe('the money states (§3.1)', () => {
  it('16: a queued cost (no kassa named, not in any count) — typed, placed, typed, a colleague — net 0 every step', async () => {
    const c = await mkClient('Q16');
    const p = await mkLot(c, 1, W.yw);
    const s0 = await snap();
    const first = await cost({ receiptId: p.receiptId }, 120);
    const s1 = await snap();
    expect(delta(s0, s1, 'line')).toBe(120);
    expect(delta(s0, s1, 'net')).toBe(0);
    await placeCostAccount(first, K, undefined, ctx());
    const s2 = await snap();
    expect(delta(s1, s2, 'cash')).toBe(-120);
    expect(delta(s1, s2, 'net')).toBe(0);
    const second = await cost({ receiptId: p.receiptId }, 80);
    const s3 = await snap();
    expect(delta(s2, s3, 'net')).toBe(0);
    await setCostStaffPayer(second, staffId, ctx());
    const s4 = await snap();
    expect(delta(s3, s4, 'payable')).toBe(80);
    expect(delta(s3, s4, 'net')).toBe(0);
  });

  describe('a queued cost every kassa count holds (17)', () => {
    let parked: string[] = [];
    let counted = '';
    beforeAll(async () => {
      parked = await parkActiveKassas();
      counted = await till('sanoq 17', { openingDate: `${Y}-02-01` });
    });
    afterAll(async () => {
      // Its early count is configuration for every later old cost (a retired
      // kassa stays in the old-cost set): back to a count day of today.
      await db.update(moneyAccounts).set({ active: false, openingDate: null }).where(eq(moneyAccounts.id, counted));
      await unpark(parked);
    });

    it('typing it is information (+C), placing it moves 0, «a colleague paid it» −C (wd2)', async () => {
      const c = await mkClient('Q17');
      const p = await mkLot(c, 1, W.yw);
      const s0 = await snap();
      const first = await cost({ receiptId: p.receiptId }, 70, {}, { day: `${Y}-01-20` });
      const s1 = await snap();
      expect(s1.b.unplacedCostInCountCount - s0.b.unplacedCostInCountCount).toBe(1);
      expect(delta(s0, s1, 'net')).toBe(70);
      await placeCostAccount(first, counted, undefined, ctx());
      const s2 = await snap();
      expect(delta(s1, s2, 'net')).toBe(0);
      const second = await cost({ receiptId: p.receiptId }, 30, {}, { day: `${Y}-01-21` });
      const s3 = await snap();
      expect(delta(s2, s3, 'net')).toBe(30);
      await setCostStaffPayer(second, staffId, ctx());
      const s4 = await snap();
      expect(delta(s3, s4, 'net')).toBe(-30);
    });
  });

  it('18: an OLD cost is in while every kassa was counted after it, out (and named) once one was not', async () => {
    const c = await mkClient('O18');
    const p = await mkLot(c, 1, W.yw);
    const id = await cost({ receiptId: p.receiptId }, 90, {}, { day: `${Y}-08-02` });
    const typed = await snap();
    await backdate(id);
    const old = await snap();
    // Off the queue (the Balans stops subtracting it) and still in the line:
    // every kassa was counted after 1663 — history inside the counts.
    expect(cents(old.line - typed.line)).toBe(0);
    await withEarlyCount(`${Y}-08-01`, async () => {
      const out = await snap();
      expect(delta(old, out, 'line')).toBe(-90);
      expect(out.c.oldNoKassa.count - old.c.oldNoKassa.count).toBe(1);
      expect(cents(out.c.oldNoKassa.usd - old.c.oldNoKassa.usd)).toBe(90);
    });
  });

  describe('opening or retiring a kassa moves no old cost (19, 20)', () => {
    let parked: string[] = [];
    let counted = '';
    let fresh = '';
    const oldCost = 400;
    const queued = 60;
    beforeAll(async () => {
      parked = await parkActiveKassas();
      counted = await till('sanoq 19', { openingDate: `${Y}-07-10` });
      const c = await mkClient('O19');
      const p = await mkLot(c, 1, W.yw);
      const id = await cost({ receiptId: p.receiptId }, oldCost, {}, { day: `${Y}-07-05` });
      await backdate(id);
      await cost({ receiptId: p.receiptId }, queued, {}, { day: `${Y}-07-06` });
    });
    afterAll(async () => {
      if (fresh) await db.update(moneyAccounts).set({ active: false }).where(eq(moneyAccounts.id, fresh));
      // As in 17: an early count left behind is configuration.
      await db.update(moneyAccounts).set({ active: false, openingDate: null }).where(eq(moneyAccounts.id, counted));
      await unpark(parked);
    });

    it('19 (S5): a new empty kassa, retiring it, retiring the counted one — the line moves 0 each time', async () => {
      const s0 = await snap();
      fresh = await till('yangi 19');
      const s1 = await snap();
      expect(delta(s0, s1, 'line')).toBe(0);
      // wd2's queue half, asserted on its own: a kassa with no count could
      // still take the queued cost, so it is money gone again.
      expect(delta(s0, s1, 'net')).toBe(-queued);
      await db.update(moneyAccounts).set({ active: false }).where(eq(moneyAccounts.id, fresh));
      const s2 = await snap();
      expect(delta(s1, s2, 'line')).toBe(0);
      expect(delta(s1, s2, 'net')).toBe(queued);
      await db.update(moneyAccounts).set({ active: false }).where(eq(moneyAccounts.id, counted));
      const s3 = await snap();
      expect(delta(s2, s3, 'line')).toBe(0);
      expect(delta(s2, s3, 'net')).toBe(-queued);
      await db.update(moneyAccounts).set({ active: true }).where(eq(moneyAccounts.id, counted));
    });

    it('20: the counted kassa’s opening re-typed BEFORE the old cost — the old cost leaves: information', async () => {
      const s0 = await snap();
      await db.update(moneyAccounts).set({ openingDate: `${Y}-07-01` }).where(eq(moneyAccounts.id, counted));
      const s1 = await snap();
      expect(delta(s0, s1, 'line')).toBe(-oldCost);
      expect(s1.c.oldNoKassa.count - s0.c.oldNoKassa.count).toBe(1);
    });
  });

  it('21: a kassa in a currency with no rate pays a USD cost — not in the line, named', async () => {
    const code = 'QB3';
    await db.insert(currencies).values({ code, name: `Balans ${code}`, active: false }).onConflictDoNothing();
    const unrated = await till('kursiz', { currency: code });
    const c = await mkClient('U21');
    const p = await mkLot(c, 1, W.yw);
    const before = await snap();
    await addCostEntry(
      {
        scope: 'receipt',
        receiptId: p.receiptId,
        costTypeId: freightType,
        amount: 75,
        currency: 'USD',
        costDate: `${Y}-06-11`,
        allocationBasis: 'weight',
        accountId: unrated,
        accountAmount: 900,
      } as never,
      ctx(),
    ).then((entry) => madeCosts.push(entry.id));
    const after = await snap();
    expect(delta(before, after, 'line')).toBe(0);
    expect(delta(before, after, 'net')).toBe(0);
    expect(after.c.tillUnrated.count - before.c.tillUnrated.count).toBe(1);
  });

  it('22: a firm cost whose debt was never written is named, and the nightly repair writes it', async () => {
    const c = await mkClient('N22');
    const p = await mkLot(c, 1, W.yw);
    const id = await cost({ receiptId: p.receiptId }, 250, { partnerId: firmId });
    // The shape a failed post-commit `chargeForCost` leaves: the payer named,
    // no live debt (a door-voided charge unlinks the payer, #528).
    await db.update(partnerTransactions).set({ voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' }).where(
      eq(partnerTransactions.costEntryId, id),
    );
    const broken = await snap();
    expect(broken.c.noDebt.count).toBeGreaterThanOrEqual(1);
    await recomputeAll({ orphaned: true });
    const [debt] = await db
      .select({ id: partnerTransactions.id })
      .from(partnerTransactions)
      .where(and(eq(partnerTransactions.costEntryId, id), sql`${partnerTransactions.voidedAt} IS NULL`));
    expect(debt).toBeDefined();
    const repaired = await snap();
    expect(repaired.c.noDebt.count).toBeLessThanOrEqual(broken.c.noDebt.count - 1);
  });

  it('24 (S13): unclaimed cargo — the note holds only money that would join, and naming the client adds exactly it', async () => {
    const p = await mkLot(null, 2, W.yw);
    const t = await truck([{ lotId: p.lotId, take: 2 }], p.codes, W.yw, W.tas);
    await withEarlyCount(`${Y}-09-01`, async () => {
      const before = await snap();
      await cost({ batchId: t.id }, 300, { accountId: K });
      const oldId = await cost({ batchId: t.id }, 40, {}, { day: `${Y}-09-02` });
      await backdate(oldId);
      const typed = await snap();
      expect(cents(typed.c.unclaimed.usd - before.c.unclaimed.usd)).toBe(300);
      const c = await mkClient('S13');
      await assignReceiptClient(p.receiptId, c, ctx());
      const named = await snap();
      expect(delta(typed, named, 'line')).toBe(300);
      expect(delta(typed, named, 'net')).toBe(300);
    });
  });

  it('25: an internal leg and the export truck on one carton — each allocation once; the export price +(price − both)', async () => {
    const c = await mkClient('I25');
    const p = await mkLot(c, 1, W.yw);
    const leg = await truck([{ lotId: p.lotId, take: 1 }], p.codes, W.yw, W.ka);
    await unload(leg.id, p.codes);
    const exportTruck = await truck([{ lotId: p.lotId, take: 1 }], p.codes, W.ka, W.tas);
    const start = await snap();
    await cost({ batchId: leg.id }, 120, { accountId: K });
    await cost({ batchId: exportTruck.id }, 500, { accountId: K });
    const costed = await snap();
    expect(delta(start, costed, 'line')).toBe(620);
    await charge(c, 800, { batchId: exportTruck.id });
    const priced = await snap();
    expect(delta(start, priced, 'net')).toBe(180);
  });
});

describe('handed over: in after the ban, out before it (§3.1 rows 19-20)', () => {
  it('26: handed over unpriced after the ban stays in; the same carton handed over BEFORE it is out and named by the report', async () => {
    expect(gate.state).toBe('on');
    const c = await mkClient('H26');
    const p = await mkLot(c, 1, W.yw);
    const t = await truck([{ lotId: p.lotId, take: 1 }], p.codes, W.yw, W.tas);
    await unload(t.id, p.codes);
    await cost({ batchId: t.id }, 250, { accountId: K });
    const before = await snap();
    expect(await issue(c, W.tas, p.boxIds)).toBe('ok');
    const issued = await snap();
    expect(delta(before, issued, 'line')).toBe(0);
    expect(cents(issued.c.issuedUsd - before.c.issuedUsd)).toBe(250);
    const allBefore = await lineUnder(CARD_PRICE_RULE, 'all');
    // Its issue movement moved before the ban's instant (the ban itself is
    // configuration and is never written here).
    await db.execute(sql`
      UPDATE box_movements SET created_at = '2020-01-01T00:00:00Z'
       WHERE box_id = ${p.boxIds[0]!} AND to_status = 'issued'
    `);
    const moved = await snap();
    expect(delta(issued, moved, 'line')).toBe(-250);
    const all = await lineUnder(CARD_PRICE_RULE, 'all');
    expect(cents(all.issuedBeforeGate!.usd - allBefore.issuedBeforeGate!.usd)).toBe(250);
    // Both modes give the same line.
    expect(all.lineUsd).toBe(moved.line);
  });

  it('27: a carton handed over at the ORIGIN counts in «topshirilgan» only, never in «yo‘lda»', async () => {
    const c = await mkClient('H27');
    const p = await mkLot(c, 1, W.yw);
    await cost({ receiptId: p.receiptId }, 100, { accountId: K });
    const before = await snap();
    expect(await issue(c, W.yw, p.boxIds)).toBe('ok');
    const after = await snap();
    expect(cents(after.c.issuedUsd - before.c.issuedUsd)).toBe(100);
    expect(cents(after.c.awayUsd - before.c.awayUsd)).toBe(-100);
    expect(cents(after.c.awayUsd + after.c.stockUsd + after.c.issuedUsd)).toBe(after.c.grossUsd);
  });
});

describe('the switch and the arithmetic', () => {
  it('30: netting (the switch) — E2’s fee moves 0 (under by 50), S7 moves 0 (over by 400), E3 dated', async () => {
    const e2 = await mkClient('N30A');
    const pe = await mkLot(e2, 1, W.yw);
    await cost({ receiptId: pe.receiptId }, 900, { accountId: K });
    const n0 = await netUnder('net');
    await charge(e2, 50);
    expect(cents((await netUnder('net')) - n0)).toBe(0);

    const s7 = await mkClient('N30B');
    const ps = await mkLot(s7, 1, W.yw);
    const n1 = await netUnder('net');
    await cost({ receiptId: ps.receiptId }, 1000, { accountId: K });
    await charge(s7, 600);
    expect(cents((await netUnder('net')) - n1)).toBe(0);

    // E3 under netting: the old job's card price retires the OLD cargo only.
    const e3 = await mkClient('N30C');
    const old = await mkLot(e3, 1, W.yw);
    await db
      .update(receipts)
      .set({ confirmedAt: new Date(`${Y}-03-01T10:00:00+05:00`) })
      .where(eq(receipts.id, old.receiptId));
    await cost({ receiptId: old.receiptId }, 1000, { accountId: K });
    const l0 = (await lineUnder('net')).lineUsd;
    await charge(e3, 1400, { txDate: `${Y}-03-15` });
    const l1 = (await lineUnder('net')).lineUsd;
    expect(cents(l1 - l0)).toBe(-1000);
    const fresh = await mkLot(e3, 1, W.yw);
    await cost({ receiptId: fresh.receiptId }, 800, { accountId: K });
    const l2 = (await lineUnder('net')).lineUsd;
    expect(cents(l2 - l1)).toBe(800);
  });

  it('32: a sub-cent share is rounded inside the reader, and the Balans lines add up to the net to the cent', async () => {
    const [x, y, z] = [await mkClient('R32A'), await mkClient('R32B'), await mkClient('R32C')];
    const lots = [await mkLot(x, 1, W.yw), await mkLot(y, 1, W.yw), await mkLot(z, 1, W.yw)];
    const t = await truck(
      lots.map((l) => ({ lotId: l.lotId, take: 1 })),
      lots.flatMap((l) => l.codes),
      W.yw,
      W.tas,
    );
    // 100 over three equal cartons: 33.3334 / 33.3333 / 33.3333.
    await cost({ batchId: t.id }, 100, { accountId: K });
    await charge(x, 50, { batchId: t.id });
    await charge(y, 50, { batchId: t.id });
    const b = await companyBalance();
    expect(Math.round(b.unpricedCargoUsd * 100) / 100).toBe(b.unpricedCargoUsd);
    const lines = balanceLines(b, { cash: '/accounting/accounts', cargo: '#balance-unpriced' });
    expect(cents(lines.reduce((sum, line) => sum + line.value, 0) - b.netUsd)).toBe(0);
  });

  it('33: u_unc is exactly «u_cov WHERE NOT covered», over this file’s clients', async () => {
    const [row] = (await db.execute(sql`
      WITH ${uncoveredCtes(unpricedScopeSql({ kind: 'clients', clientIds: madeClients }), { landedOnly: false })},
      ${uncoveredMoneyCtes()}
      SELECT coalesce((SELECT array_agg(box_id::text ORDER BY box_id) FROM u_unc), '{}') AS unc,
             coalesce((SELECT array_agg(box_id::text ORDER BY box_id) FROM u_cov WHERE NOT covered), '{}') AS cov
    `)) as unknown as { unc: string[]; cov: string[] }[];
    // Not vacuous: the file's cases leave uncovered cargo behind.
    expect(row!.cov.length).toBeGreaterThan(5);
    expect(row!.unc).toEqual(row!.cov);
  });
});
