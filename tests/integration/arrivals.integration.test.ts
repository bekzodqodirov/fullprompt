import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, boxes, clients, users, warehouses } from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import { ingestUnloadScans } from '@/modules/wms/scanning/unload';
import {
  ArrivalError,
  cancelExpectedArrival,
  createExpectedArrival,
  incomingTrucks,
  issuingWarehouseIds,
  listExpected,
} from '@/modules/wms/arrivals/service';

/**
 * What is coming to a warehouse: the cargo a client promised, and the truck
 * one of our own warehouses put on the road.
 */

const WH_FROM = 'ARFRM';
const WH_TO = 'ARTO';
let whFrom: string;
let whTo: string;
let actorId: string;
let clientId: string;
const ctx = () => ({ actorId });

async function makeLot(warehouseId: string, boxCount: number) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `artest/${lotId}`,
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
          productNameZh: '货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 40,
          boxWidthCm: 40,
          boxHeightCm: 40,
          boxWeightKg: 10,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
  return { receiptId, lotId, shortCodes: rows.map((b) => b.shortCode) };
}

beforeAll(async () => {
  async function ensureWarehouse(code: string, type: string, issues: boolean): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({
        code,
        name: `AR ${code}`,
        country: 'CN',
        type,
        timezone: 'Asia/Shanghai',
        batchPrefix: code,
        issuesToClients: issues,
      })
      .returning();
    return wh!.id;
  }
  whFrom = await ensureWarehouse(WH_FROM, 'origin', false);
  whTo = await ensureWarehouse(WH_TO, 'distribution', true);
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AR${String(Date.now()).slice(-6)}`, name: 'Arrival client' })
    .returning();
  clientId = c!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('cargo a client promised', () => {
  it('is listed until the real receipt closes it', async () => {
    const promise = await createExpectedArrival(
      { warehouseId: whFrom, clientId, boxCount: 5, expectedOn: '2026-08-01', note: 'kuryer' },
      ctx(),
    );

    const waiting = await listExpected([whFrom]);
    expect(waiting.map((row) => row.id)).toContain(promise.id);
    expect(waiting.find((row) => row.id === promise.id)!.boxCount).toBe(5);

    // The boxes turn up and are received normally — nobody has to remember
    // to tick the promise off.
    await makeLot(whFrom, 5);
    const after = await listExpected([whFrom]);
    expect(after.map((row) => row.id)).not.toContain(promise.id);
    const row = await db.query.expectedArrivals.findFirst({ where: (t, { eq: e }) => e(t.id, promise.id) });
    expect(row!.status).toBe('arrived');
    expect(row!.receiptId).not.toBeNull();
  });

  it('leaves BOTH promises open when two could match the same receipt', async () => {
    const a = await createExpectedArrival({ warehouseId: whFrom, clientId, boxCount: 1 }, ctx());
    const b = await createExpectedArrival({ warehouseId: whFrom, clientId, boxCount: 2 }, ctx());
    await makeLot(whFrom, 1);
    // Guessing which one the receipt answered would close a promise that is
    // still genuinely outstanding.
    const open = (await listExpected([whFrom])).map((row) => row.id);
    expect(open).toContain(a.id);
    expect(open).toContain(b.id);

    await cancelExpectedArrival(a.id, 'mijoz jo‘natmadi', ctx());
    await cancelExpectedArrival(b.id, 'mijoz jo‘natmadi', ctx());
    expect(await listExpected([whFrom])).toHaveLength(0);
    // A cancellation has to say why, and a closed row cannot be closed twice.
    await expect(cancelExpectedArrival(b.id, 'x', ctx())).rejects.toThrow(ArrivalError);
  });

  it('needs a client or a marking', async () => {
    const { expectedArrivalSchema } = await import('@/modules/wms/arrivals/service');
    expect(expectedArrivalSchema.safeParse({ warehouseId: whFrom }).success).toBe(false);
    expect(
      expectedArrivalSchema.safeParse({ warehouseId: whFrom, marking: 'ABC 123' }).success,
    ).toBe(true);
  });
});

describe('trucks on the way here', () => {
  it('count down as boxes are accepted, and only for the receiving warehouse', async () => {
    const lot = await makeLot(whFrom, 3);
    const sub = await submitPlan(
      {
        originWarehouseId: whFrom,
        destWarehouseId: whTo,
        lines: [{ lotId: lot.lotId, boxCount: 3 }],
      },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    const scan = (code: string) => ({
      clientEventUuid: uuidv4(),
      batchId: batch!.id,
      code,
      method: 'qr' as const,
      addedOnSpot: false,
      scannedAt: new Date().toISOString(),
    });
    for (const code of lot.shortCodes) await ingestLoadScans([scan(code)], ctx());
    await departBatch(batch!.id, ctx());

    const incoming = await incomingTrucks([whTo]);
    const mine = incoming.find((row) => row.batchId === batch!.id)!;
    expect(mine).toBeDefined();
    expect(mine.boxCount).toBe(3);
    expect(mine.remaining).toBe(3);
    expect(mine.kg).toBeCloseTo(30, 1);

    // The sending warehouse is not waiting for its own truck.
    expect((await incomingTrucks([whFrom])).some((row) => row.batchId === batch!.id)).toBe(false);

    // Accepting a box lowers what is still on the truck — the count must not
    // lose the accepted boxes altogether (DECISIONS #121).
    await ingestUnloadScans([scan(lot.shortCodes[0]!)], ctx());
    const after = (await incomingTrucks([whTo])).find((row) => row.batchId === batch!.id)!;
    expect(after.boxCount).toBe(3);
    expect(after.remaining).toBe(2);
  });
});

describe('handover is a warehouse setting', () => {
  it('lists only the warehouses a client collects from', async () => {
    const ids = await issuingWarehouseIds();
    expect(ids).toContain(whTo);
    expect(ids).not.toContain(whFrom);
    // Scoped to an operator who works at the sending warehouse: nothing.
    expect(await issuingWarehouseIds([whFrom])).toHaveLength(0);
  });
});
