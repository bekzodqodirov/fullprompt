import 'dotenv/config';
import ExcelJS from 'exceljs';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  clientTransactions,
  clients,
  dealStages,
  deals,
  notifications,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { saveAccount } from '@/modules/wms/accounting/service';
import { arAging, cashFlow, profitAndLoss, profitByBatch, profitByClient, unbatchedMoney } from '@/modules/wms/accounting/reports';
import { buildProfitXlsx } from '@/modules/wms/accounting/xlsx';
import { setBoxStatus } from '@/modules/wms/boxes/status';
import { debtSummary } from '@/modules/wms/client-cabinet/service';
import { clientFeed } from '@/modules/wms/crm/feed';
import { dealProfit, linkReceipt } from '@/modules/wms/deals/service';
import { clientCargo, managedClients } from '@/modules/wms/finance/client-cargo';
import { addCompensation, compensatedReceiptsAmong, lostCargoChargesOn } from '@/modules/wms/finance/compensation';
import { uncoveredBoxesOn } from '@/modules/wms/finance/unpriced';
import { signedUsd } from '@/modules/wms/finance/ledger-kinds';
import {
  addTransaction,
  balancesForClients,
  clientBalanceUsd,
  clientBalances,
  clientLedger,
  voidTransaction,
} from '@/modules/wms/finance/service';
import { annulReceipt } from '@/modules/wms/receipts/annul';
import { assignReceiptClient } from '@/modules/wms/receipts/edit';
import { voidReceipt } from '@/modules/wms/receipts/service';

/**
 * Part K (0105, the owner's Q15 (2) A): money we pay a client for LOST cargo
 * above our own price is its own ledger kind — it lowers what he owes like a
 * payment, it is revenue taken back and never money or an expense, the part
 * within our price is paid by lowering the price in the same press, and the
 * prixod carries it (the deal follows, a client change and a void refuse).
 *
 * Money lives in 1627 (no other file's year), one MONTH per case so every
 * period report reads only that case's rows. Every case mints its own
 * client, prixod and truck through `world()` — no case's money is another's
 * input. Losses go through the real `setBoxStatus`; trucks carry real
 * `batch_departed` movements, so the rider rule finds them. Cleanup: the
 * ledger rows first (the new FK), then the cargo; the warehouses an audited
 * status change touched are DEACTIVATED, never deleted (audit_log FK); the
 * till is retired (#183).
 */
const YEAR = '1627';
const S = String(Date.now()).slice(-5);
let seq = 0;
let actorId: string;
let sellerId: string;
let otherClientId: string;
let stageId: string;
let cn: string;
let uz: string;
let tillId: string;
const tillName = `Komp kassa ${S}`;
const ctx = () => ({ actorId });
const payDoor = { mayPayClient: true };
const madeClients: string[] = [];
const madeDeals: string[] = [];
const madeBatches: string[] = [];
const madeReceipts: string[] = [];
const madeLots: string[] = [];
const madeBoxes: string[] = [];

async function mintWarehouse(code: string, country: string, type: string) {
  return (
    await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name: `Komp ${code}`, country, type, timezone: 'Asia/Tashkent' })
      .returning({ id: warehouses.id })
  )[0]!.id;
}

async function mintClient() {
  seq += 1;
  const code = `KP${S}${seq}`;
  const id = (
    await db
      .insert(clients)
      .values({ clientCode: code, name: `Komp mijoz ${S}-${seq}`, salesManagerId: sellerId })
      .returning({ id: clients.id })
  )[0]!.id;
  madeClients.push(id);
  return { id, code };
}

async function mintDeal(clientId: string) {
  seq += 1;
  const id = (
    await db
      .insert(deals)
      .values({ code: `KP${S}-D${seq}`, clientId, stageId, title: `Komp bitim ${seq}`, createdBy: actorId })
      .returning({ id: deals.id })
  )[0]!.id;
  madeDeals.push(id);
  return id;
}

async function mintTruck(day: string) {
  seq += 1;
  const id = uuidv4();
  await db.insert(batches).values({
    id,
    code: `KP${S}-B${seq}`,
    originWarehouseId: cn,
    destWarehouseId: uz,
    status: 'in_transit',
    departedAt: new Date(`${day}T06:00:00Z`),
    createdBy: actorId,
  });
  madeBatches.push(id);
  return id;
}

/** A prixod of `count` cartons, landed at the Uzbek warehouse off `truckId`. */
async function cargoOn(clientId: string, dealId: string | null, truckId: string | null, count = 2) {
  seq += 1;
  const number = `KP${S}-R${seq}`;
  const receiptId = (
    await db
      .insert(receipts)
      .values({ number, warehouseId: cn, clientId, dealId, status: 'confirmed', createdBy: actorId })
      .returning({ id: receipts.id })
  )[0]!.id;
  madeReceipts.push(receiptId);
  const lotId = (
    await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: 1,
        letter: 'A',
        productNameZh: `货${S}-${seq}`,
        productNameRu: `Товар ${S}-${seq}`,
        boxCount: count,
        dimsMode: 'mixed',
        totalWeightKg: String(10 * count),
        totalVolumeM3: String(0.1 * count),
      })
      .returning({ id: receiptLots.id })
  )[0]!.id;
  madeLots.push(lotId);
  const boxIds: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    const boxId = (
      await db
        .insert(boxes)
        .values({ lotId, shortCode: `KP${S}X${seq}N${n}`, seqInLot: n, currentWarehouseId: uz, status: 'in_stock' })
        .returning({ id: boxes.id })
    )[0]!.id;
    madeBoxes.push(boxId);
    boxIds.push(boxId);
    if (truckId) {
      await db.insert(boxMovements).values({
        boxId,
        fromWarehouseId: cn,
        toWarehouseId: uz,
        fromStatus: 'loading',
        toStatus: 'in_transit',
        cause: 'batch_departed',
        refType: 'batch',
        refId: truckId,
        actorId,
      });
    }
  }
  return { receiptId, number, lotId, boxIds };
}

const loseBox = (boxId: string) => setBoxStatus({ boxId, to: 'lost', reason: 'yo‘qolgan — test' }, ctx());

/** A client, a deal, a truck and one prixod on it with `lost` of its cartons lost. */
async function world(month: string, o: { lost?: number; boxes?: number; deal?: boolean } = {}) {
  const client = await mintClient();
  const dealId = o.deal === false ? null : await mintDeal(client.id);
  const truckId = await mintTruck(`${YEAR}-${month}-02`);
  const cargo = await cargoOn(client.id, dealId, truckId, o.boxes ?? 2);
  for (const boxId of cargo.boxIds.slice(0, o.lost ?? 1)) await loseBox(boxId);
  return { clientId: client.id, code: client.code, dealId, truckId, ...cargo };
}

const day = (month: string, dd = '10') => `${YEAR}-${month}-${dd}`;

const charge = (clientId: string, amount: number, txDate: string, extra: { batchId?: string; dealId?: string } = {}) =>
  addTransaction({ clientId, type: 'charge', amount, currency: 'USD', txDate, ...extra }, ctx());

const pay = (clientId: string, amount: number, txDate: string) =>
  addTransaction(
    { clientId, type: 'payment', amount, currency: 'USD', txDate, accountId: tillId, method: 'cash' },
    ctx(),
  );

const refund = (clientId: string, amount: number, txDate: string) =>
  addTransaction(
    { clientId, type: 'refund', amount, currency: 'USD', txDate, accountId: tillId, method: 'cash' },
    ctx(),
  );

const compensate = (
  w: { clientId: string; receiptId: string },
  amount: number | undefined,
  txDate: string,
  reprices: { chargeId: string; newAmount: number }[] = [],
) =>
  addCompensation(
    { clientId: w.clientId, receiptId: w.receiptId, amount, currency: 'USD', txDate, note: 'yo‘qolgan yuk', reprices },
    ctx(),
    payDoor,
  );

async function viewBalance(clientId: string) {
  const rows = (await db.execute(
    sql`SELECT balance_usd FROM v_client_balance_usd WHERE client_id = ${clientId}::uuid`,
  )) as unknown as { balance_usd: string }[];
  return Number([...rows][0]?.balance_usd ?? 0);
}

beforeAll(async () => {
  const people = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(2);
  actorId = people[0]!.id;
  sellerId = people[1]!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  cn = await mintWarehouse(`KC${S}`, 'CN', 'origin');
  uz = await mintWarehouse(`KU${S}`, 'UZ', 'distribution');
  tillId = (
    await saveAccount(
      { name: tillName, currency: 'USD', kind: 'cash', openingBalance: 0, openingDate: '', sortOrder: 900, active: true },
      ctx(),
    )
  ).id;
  otherClientId = (await mintClient()).id;
});

afterAll(async () => {
  try {
    const codes = await db.select({ code: clients.clientCode }).from(clients).where(inArray(clients.id, madeClients));
    for (const { code } of codes) {
      await db
        .delete(notifications)
        .where(and(eq(notifications.type, 'CompensatedCargoFound'), like(sql`${notifications.payload}->>'text'`, `%${code}%`)));
    }
    await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
    if (madeBoxes.length) await db.delete(boxMovements).where(inArray(boxMovements.boxId, madeBoxes));
    if (madeBoxes.length) await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
    if (madeLots.length) await db.delete(receiptLots).where(inArray(receiptLots.id, madeLots));
    if (madeReceipts.length) await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
    if (madeDeals.length) await db.delete(deals).where(inArray(deals.id, madeDeals));
    if (madeBatches.length) await db.delete(batches).where(inArray(batches.id, madeBatches));
    await db.delete(clients).where(inArray(clients.id, madeClients));
    // Audited (the status changes name them): retired, never deleted.
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [cn, uz]));
    await saveAccount(
      { id: tillId, name: tillName, currency: 'USD', kind: 'cash', openingBalance: 0, openingDate: '', sortOrder: 900, active: false },
      ctx(),
    ).catch(() => undefined);
  } finally {
    await pgClient.end();
  }
});

describe('C1 — every balance reader agrees, and a compensation lowers it', () => {
  it('−1500 on every surface; the totals row names the three parts', async () => {
    const w = await world('01');
    await charge(w.clientId, 1000, day('01'), { batchId: w.truckId });
    await pay(w.clientId, 1000, day('01'));
    await compensate(w, 1500, day('01', '12'));

    expect(await clientBalanceUsd(w.clientId)).toBe(-1500);
    expect((await balancesForClients([w.clientId])).get(w.clientId)?.balanceUsd).toBe(-1500);
    expect(await viewBalance(w.clientId)).toBe(-1500);
    const ledger = (await clientLedger(w.clientId)).filter(({ tx }) => !tx.voidedAt);
    expect(ledger.reduce((sum, { tx }) => sum + signedUsd({ type: tx.type, amountUsd: Number(tx.amountUsd) }), 0)).toBe(
      -1500,
    );
    const row = (await clientBalances()).find((r) => r.clientId === w.clientId)!;
    expect(row).toMatchObject({ chargesUsd: 1000, compensatedUsd: 1500, paymentsUsd: 1000, balanceUsd: -1500 });
    const managed = (await managedClients(sellerId)).find((r) => r.clientId === w.clientId)!;
    expect(managed.balanceUsd).toBe(-1500);
  });
});

describe('C2 — not money, not an expense: revenue falls, cash does not', () => {
  it('the P&L, the client, the deal and the unbatched note move; the cash does not', async () => {
    const from = day('02', '01');
    const to = day('02', '28');
    const w = await world('02');
    await charge(w.clientId, 1000, day('02'), { batchId: w.truckId });
    const pnl0 = await profitAndLoss(from, to);
    const cash0 = await cashFlow(from, to);
    const unbatched0 = await unbatchedMoney(from, to);

    await compensate(w, 1500, day('02', '12'));

    const pnl1 = await profitAndLoss(from, to);
    expect(pnl1.grossCharges.total).toBeCloseTo(pnl0.grossCharges.total, 2);
    expect(pnl1.compensation.total - pnl0.compensation.total).toBeCloseTo(1500, 2);
    expect(pnl1.revenue.total - pnl0.revenue.total).toBeCloseTo(-1500, 2);
    expect(pnl1.grossMarginPct[`${YEAR}-02`]).toBeNull();
    expect(await cashFlow(from, to)).toEqual(cash0);
    expect((await unbatchedMoney(from, to)).compensationUsd - unbatched0.compensationUsd).toBeCloseTo(1500, 2);
    // …and the FILE says it as the screen does, or its truck table no longer
    // sums to the P&L and nothing on it says why (review).
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildProfitXlsx('batch', from, to, 'uz')) as unknown as ArrayBuffer);
    const text: string[] = [];
    workbook.worksheets[0]!.eachRow((row) => text.push(String(row.getCell(1).value ?? '')));
    expect(text.some((line) => line.startsWith('Mijozlarga kompensatsiya'))).toBe(true);

    const client = (await profitByClient(from, to)).find((r) => r.clientId === w.clientId)!;
    expect(client.revenueUsd).toBe(-500);
    expect(client.marginPct).toBeNull();
    const deal = await dealProfit(w.dealId!);
    expect(deal).toMatchObject({ revenueUsd: -500, compensationUsd: 1500, marginPct: null });
  });
});

describe('C3 — the refund pays it (the cap counts the compensation)', () => {
  it('a settled client gets no refund; a compensation makes room for exactly itself', async () => {
    const w = await world('03');
    await charge(w.clientId, 500, day('03'), { batchId: w.truckId });
    await pay(w.clientId, 500, day('03'));
    await expect(refund(w.clientId, 200, day('03', '11'))).rejects.toMatchObject({ code: 'refund_exceeds_advance' });
    await compensate(w, 500, day('03', '12'));
    await expect(refund(w.clientId, 500, day('03', '13'))).resolves.toBeTruthy();
    expect(await clientBalanceUsd(w.clientId)).toBe(0);

    const fresh = await world('03');
    await charge(fresh.clientId, 500, day('03'), { batchId: fresh.truckId });
    await pay(fresh.clientId, 500, day('03'));
    await compensate(fresh, 500, day('03', '12'));
    await expect(refund(fresh.clientId, 506, day('03', '13'))).rejects.toMatchObject({ code: 'refund_exceeds_advance' });
  });
});

describe('C4 — ageing and the client card: it settles oldest-first, and «To‘langan» stays money', () => {
  it('the older truck is settled, the newer one owes; nothing was «paid»', async () => {
    const w = await world('04');
    const truckB = await mintTruck(day('04', '20'));
    await cargoOn(w.clientId, w.dealId, truckB, 1);
    await charge(w.clientId, 300, `${YEAR}-01-05`, { batchId: w.truckId });
    await charge(w.clientId, 200, `${YEAR}-04-21`, { batchId: truckB });
    await compensate(w, 300, `${YEAR}-04-22`);

    const aging = (await arAging(`${YEAR}-04-25`)).find((r) => r.clientId === w.clientId)!;
    expect(aging.balance).toBe(200);
    expect(aging.buckets).toEqual([200, 0, 0, 0]);

    const cargo = await clientCargo(w.clientId);
    expect(cargo.trips.find((t) => t.batchId === w.truckId)?.owedUsd).toBe(0);
    expect(cargo.trips.find((t) => t.batchId === truckB)?.owedUsd).toBe(200);
    expect(cargo).toMatchObject({ paidUsd: 0, compensatedUsd: 300, balanceUsd: 200 });
  });
});

describe('C5 — the door', () => {
  it('refuses a non-holder, a foreign or voided prixod, a prixod with nothing lost, a future day, an empty press', async () => {
    const w = await world('05');
    await expect(
      addCompensation(
        { clientId: w.clientId, receiptId: w.receiptId, amount: 10, currency: 'USD', txDate: day('05'), note: 'yo‘qolgan' },
        ctx(),
        { mayPayClient: false },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(compensate({ clientId: otherClientId, receiptId: w.receiptId }, 10, day('05'))).rejects.toMatchObject({
      code: 'receipt_mismatch',
    });
    const nothingLost = await world('05', { lost: 0 });
    await expect(compensate(nothingLost, 10, day('05'))).rejects.toMatchObject({ code: 'no_lost_cargo' });
    await expect(compensate(w, 10, `${Number(YEAR) + 500}-01-01`)).rejects.toMatchObject({ code: 'future_date' });
    await expect(compensate(w, undefined, day('05'))).rejects.toMatchObject({ code: 'nothing_to_do' });
    const voided = await world('05');
    await db
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' })
      .where(eq(receipts.id, voided.receiptId));
    await expect(compensate(voided, 10, day('05'))).rejects.toMatchObject({ code: 'receipt_mismatch' });
  });

  it('writes the row the prixod names: its deal, no kassa, no truck, no method — and the audit counts the loss', async () => {
    const w = await world('05');
    const { compensationId } = await compensate(w, 40, day('05', '15'));
    const [row] = await db.select().from(clientTransactions).where(eq(clientTransactions.id, compensationId!));
    expect(row).toMatchObject({
      type: 'compensation',
      receiptId: w.receiptId,
      dealId: w.dealId,
      accountId: null,
      batchId: null,
      method: null,
      partnerId: null,
    });
    const audit = (await db.execute(sql`
      SELECT after FROM audit_log WHERE entity_type = 'client_transaction' AND entity_id = ${compensationId}::uuid
        AND action = 'create'`)) as unknown as { after: { lostBoxes: number } }[];
    expect([...audit][0]?.after.lostBoxes).toBe(1);
  });

  it('the database itself refuses a compensation with a kassa, and any other kind naming a prixod', async () => {
    const w = await world('05');
    await expect(
      db.execute(sql`INSERT INTO client_transactions
        (id, client_id, type, amount, currency, rate_to_usd, amount_usd, tx_date, receipt_id, account_id, note, created_by)
        VALUES (${uuidv4()}::uuid, ${w.clientId}::uuid, 'compensation', 5, 'USD', 1, 5, ${day('05')}::date, ${w.receiptId}::uuid,
                ${tillId}::uuid, 'kassa bilan', ${actorId}::uuid)`),
    ).rejects.toThrow(/client_transactions_compensation_check/);
    await expect(
      db.execute(sql`INSERT INTO client_transactions
        (id, client_id, type, amount, currency, rate_to_usd, amount_usd, tx_date, receipt_id, created_by)
        VALUES (${uuidv4()}::uuid, ${w.clientId}::uuid, 'charge', 5, 'USD', 1, 5, ${day('05')}::date, ${w.receiptId}::uuid, ${actorId}::uuid)`),
    ).rejects.toThrow(/client_transactions_compensation_check/);
  });
});

describe('C6 — lowering the price in the same press keeps the truck, the deal and the day', () => {
  it('void + re-post: the copy keeps every clock; the truck, the deal and the balance follow', async () => {
    const w = await world('06');
    const old = await charge(w.clientId, 1000, day('06', '05'), { batchId: w.truckId });
    expect(old.dealId).toBe(w.dealId);
    await compensate(w, 500, day('06', '12'), [{ chargeId: old.id, newAmount: 600 }]);

    const [was] = await db.select().from(clientTransactions).where(eq(clientTransactions.id, old.id));
    expect(was!.voidedAt).not.toBeNull();
    const live = await db
      .select()
      .from(clientTransactions)
      .where(and(eq(clientTransactions.clientId, w.clientId), eq(clientTransactions.type, 'charge'), sql`voided_at IS NULL`));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      amount: '600.00',
      batchId: w.truckId,
      dealId: w.dealId,
      txDate: day('06', '05'),
      rateToUsd: was!.rateToUsd,
    });
    const truck = (await profitByBatch(day('06', '01'), day('06', '30'))).find((r) => r.batchId === w.truckId)!;
    expect(truck.revenueUsd).toBe(600);
    expect(await dealProfit(w.dealId!)).toMatchObject({ revenueUsd: 100, compensationUsd: 500 });
    expect(await clientBalanceUsd(w.clientId)).toBe(100);

    // The same (now voided) price pressed again from a stale screen: not a
    // price of this cargo any more, and nothing is written.
    const before = await db.select({ id: clientTransactions.id }).from(clientTransactions).where(eq(clientTransactions.clientId, w.clientId));
    await expect(compensate(w, undefined, day('06', '13'), [{ chargeId: old.id, newAmount: 300 }])).rejects.toMatchObject({
      code: 'charge_not_for_cargo',
    });
    const after = await db.select({ id: clientTransactions.id }).from(clientTransactions).where(eq(clientTransactions.clientId, w.clientId));
    expect(after).toHaveLength(before.length);
  });

  it('refuses a price on a truck the prixod never rode, and a «lower» price that is not lower; 0 removes', async () => {
    const w = await world('06');
    const own = await charge(w.clientId, 400, day('06', '05'), { batchId: w.truckId });
    const elsewhere = await mintTruck(day('06', '03'));
    await cargoOn(w.clientId, null, elsewhere, 1);
    const foreign = await charge(w.clientId, 300, day('06', '05'), { batchId: elsewhere });
    expect((await lostCargoChargesOn(db, w.clientId, [w.receiptId])).map((c) => c.id)).toEqual([own.id]);
    await expect(compensate(w, undefined, day('06', '12'), [{ chargeId: foreign.id, newAmount: 100 }])).rejects.toMatchObject({
      code: 'charge_not_for_cargo',
    });
    await expect(compensate(w, undefined, day('06', '12'), [{ chargeId: own.id, newAmount: 400 }])).rejects.toMatchObject({
      code: 'price_not_lower',
    });
    const uncovered = async () =>
      (await uncoveredBoxesOn(db, { kind: 'receipts', receiptIds: [w.receiptId] }, { landedOnly: false })).map(
        (row) => row.boxId,
      );
    expect(await uncovered()).toEqual([]);
    await compensate(w, undefined, day('06', '12'), [{ chargeId: own.id, newAmount: 0 }]);
    const live = await db
      .select()
      .from(clientTransactions)
      .where(and(eq(clientTransactions.batchId, w.truckId), sql`voided_at IS NULL`));
    expect(live).toHaveLength(0);
    // A price lowered to ZERO is still a price someone set (review of the
    // comp unit): the carton that arrived is not «unpriced» for ever.
    expect(await uncovered()).toEqual([]);
  });
});

describe('C7 — voiding: the kassa holders only, and cash handed out blocks it', () => {
  it('a non-holder is refused; an offset-only compensation voids and everything comes back', async () => {
    const w = await world('07');
    await charge(w.clientId, 1000, day('07'), { batchId: w.truckId });
    const { compensationId } = await compensate(w, 300, day('07', '12'));
    await expect(voidTransaction(compensationId!, 'xato', ctx(), { mayMoveTill: false })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await clientBalanceUsd(w.clientId)).toBe(700);
    await voidTransaction(compensationId!, 'xato', ctx(), { mayMoveTill: true });
    expect(await clientBalanceUsd(w.clientId)).toBe(1000);
    expect((await dealProfit(w.dealId!)).revenueUsd).toBe(1000);
    await expect(voidTransaction(compensationId!, 'xato', ctx(), { mayMoveTill: true })).rejects.toMatchObject({
      code: 'already_voided',
    });
  });

  it('V1/V6: cash handed out of it refuses the void, until the correct figure AND the returned cash stand', async () => {
    const w = await world('07');
    await charge(w.clientId, 1000, day('07'), { batchId: w.truckId });
    await pay(w.clientId, 1000, day('07'));
    const { compensationId } = await compensate(w, 1500, day('07', '12'));
    await refund(w.clientId, 1500, day('07', '13'));
    await expect(voidTransaction(compensationId!, 'xato', ctx(), { mayMoveTill: true })).rejects.toMatchObject({
      code: 'compensation_paid_out',
    });
    expect(await clientBalanceUsd(w.clientId)).toBe(0);
    await compensate(w, 1400, day('07', '14'));
    await expect(voidTransaction(compensationId!, 'xato', ctx(), { mayMoveTill: true })).rejects.toMatchObject({
      code: 'compensation_paid_out',
    });
    await pay(w.clientId, 100, day('07', '15'));
    await voidTransaction(compensationId!, 'xato', ctx(), { mayMoveTill: true });
    expect(await clientBalanceUsd(w.clientId)).toBe(0);
  });
});

describe('C8 — the prixod carries it: the deal follows, a client change and a void refuse', () => {
  it('re-filed onto a deal, the compensation follows; detached, it names none', async () => {
    const w = await world('08', { deal: false });
    const { compensationId } = await compensate(w, 1500, day('08', '12'));
    const target = await mintDeal(w.clientId);
    await linkReceipt(w.receiptId, target, ctx());
    const read = async () =>
      (await db.select({ dealId: clientTransactions.dealId }).from(clientTransactions).where(eq(clientTransactions.id, compensationId!)))[0]!
        .dealId;
    expect(await read()).toBe(target);
    expect((await dealProfit(target)).compensationUsd).toBe(1500);
    await linkReceipt(w.receiptId, null, ctx());
    expect(await read()).toBeNull();
    expect((await dealProfit(target)).compensationUsd).toBe(0);
  });

  it('a client change is refused and moves nothing', async () => {
    const w = await world('08');
    await compensate(w, 100, day('08', '12'));
    await expect(assignReceiptClient(w.receiptId, otherClientId, ctx())).rejects.toMatchObject({
      code: 'receipt_has_compensation',
    });
    const [still] = await db.select({ clientId: receipts.clientId }).from(receipts).where(eq(receipts.id, w.receiptId));
    expect(still!.clientId).toBe(w.clientId);
  });

  it('the void and the annul refuse, and the prixod stands', async () => {
    const w = await world('08');
    await compensate(w, 100, day('08', '12'));
    await expect(voidReceipt(w.receiptId, 'xato prixod', ctx())).rejects.toMatchObject({ code: 'receipt_has_compensation' });
    await expect(
      annulReceipt(w.receiptId, 'test prixod', { id: actorId, roles: ['super_admin'] }, ctx()),
    ).rejects.toMatchObject({ code: 'receipt_has_compensation' });
    const [still] = await db.select({ voidedAt: receipts.voidedAt }).from(receipts).where(eq(receipts.id, w.receiptId));
    expect(still!.voidedAt).toBeNull();
  });
});

describe('C9 — a found carton on a compensated prixod tells people', () => {
  const noticesFor = async (code: string) =>
    db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(and(eq(notifications.type, 'CompensatedCargoFound'), like(sql`${notifications.payload}->>'text'`, `%${code}%`)));

  it('one notice per recipient (the seller among them, never the presser), the ledger ⚠ and the issue screen ⚠', async () => {
    const w = await world('09');
    const [lostBox, keptBox] = w.boxIds;
    await compensate(w, 200, day('09', '12'));
    expect(await compensatedReceiptsAmong([lostBox!, keptBox!])).toEqual([]);

    await setBoxStatus({ boxId: lostBox!, to: 'in_stock', reason: 'topildi — test' }, ctx());

    const notices = await noticesFor(w.code);
    const people = notices.map((n) => n.userId);
    expect(people).toContain(sellerId);
    expect(people).not.toContain(actorId);
    expect(new Set(people).size).toBe(people.length);
    const row = (await clientLedger(w.clientId)).find(({ tx }) => tx.type === 'compensation')!;
    expect(row.foundSince).toBe(1);
    // The found carton names its prixod; the carton that never went missing
    // does not — a partial loss's other cartons are handed over as usual.
    expect(await compensatedReceiptsAmong([lostBox!])).toEqual([{ receiptNumber: w.number }]);
    expect(await compensatedReceiptsAmong([keptBox!])).toEqual([]);
  });

  it('a carton found on an uncompensated prixod tells nobody', async () => {
    const w = await world('09');
    await setBoxStatus({ boxId: w.boxIds[0]!, to: 'in_stock', reason: 'topildi — test' }, ctx());
    expect(await noticesFor(w.code)).toHaveLength(0);
  });
});

describe('C10 — the lenta and the client’s own labels name it', () => {
  it('the feed carries a compensation item and the cabinet’s summary its row', async () => {
    const w = await world('10');
    await compensate(w, 75, day('10', '12'));
    expect((await clientFeed(w.clientId)).some((item) => item.kind === 'compensation')).toBe(true);
    expect((await debtSummary(w.clientId)).recent.some((row) => row.type === 'compensation')).toBe(true);
  });
});
