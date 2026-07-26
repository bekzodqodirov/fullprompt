import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, boxes, clients, costTypes, users, warehouses } from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import { addCostEntry, batchLandedCostByClient, upsertFxRate } from '@/modules/wms/costing/service';
import { addTransaction } from '@/modules/wms/finance/service';
import { clientCargo, managedClients } from '@/modules/wms/finance/client-cargo';

/**
 * The owner's question, asked from three screens and answered once: where is
 * this client's cargo, what does it weigh, what did it cost us, and which
 * trip is the debt from.
 */

const WH_FROM = 'CCFRM';
const WH_TO = 'CCTO';
let whFrom: string;
let whTo: string;
let actorId: string;
let clientId: string;
let fillerId: string;
let batchId: string;
let costTypeId: string;
const ctx = () => ({ actorId });

/** 2 boxes of 25 kg, each 50×40×30 cm = 0.06 m³ → 50 kg and 0.12 m³ a client. */
async function makeLot(ownerId: string, warehouseId: string) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `cctest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId: ownerId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '货',
          boxCount: 2,
          dimsMode: 'uniform',
          boxLengthCm: 50,
          boxWidthCm: 40,
          boxHeightCm: 30,
          boxWeightKg: 25,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
  return { lotId, shortCodes: rows.map((b) => b.shortCode) };
}

beforeAll(async () => {
  async function ensureWarehouse(code: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({
        code,
        name: `CC ${code}`,
        country: 'CN',
        type: 'origin',
        timezone: 'Asia/Shanghai',
        batchPrefix: code,
      })
      .returning();
    return wh!.id;
  }
  whFrom = await ensureWarehouse(WH_FROM);
  whTo = await ensureWarehouse(WH_TO);
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  costTypeId = (await db.select().from(costTypes).limit(1))[0]!.id;

  const suffix = String(Date.now()).slice(-6);
  // The client belongs to this manager, so "my clients" has something to find.
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `CC${suffix}`, name: 'Cargo client', salesManagerId: actorId })
    .returning();
  clientId = c!.id;
  const [f] = await db
    .insert(clients)
    .values({ clientCode: `CF${suffix}`, name: 'Filler client' })
    .returning();
  fillerId = f!.id;

  const ours = await makeLot(clientId, whFrom);
  const theirs = await makeLot(fillerId, whFrom);

  const sub = await submitPlan(
    {
      originWarehouseId: whFrom,
      destWarehouseId: whTo,
      lines: [
        { lotId: ours.lotId, boxCount: 2 },
        { lotId: theirs.lotId, boxCount: 2 },
      ],
    },
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
  batchId = batch!.id;
  for (const code of [...ours.shortCodes, ...theirs.shortCodes]) {
    const [ack] = await ingestLoadScans(
      [
        {
          clientEventUuid: uuidv4(),
          batchId,
          code,
          method: 'qr' as const,
          addedOnSpot: false,
          scannedAt: new Date().toISOString(),
        },
      ],
      ctx(),
    );
    if (ack!.result !== 'ok') throw new Error(`load failed: ${ack!.result}`);
  }
  await departBatch(batchId, ctx());

  // Customs for the whole truck, split by weight: 100 kg total, half ours.
  await upsertFxRate({ currency: 'USD', rateToUsd: 1, effectiveDate: '2026-07-01' }, ctx());
  await addCostEntry(
    {
      scope: 'batch',
      batchId,
      costTypeId,
      amount: 200,
      currency: 'USD',
      costDate: '2026-07-10',
      allocationBasis: 'weight',
    },
    ctx(),
  );

  // Priced at 160, paid 60 → 100 still owed, all of it from this trip.
  await addTransaction(
    { clientId, type: 'charge', amount: 160, currency: 'USD', txDate: '2026-07-11', batchId },
    ctx(),
  );
  await addTransaction(
    { clientId, type: 'payment', amount: 60, currency: 'USD', txDate: '2026-07-12', method: 'cash' },
    ctx(),
  );
});

afterAll(async () => {
  await pgClient.end();
});

describe("one client's cargo and the money on it", () => {
  it('splits a truck-wide customs charge down to the client', async () => {
    const byClient = await batchLandedCostByClient(batchId);
    // 200 USD over 100 kg on the truck, half of it ours → 100 USD each.
    expect(byClient.get(clientId)!.totalUsd).toBeCloseTo(100, 2);
    expect(byClient.get(clientId)!.batchUsd).toBeCloseTo(100, 2);
    expect(byClient.get(fillerId)!.totalUsd).toBeCloseTo(100, 2);
  });

  it('says where the cargo is, what it weighs and which trip the debt is from', async () => {
    const cargo = await clientCargo(clientId);

    // Departed but not yet accepted: on a truck.
    expect(cargo.locations).toHaveLength(1);
    expect(cargo.locations[0]!.state).toBe('transit');
    expect(cargo.locations[0]!.boxCount).toBe(2);
    expect(cargo.totals.kg).toBeCloseTo(50, 1);
    expect(cargo.totals.m3).toBeCloseTo(0.12, 3);

    expect(cargo.trips).toHaveLength(1);
    const trip = cargo.trips[0]!;
    expect(trip.batchId).toBe(batchId);
    expect(trip.boxCount).toBe(2);
    expect(trip.kg).toBeCloseTo(50, 1);
    expect(trip.chargedUsd).toBeCloseTo(160, 2);
    // The payment settles against the oldest charge first, so 60 of the 160
    // is gone and this trip still carries 100.
    expect(trip.owedUsd).toBeCloseTo(100, 2);

    expect(cargo.chargedUsd).toBeCloseTo(160, 2);
    expect(cargo.paidUsd).toBeCloseTo(60, 2);
    expect(cargo.balanceUsd).toBeCloseTo(100, 2);
    expect(cargo.unassignedOwedUsd).toBeCloseTo(0, 2);
  });

  it('lists the manager\'s own clients with cargo and balance', async () => {
    const mine = await managedClients(actorId);
    const row = mine.find((r) => r.clientId === clientId);
    expect(row).toBeDefined();
    expect(row!.boxCount).toBe(2);
    expect(row!.kg).toBeCloseTo(50, 1);
    expect(row!.m3).toBeCloseTo(0.12, 3);
    expect(row!.balanceUsd).toBeCloseTo(100, 2);
    // Someone else's client is not in MY list.
    expect(mine.some((r) => r.clientId === fillerId)).toBe(false);
    // …but the unfiltered list has both.
    const all = await managedClients();
    expect(all.some((r) => r.clientId === fillerId)).toBe(true);
  });
});
