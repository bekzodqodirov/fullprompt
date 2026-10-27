import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  boxMovements,
  boxes,
  clientTransactions,
  clients,
  dealStages,
  deals,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { addTransaction, truckDealHeads } from '@/modules/wms/finance/service';
import { dealProfit } from '@/modules/wms/deals/service';
import { cargoAboard, dealCandidateRows } from '@/modules/wms/batches/lots';
import { dealCandidatesOf } from '@/modules/wms/finance/truck-deal';

/**
 * «Mashinada qo'yilgan narx bitimga ham yozilsin» (owner's R3a, 2026-09-24):
 * a price set on a truck is also the DEAL's money when the client's cargo
 * aboard is that one deal's and nothing else — derived on the server from the
 * cargo. And his Q8 «c» (2026-10-27, «logist o'zi tanlaydi»): when two or more
 * of the client's deals ride the truck, the person setting the price CHOOSES
 * the deal, the choice is checked against the cargo aboard, and a price with
 * no choice is refused at every door — a refused choice writes nothing.
 *
 * Each case rides its own truck, so no case's cargo is another's input.
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
let cn: string;
let uz: string;
let clientId: string;
let otherClientId: string;
let stageId: string;
const madeBatches: string[] = [];
const madeDeals: string[] = [];
const madeReceipts: string[] = [];
const madeLots: string[] = [];
const madeBoxes: string[] = [];
const ctx = () => ({ actorId });
let seq = 0;

async function mintWarehouse(code: string, country: string) {
  return (
    await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name: `Narx-bitim ${code}`, country, type: 'origin', timezone: 'Asia/Shanghai' })
      .returning({ id: warehouses.id })
  )[0]!.id;
}

async function mintDeal(owner: string) {
  seq += 1;
  const id = (
    await db
      .insert(deals)
      .values({ code: `TP${S}-${seq}`, clientId: owner, stageId, title: `Narx bitimi ${seq}`, createdBy: actorId })
      .returning({ id: deals.id })
  )[0]!.id;
  madeDeals.push(id);
  return id;
}

async function mintTruck() {
  seq += 1;
  const id = uuidv4();
  await db.insert(batches).values({
    id,
    code: `TP${S}-B${seq}`,
    originWarehouseId: cn,
    destWarehouseId: uz,
    status: 'in_transit',
    departedAt: new Date(),
    createdBy: actorId,
  });
  madeBatches.push(id);
  return id;
}

/** One receipt of one lot of one box, departed on `batchId` — its receipt id. */
async function cargo(batchId: string, owner: string, dealId: string | null): Promise<string> {
  seq += 1;
  const receiptId = (
    await db
      .insert(receipts)
      .values({ warehouseId: cn, clientId: owner, dealId, status: 'confirmed', createdBy: actorId })
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
        boxCount: 1,
        dimsMode: 'mixed',
        totalWeightKg: '10',
        totalVolumeM3: '0.1',
      })
      .returning({ id: receiptLots.id })
  )[0]!.id;
  madeLots.push(lotId);
  const boxId = (
    await db
      .insert(boxes)
      .values({ lotId, shortCode: `TP${S}X${seq}`, seqInLot: 1, currentWarehouseId: null, status: 'in_transit' })
      .returning({ id: boxes.id })
  )[0]!.id;
  madeBoxes.push(boxId);
  await db.insert(boxMovements).values({
    boxId,
    fromWarehouseId: cn,
    toWarehouseId: uz,
    fromStatus: 'loading',
    toStatus: 'in_transit',
    cause: 'batch_departed',
    refType: 'batch',
    refId: batchId,
    actorId,
  });
  return receiptId;
}

const price = (batchId: string, amount = 250, choice: { dealId?: string; dealsSeen?: string } = {}) =>
  addTransaction(
    { clientId, type: 'charge', amount, currency: 'USD', txDate: '2026-07-10', batchId, ...choice },
    ctx(),
  );

/** The question the «Narx» tab draws for this client on that truck. */
async function keyOf(batchId: string) {
  return (await cargoAboard(batchId, clientId)).candidates.key;
}

const livePrices = (batchId: string) =>
  db
    .select({ id: clientTransactions.id, dealId: clientTransactions.dealId })
    .from(clientTransactions)
    .where(and(eq(clientTransactions.batchId, batchId), eq(clientTransactions.type, 'charge')));

async function dealViaOf(txId: string) {
  const [row] = await db
    .select({ after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'client_transaction'), eq(auditLog.entityId, txId)));
  return (row?.after as { dealVia?: string } | null)?.dealVia ?? null;
}

/** Somebody else's transaction, held open on its own connection. */
async function withHolder(run: (held: postgres.ReservedSql) => Promise<void>) {
  const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
    max: 1,
    onnotice: () => {},
  });
  const held = await helper.reserve();
  try {
    await run(held);
  } finally {
    held.release();
    await helper.end();
  }
}

/** Is anybody waiting on a lock? Asked through the POOL (#873). */
async function someoneWaits(): Promise<boolean> {
  for (let i = 0; i < 250; i += 1) {
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  cn = await mintWarehouse(`TA${S}`, 'CN');
  uz = await mintWarehouse(`TU${S}`, 'UZ');
  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `TP${S}`, name: `Narx mijoz ${S}` })
      .returning({ id: clients.id })
  )[0]!.id;
  otherClientId = (
    await db
      .insert(clients)
      .values({ clientCode: `TQ${S}`, name: `Boshqa mijoz ${S}` })
      .returning({ id: clients.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, [clientId, otherClientId]));
  await db.delete(boxMovements).where(inArray(boxMovements.boxId, madeBoxes));
  await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  await db.delete(receiptLots).where(inArray(receiptLots.id, madeLots));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  await db.delete(deals).where(inArray(deals.id, madeDeals));
  await db.delete(batches).where(inArray(batches.id, madeBatches));
  await db.delete(clients).where(inArray(clients.id, [clientId, otherClientId]));
  await db.delete(warehouses).where(inArray(warehouses.id, [cn, uz]));
  await pgClient.end();
});

describe('a truck price lands on the deal when the cargo aboard is one deal’s', () => {
  it('writes the deal, and the deal’s profit counts it as its own revenue', async () => {
    const dealId = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, dealId);
    await cargo(truck, clientId, dealId);

    const row = await price(truck);
    expect(row.dealId).toBe(dealId);

    // The money reaches the deal card: revenue, and nothing left «unlinked».
    const profit = await dealProfit(dealId);
    expect(profit.revenueUsd).toBe(250);
    expect(profit.unlinkedBatchUsd).toBe(0);
  });

  it('writes nothing when deal cargo shares the truck with deal-less cargo — and nobody is asked', async () => {
    const dealId = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, dealId);
    await cargo(truck, clientId, null);
    // His Q8 was about two DEALS; this mix keeps R3a's null, derived.
    expect((await cargoAboard(truck, clientId)).candidates.ambiguous).toBe(false);
    const row = await price(truck, 250, { dealsSeen: await keyOf(truck) });
    expect(row.dealId).toBeNull();
    // Still the deal's truck, so the card names the price beside its revenue.
    expect((await dealProfit(dealId)).unlinkedBatchUsd).toBe(250);
    // The deal's own id typed onto that mix is refused, never quietly written:
    // the deal-less goods' price would ride onto the deal.
    await expect(price(truck, 1, { dealId })).rejects.toMatchObject({ code: 'deal_choice_invalid' });
  });

  // The subject changed with 0104: a truck price for a client with NOTHING
  // aboard is refused outright (`client_not_aboard`, U31 claim 1) — it names
  // no cargo, and it is exactly the price the screens would then call «yuki
  // ketmagan». The old half still holds: another client's deal on the truck
  // is never written anywhere.
  it('refuses a price when the client has no cargo aboard — and writes no foreign deal', async () => {
    const truck = await mintTruck();
    await cargo(truck, otherClientId, await mintDeal(otherClientId));
    await expect(price(truck)).rejects.toMatchObject({ code: 'client_not_aboard' });
    const written = await db
      .select({ id: clientTransactions.id })
      .from(clientTransactions)
      .where(eq(clientTransactions.batchId, truck));
    expect(written).toHaveLength(0);
  });

  it('never writes a deal that belongs to another client, even through the client’s own receipt', async () => {
    const truck = await mintTruck();
    await cargo(truck, clientId, await mintDeal(otherClientId));
    expect((await price(truck)).dealId).toBeNull();
  });

  it('a payment naming the truck is money received, not a price: no deal derived', async () => {
    const dealId = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, dealId);
    // No cash box: the service does not demand one (the form's door does),
    // and naming none keeps this case free of the till fixtures.
    const paid = await addTransaction(
      { clientId, type: 'payment', amount: 5, currency: 'USD', method: 'cash', txDate: '2026-07-10', batchId: truck },
      ctx(),
    );
    expect(paid.dealId).toBeNull();
  });
});

describe('two of the client’s deals on one truck — the person chooses (his Q8 «c»)', () => {
  it('refuses a price with no choice, at every door — and writes nothing', async () => {
    const truck = await mintTruck();
    await cargo(truck, clientId, await mintDeal(clientId));
    await cargo(truck, clientId, await mintDeal(clientId));
    // The «Narx» tab (it posts the question it drew) …
    await expect(price(truck, 250, { dealsSeen: await keyOf(truck) })).rejects.toMatchObject({
      code: 'deal_choice_required',
    });
    // … and the ledger form or a script, which may post none.
    await expect(price(truck)).rejects.toMatchObject({ code: 'deal_choice_required' });
    expect(await livePrices(truck)).toHaveLength(0);
  });

  it('writes the chosen deal, and the history says it was chosen', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, b);
    const row = await price(truck, 100, { dealId: b, dealsSeen: await keyOf(truck) });
    expect(row.dealId).toBe(b);
    expect(await dealViaOf(row.id)).toBe('chosen');
    // A's card names where the truck's price went instead of reading cost
    // with no revenue and no sentence (review)…
    const profitA = await dealProfit(a);
    expect(profitA.revenueUsd).toBe(0);
    expect(profitA.otherDealPrices).toEqual([
      expect.objectContaining({ batchId: truck, dealId: b, usd: 100 }),
    ]);
    // …until A gets its own part: then the line has nothing left to explain.
    await price(truck, 150, { dealId: a, dealsSeen: await keyOf(truck) });
    expect((await dealProfit(a)).otherDealPrices).toEqual([]);
    expect((await dealProfit(a)).revenueUsd).toBe(150);
  });

  it('«bitimsiz» only for the deal-less part — never as option (a) on a deals-only truck', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const onlyDeals = await mintTruck();
    await cargo(onlyDeals, clientId, a);
    await cargo(onlyDeals, clientId, b);
    await expect(price(onlyDeals, 50, { dealId: 'none', dealsSeen: await keyOf(onlyDeals) })).rejects.toMatchObject({
      code: 'deal_choice_invalid',
    });

    const withLoose = await mintTruck();
    await cargo(withLoose, clientId, a);
    await cargo(withLoose, clientId, b);
    await cargo(withLoose, clientId, null);
    const row = await price(withLoose, 50, { dealId: 'none', dealsSeen: await keyOf(withLoose) });
    expect(row.dealId).toBeNull();
    expect(await dealViaOf(row.id)).toBe('none');
  });

  it('«bitimsiz» on a payment is a refusal in words, never a postgres error page', async () => {
    // 'none' read as a uuid is 22P02 — the error page, not a sentence (review).
    await expect(
      addTransaction(
        { clientId, type: 'payment', amount: 5, currency: 'USD', method: 'cash', txDate: '2026-07-10', dealId: 'none' },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'deal_choice_invalid' });
  });

  it('refuses a deal whose cargo is not aboard — the ledger form could pair any truck with any deal', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const elsewhere = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, b);
    await expect(price(truck, 75, { dealId: elsewhere })).rejects.toMatchObject({ code: 'deal_not_aboard' });
    // Another client's deal is refused first, as it always was.
    await expect(price(truck, 75, { dealId: await mintDeal(otherClientId) })).rejects.toMatchObject({
      code: 'deal_mismatch',
    });
    expect(await livePrices(truck)).toHaveLength(0);
  });

  it('refuses a page drawn before the cargo moved — the old question is never answered', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    const receiptB = await cargo(truck, clientId, b);
    const drawn = await keyOf(truck);
    // B's prixod is re-filed onto A after the page was drawn.
    await db.update(receipts).set({ dealId: a }).where(eq(receipts.id, receiptB));
    await expect(price(truck, 80, { dealId: a, dealsSeen: drawn })).rejects.toMatchObject({ code: 'deals_changed' });
    // Redrawn, the truck is A's alone: derived, as R3a says.
    const row = await price(truck, 80, { dealsSeen: await keyOf(truck) });
    expect(row.dealId).toBe(a);
    expect(await dealViaOf(row.id)).toBe('derived');
  });

  it('decides again inside its transaction: a re-file that lands while the price waits is refused, not written', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    const receiptB = await cargo(truck, clientId, b);
    const drawn = await keyOf(truck);
    await withHolder(async (held) => {
      // Hold the client's money lock, the first thing the price's
      // transaction takes — its pool reads have already passed by then.
      await held`BEGIN`;
      await held`SELECT pg_advisory_xact_lock(hashtext('client-money'), hashtext(${clientId}::text))`;
      const pressed = price(truck, 90, { dealId: b, dealsSeen: drawn }).then(
        (row) => ({ row, err: null }),
        (err: unknown) => ({ row: null, err }),
      );
      expect(await someoneWaits(), 'the price never had to wait for the lock').toBe(true);
      // While it waits, B's prixod is re-filed onto A (what `linkReceipt` writes).
      await held`UPDATE receipts SET deal_id = ${a}::uuid WHERE id = ${receiptB}::uuid`;
      await held`COMMIT`;
      const result = await pressed;
      expect(result.err).toMatchObject({ code: 'deals_changed' });
    });
    expect(await livePrices(truck)).toHaveLength(0);
  });

  it('the «Narx» tab and the ledger draw exactly the question the door asks', async () => {
    const a = await mintDeal(clientId);
    const b = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, a);
    await cargo(truck, clientId, b);
    // A prixod re-assigned to this client still names the other client's job.
    await cargo(truck, clientId, await mintDeal(otherClientId));
    await cargo(truck, otherClientId, await mintDeal(otherClientId));
    const door = (await cargoAboard(truck, clientId)).candidates;
    // The tab reads the whole truck once and folds per client…
    const tab = dealCandidatesOf(
      (await dealCandidateRows([truck], null)).filter((row) => row.clientId === clientId),
      clientId,
    );
    // …the ledger reads its trucks for this client.
    const ledger = dealCandidatesOf(
      (await dealCandidateRows([truck], clientId)).filter((row) => row.batchId === truck),
      clientId,
    );
    expect(door).toMatchObject({ deals: [a, b].sort(), none: true, ambiguous: true });
    expect(tab).toEqual(door);
    expect(ledger).toEqual(door);
  });

  it('says which offered deal carries a live «muddat», and which already has its own price off any truck', async () => {
    const deferred = await mintDeal(clientId);
    const plain = await mintDeal(clientId);
    await db
      .update(deals)
      .set({ deferredAt: new Date(), deferUntilAllArrived: true, deferralReason: 'Q8 sinov' })
      .where(eq(deals.id, deferred));
    // A deal price with no truck, from the ledger.
    await addTransaction(
      { clientId, type: 'charge', amount: 40, currency: 'USD', txDate: '2026-07-10', dealId: plain },
      ctx(),
    );
    const heads = await truckDealHeads([deferred, plain]);
    expect(heads.get(deferred)).toMatchObject({ deferred: true, cardPriced: false });
    expect(heads.get(plain)).toMatchObject({ deferred: false, cardPriced: true });
  });
});
