import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
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
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { addTransaction } from '@/modules/wms/finance/service';
import { dealProfit } from '@/modules/wms/deals/service';

/**
 * «Mashinada qo'yilgan narx bitimga ham yozilsin» (owner's R3a, 2026-09-24):
 * a price set on a truck is also the DEAL's money when the client's cargo
 * aboard is that one deal's and nothing else — derived on the server from
 * the cargo, never from the form. Every refusal is a null deal, never an
 * error: the price itself is always taken.
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

/** One receipt of one lot of one box, departed on `batchId`. */
async function cargo(batchId: string, owner: string, dealId: string | null) {
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
}

const price = (batchId: string, amount = 250) =>
  addTransaction(
    { clientId, type: 'charge', amount, currency: 'USD', txDate: '2026-07-10', batchId },
    ctx(),
  );

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

  it('writes nothing for two deals aboard', async () => {
    const truck = await mintTruck();
    await cargo(truck, clientId, await mintDeal(clientId));
    await cargo(truck, clientId, await mintDeal(clientId));
    expect((await price(truck)).dealId).toBeNull();
  });

  it('writes nothing when deal cargo shares the truck with deal-less cargo', async () => {
    const dealId = await mintDeal(clientId);
    const truck = await mintTruck();
    await cargo(truck, clientId, dealId);
    await cargo(truck, clientId, null);
    expect((await price(truck)).dealId).toBeNull();
    // Still the deal's truck, so the card names the price beside its revenue.
    expect((await dealProfit(dealId)).unlinkedBatchUsd).toBe(250);
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
