import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clients,
  costTypes,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import { ingestUnloadScans } from '@/modules/wms/scanning/unload';
import {
  addCostEntry,
  batchCostSheet,
  boxLandedCost,
  recomputeAll,
  upsertFxRate,
  voidCostEntry,
} from '@/modules/wms/costing/service';

/**
 * Acceptance test 16 (spec 6.9): box P rides two batches and its landed cost
 * is the sum of its per-leg shares, each converted at THAT entry's dated
 * rate; a rate edit recomputes everything.
 */

const WH_A = 'M6STA';
const WH_B = 'M6STB';
const WH_C = 'M6STC';
let whA: string;
let whB: string;
let whC: string;
let actorId: string;
let clientId: string;
let freightTypeId: string;
const ctx = () => ({ actorId });

async function makeLot(boxCount: number, boxKg: number, warehouseId: string) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `m6test/${lotId}`,
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
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '成本货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 50,
          boxWidthCm: 40,
          boxHeightCm: 30,
          boxWeightKg: boxKg,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
  return { receiptId, lotId, boxIds: rows.map((b) => b.id), shortCodes: rows.map((b) => b.shortCode) };
}

const scan = (batchId: string, code: string) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'qr' as const,
  addedOnSpot: false,
  scannedAt: new Date().toISOString(),
});

async function rideBatch(
  lots: { lotId: string; shortCodes: string[]; take: number }[],
  originWarehouseId: string,
  destWarehouseId: string,
) {
  const sub = await submitPlan(
    {
      originWarehouseId,
      destWarehouseId,
      lines: lots.map((l) => ({ lotId: l.lotId, boxCount: l.take })),
    },
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
  for (const lot of lots) {
    for (const code of lot.shortCodes.slice(0, lot.take)) {
      const [ack] = await ingestLoadScans([scan(batch!.id, code)], ctx());
      if (ack!.result !== 'ok') throw new Error(`load failed: ${ack!.result}`);
    }
  }
  await departBatch(batch!.id, ctx());
  return batch!;
}

/** Unload every departed box so it can ride the next leg. */
async function unloadAll(batchId: string, shortCodes: string[]) {
  for (const code of shortCodes) {
    await ingestUnloadScans([scan(batchId, code)], ctx());
  }
}

beforeAll(async () => {
  async function ensureWarehouse(code: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `M6 ${code}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
      .returning();
    return wh!.id;
  }
  whA = await ensureWarehouse(WH_A);
  whB = await ensureWarehouse(WH_B);
  whC = await ensureWarehouse(WH_C);
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const suffix = String(Date.now()).slice(-6);
  const [c] = await db.insert(clients).values({ clientCode: `M6${suffix}`, name: 'M6 client' }).returning();
  clientId = c!.id;
  freightTypeId = (await db.select().from(costTypes).limit(1))[0]!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('landed cost across a two-leg journey (acceptance test 16)', () => {
  it('box P = leg shares at dated rates; rate edit recomputes; void removes', async () => {
    // Two dated CNY rates — each leg's entry converts at ITS date's rate.
    await upsertFxRate({ currency: 'CNY', rateToUsd: 0.14, effectiveDate: '2026-07-01' }, ctx());
    await upsertFxRate({ currency: 'CNY', rateToUsd: 0.135, effectiveDate: '2026-07-15' }, ctx());

    // Lot P: 1 box of 30 kg; filler: 9 boxes of 1,080.(-) kg... use round numbers:
    // leg 1 total = 30 (P) + 970 (filler) = 1,000 kg; freight 1,000 CNY → 1 CNY/kg.
    const lotP = await makeLot(1, 30, whA);
    const filler1 = await makeLot(1, 970, whA);
    const leg1 = await rideBatch(
      [
        { lotId: lotP.lotId, shortCodes: lotP.shortCodes, take: 1 },
        { lotId: filler1.lotId, shortCodes: filler1.shortCodes, take: 1 },
      ],
      whA,
      whB,
    );
    await addCostEntry(
      {
        scope: 'batch',
        batchId: leg1.id,
        costTypeId: freightTypeId,
        amount: 1000,
        currency: 'CNY',
        costDate: '2026-07-05', // → rate 0.14
        allocationBasis: 'weight',
      },
      ctx(),
    );

    // Leg 2 from B: P (30 kg) + filler2 (1,470 kg) = 1,500 kg; freight 3,000 CNY → 2 CNY/kg.
    await unloadAll(leg1.id, [...lotP.shortCodes, ...filler1.shortCodes]);
    const filler2 = await makeLot(1, 1470, whB);
    const leg2 = await rideBatch(
      [
        { lotId: lotP.lotId, shortCodes: lotP.shortCodes, take: 1 },
        { lotId: filler2.lotId, shortCodes: filler2.shortCodes, take: 1 },
      ],
      whB,
      whC,
    );
    await addCostEntry(
      {
        scope: 'batch',
        batchId: leg2.id,
        costTypeId: freightTypeId,
        amount: 3000,
        currency: 'CNY',
        costDate: '2026-07-20', // → rate 0.135
        allocationBasis: 'weight',
      },
      ctx(),
    );

    // P's landed cost: 30 CNY @0.14 + 60 CNY @0.135 = 4.20 + 8.10 = 12.30 USD.
    const landedP = await boxLandedCost(lotP.boxIds[0]!);
    expect(landedP.shares).toHaveLength(2);
    expect(landedP.totalUsd).toBeCloseTo(30 * 0.14 + 60 * 0.135, 2);

    // Filler2 (box Q analogue) has a different journey → different landed cost.
    const landedQ = await boxLandedCost(filler2.boxIds[0]!);
    expect(landedQ.totalUsd).not.toBeCloseTo(landedP.totalUsd, 2);

    // Batch cost sheet has totals + unit costs.
    const sheet = await batchCostSheet(leg2.id);
    expect(sheet.boxCount).toBe(2);
    expect(sheet.totalUsd).toBeCloseTo(3000 * 0.135, 2);
    expect(sheet.usdPerKg).toBeCloseTo((3000 * 0.135) / 1500, 3);

    // Rate correction (edge case 18): update the July-15 rate → recompute moves P.
    await upsertFxRate({ currency: 'CNY', rateToUsd: 0.15, effectiveDate: '2026-07-15' }, ctx());
    await recomputeAll({ currency: 'CNY' });
    const landedP2 = await boxLandedCost(lotP.boxIds[0]!);
    expect(landedP2.totalUsd).toBeCloseTo(30 * 0.14 + 60 * 0.15, 2);

    // Void the leg-1 entry → its share disappears.
    const sheet1 = await batchCostSheet(leg1.id);
    await voidCostEntry(sheet1.entries[0]!.entry.id, 'entered twice', ctx());
    const landedP3 = await boxLandedCost(lotP.boxIds[0]!);
    expect(landedP3.shares).toHaveLength(1);
    expect(landedP3.totalUsd).toBeCloseTo(60 * 0.15, 2);
  });

  it('currency without any rate stays unconverted and is flagged', async () => {
    const lot = await makeLot(1, 10, whA);
    const batch = await rideBatch([{ lotId: lot.lotId, shortCodes: lot.shortCodes, take: 1 }], whA, whB);
    await addCostEntry(
      {
        scope: 'batch',
        batchId: batch.id,
        costTypeId: freightTypeId,
        amount: 500,
        currency: 'UZS',
        costDate: '2026-07-20',
        allocationBasis: 'boxes',
      },
      ctx(),
    );
    const sheet = await batchCostSheet(batch.id);
    expect(sheet.unconverted).toBe(1);
    const landed = await boxLandedCost(lot.boxIds[0]!);
    expect(landed.shares).toHaveLength(0);
  });
});
