import 'dotenv/config';
import { desc, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, boxes, clients, events, users, warehouses } from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import {
  InventoryError,
  inventorySnapshot,
  reconcileInventory,
} from '@/modules/wms/inventory/service';

/** M6 #12: stocktake — reality wins for found-here, manager gate for lost. */

let whA: string;
let whB: string;
let actorId: string;
let clientId: string;
const ctx = () => ({ actorId });

async function makeLot(boxCount: number, warehouseId: string) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `invtest/${lotId}`,
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
          productNameZh: '盘点货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 30,
          boxWidthCm: 30,
          boxHeightCm: 30,
          boxWeightKg: 5,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
  return { boxIds: rows.map((b) => b.id), shortCodes: rows.map((b) => b.shortCode) };
}

beforeAll(async () => {
  async function ensureWarehouse(code: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `INV ${code}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
      .returning();
    return wh!.id;
  }
  whA = await ensureWarehouse('INVA');
  whB = await ensureWarehouse('INVB');
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const suffix = String(Date.now()).slice(-6);
  const [c] = await db.insert(clients).values({ clientCode: `IV${suffix}`, name: 'Inv client' }).returning();
  clientId = c!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('inventory reconciliation', () => {
  it('found-here moves the box; ticked missing goes lost; event emitted', async () => {
    const atA = await makeLot(3, whA);
    const atB = await makeLot(1, whB);

    const snapshot = await inventorySnapshot(whA);
    const snapCodes = snapshot.boxes.map((b) => b.shortCode);
    for (const code of atA.shortCodes) expect(snapCodes).toContain(code);
    expect(snapCodes).not.toContain(atB.shortCodes[0]);

    // Scanned: 2 of A's boxes + B's box (physically here). A's 3rd unscanned → lost.
    const summary = await reconcileInventory(
      {
        warehouseId: whA,
        foundHereCodes: [atB.shortCodes[0]!],
        lostBoxIds: [atA.boxIds[2]!],
        scannedCount: 3,
      },
      { canMarkLost: true },
      ctx(),
    );
    expect(summary.moved).toEqual([atB.shortCodes[0]]);
    expect(summary.lost).toEqual([atA.shortCodes[2]]);

    const movedBox = (await db.select().from(boxes).where(eq(boxes.id, atB.boxIds[0]!)))[0]!;
    expect(movedBox.currentWarehouseId).toBe(whA);
    expect(movedBox.status).toBe('in_stock');

    const lostBox = (await db.select().from(boxes).where(eq(boxes.id, atA.boxIds[2]!)))[0]!;
    expect(lostBox.status).toBe('lost');
    expect(lostBox.statusReason).toBe('inventory');

    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.type, 'InventoryCompleted'))
      .orderBy(desc(events.id))
      .limit(1);
    expect(event).toBeTruthy();
    expect((event!.payload as { warehouseCode: string }).warehouseCode).toBe('INVA');
  });

  it('operators without the manager grant cannot mark lost', async () => {
    const lot = await makeLot(1, whA);
    await expect(
      reconcileInventory(
        { warehouseId: whA, foundHereCodes: [], lostBoxIds: [lot.boxIds[0]!], scannedCount: 0 },
        { canMarkLost: false },
        ctx(),
      ),
    ).rejects.toThrowError(new InventoryError('forbidden_lost'));
  });

  it('issued/void boxes never auto-move; same-warehouse scans are no-ops', async () => {
    const lot = await makeLot(1, whA);
    const summary = await reconcileInventory(
      { warehouseId: whA, foundHereCodes: [lot.shortCodes[0]!], lostBoxIds: [], scannedCount: 1 },
      { canMarkLost: true },
      ctx(),
    );
    expect(summary.moved).toEqual([]);
    expect(summary.skipped).toEqual([]);
  });
});
