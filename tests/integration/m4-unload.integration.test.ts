import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, batches, boxes, clients, users, warehouses } from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import {
  closeBatch,
  finishUnload,
  ingestUnloadScans,
  resolveMissing,
} from '@/modules/wms/scanning/unload';

/** M4: unload reconciliation per spec 6.5 — acceptance tests 13/14 core. */

const WH_O = 'M4STO';
const WH_D = 'M4STD';
let originId: string;
let destId: string;
let actorId: string;
let clientId: string;
const ctx = () => ({ actorId });

async function makeLot(boxCount: number, warehouseId = originId) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `m4test/${lotId}`,
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
          productNameZh: '转运货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 40,
          boxWidthCm: 40,
          boxHeightCm: 40,
          boxWeightKg: 7,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
  return { lotId, boxIds: rows.map((b) => b.id), shortCodes: rows.map((b) => b.shortCode) };
}

function scan(batchId: string, code: string, extra: Record<string, unknown> = {}) {
  return {
    clientEventUuid: uuidv4(),
    batchId,
    code,
    method: 'qr' as const,
    scannedAt: new Date().toISOString(),
    ...extra,
  };
}

/** Full M3 path: plan → approve → load all → depart. Returns the batch. */
async function departedBatch(planCount: number, lot: Awaited<ReturnType<typeof makeLot>>) {
  const sub = await submitPlan(
    { originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId: lot.lotId, boxCount: planCount }] },
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
  for (const code of lot.shortCodes.slice(0, planCount)) {
    const [ack] = await ingestLoadScans([{ ...scan(batch!.id, code), addedOnSpot: false }], ctx());
    expect(ack!.result).toBe('ok');
  }
  await departBatch(batch!.id, ctx());
  return batch!;
}

beforeAll(async () => {
  async function ensureWarehouse(code: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `M4 ${code}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
      .returning();
    return wh!.id;
  }
  originId = await ensureWarehouse(WH_O);
  destId = await ensureWarehouse(WH_D);
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const suffix = String(Date.now()).slice(-6);
  const [c] = await db.insert(clients).values({ clientCode: `M4${suffix}`, name: 'M4 client' }).returning();
  clientId = c!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('unload reconciliation', () => {
  it('manifest scan lands in stock at destination; replay idempotent; duplicate soft', async () => {
    const lot = await makeLot(2);
    const batch = await departedBatch(2, lot);

    const first = scan(batch.id, lot.shortCodes[0]!);
    let [ack] = await ingestUnloadScans([first], ctx());
    expect(ack!.result).toBe('ok');
    [ack] = await ingestUnloadScans([first], ctx());
    expect(ack!.detail).toBe('replay');
    [ack] = await ingestUnloadScans([scan(batch.id, lot.shortCodes[0]!)], ctx());
    expect(ack!.result).toBe('duplicate');

    const row = (await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[0]!)))[0]!;
    expect(row.status).toBe('in_stock');
    expect(row.currentWarehouseId).toBe(destId);
    expect(row.currentBatchId).toBeNull();

    // Batch flipped to arrived on first scan
    expect(
      (await db.query.batches.findFirst({ where: eq(batches.id, batch.id) }))?.status,
    ).toBe('arrived');

    // Second box unscanned → finish flags missing_in_transit
    const summary = await finishUnload(batch.id, ctx());
    expect(summary.missing).toEqual([lot.shortCodes[1]!]);
    const missingRow = (await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[1]!)))[0]!;
    expect(missingRow.status).toBe('in_transit');
    expect(missingRow.flags).toContain('missing_in_transit');

    // Resolve: found at origin → back to origin stock
    await resolveMissing({ boxId: lot.boxIds[1]!, resolution: 'found_at_origin' }, ctx());
    const resolved = (await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[1]!)))[0]!;
    expect(resolved.status).toBe('in_stock');
    expect(resolved.currentWarehouseId).toBe(originId);
    expect(resolved.flags).toEqual([]);

    const closed = await closeBatch(batch.id, ctx());
    expect(closed.status).toBe('closed');
  });

  it('edge case 4: known box not on manifest is auto-transferred here, flagged', async () => {
    const lot = await makeLot(1);
    const batch = await departedBatch(1, lot);
    // A rogue box that officially sits at the ORIGIN warehouse in stock
    const rogue = await makeLot(1);

    const [ack] = await ingestUnloadScans([scan(batch.id, rogue.shortCodes[0]!)], ctx());
    expect(ack!.result).toBe('auto_transfer');

    const row = (await db.select().from(boxes).where(eq(boxes.id, rogue.boxIds[0]!)))[0]!;
    expect(row.status).toBe('in_stock');
    expect(row.currentWarehouseId).toBe(destId);
    expect(row.flags).toContain('undocumented_transfer');

    // Unknown code
    const [unknown] = await ingestUnloadScans([scan(batch.id, 'ZZ99-999999')], ctx());
    expect(unknown!.result).toBe('unknown_code');
  });
});
