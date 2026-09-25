import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxes,
  boxMovements,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { addCostEntry } from '@/modules/wms/costing/service';
import { lossesInPeriod } from '@/modules/wms/reports/business';
import { buildPnlXlsx } from '@/modules/wms/accounting/xlsx';

/**
 * Owner 6a: «yoqotishlar ham korinsin umumiy hisobotda». The P&L page and its
 * file print what was lost and what is missing, as INFORMATION — the money
 * is already inside the cargo costs, so the net must not move.
 *
 * `lossesInPeriod` is a whole-database read keyed on the day a carton was
 * marked lost (today, here), so every assertion is a DELTA against the
 * reading taken before this file's rows existed (#713); vitest runs files one
 * at a time (fileParallelism: false). The cost is parked in 1654, a year no
 * other file uses.
 */
const STAMP = String(Date.now()).slice(-6);
const COST_DAY = '1654-03-10';
let actorId = '';
let clientId = '';
let receiptId = '';
let lotId = '';
const boxIds: string[] = [];
let costId = '';
const ctx = () => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  const [wh] = await db.select({ id: warehouses.id }).from(warehouses).limit(1);
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `PL${STAMP}`, name: 'P&L losses client' })
    .returning();
  clientId = client!.id;
  const [receipt] = await db
    .insert(receipts)
    .values({ warehouseId: wh!.id, clientId, status: 'confirmed', confirmedAt: new Date(), createdBy: actorId })
    .returning();
  receiptId = receipt!.id;
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId,
      seq: 1,
      letter: 'A',
      dimsMode: 'mixed',
      productNameZh: '损失测试',
      boxCount: 2,
      totalWeightKg: '20',
      totalVolumeM3: '0.4',
    })
    .returning();
  lotId = lot!.id;
  const rows = await db
    .insert(boxes)
    .values([1, 2].map((seq) => ({
      lotId,
      shortCode: `PL${STAMP}-${seq}`,
      seqInLot: seq,
      status: 'in_stock',
      currentWarehouseId: wh!.id,
    })))
    .returning();
  boxIds.push(...rows.map((row) => row.id));
});

afterAll(async () => {
  try {
    // Deleted, not voided: a voided entry keeps its row, which names the
    // receipt, and the receipt is this file's own fixture.
    if (costId) {
      await db.delete(costAllocations).where(eq(costAllocations.costEntryId, costId));
      await db.delete(costEntries).where(eq(costEntries.id, costId));
    }
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
    await db.delete(boxes).where(inArray(boxes.id, boxIds));
    await db.delete(receiptLots).where(eq(receiptLots.id, lotId));
    await db.delete(receipts).where(eq(receipts.id, receiptId));
    await db.delete(clients).where(eq(clients.id, clientId));
  } finally {
    await pgClient.end();
  }
});

describe('owner 6a — losses beside the P&L, never inside it', () => {
  it('a carton marked lost today and one missing on the road are counted with the money spent on them, and the file says the same', async () => {
    const today = tashkentDay();
    const before = await lossesInPeriod(today, today);

    const [type] = await db.select().from(costTypes).where(eq(costTypes.active, true)).limit(1);
    const entry = await addCostEntry(
      {
        scope: 'receipt',
        receiptId,
        costTypeId: type!.id,
        amount: 80,
        currency: 'USD',
        costDate: COST_DAY,
        allocationBasis: 'boxes',
      },
      ctx(),
    );
    costId = entry.id;
    const [stored] = await db.select().from(costEntries).where(eq(costEntries.id, costId));
    expect(Number(stored!.amountUsd)).toBe(80);

    // One carton written off as lost (the movement is what dates it), one
    // flagged missing after a truck arrived without it.
    const [lostBox, missingBox] = boxIds;
    await db.update(boxes).set({ status: 'lost' }).where(eq(boxes.id, lostBox!));
    await db.insert(boxMovements).values({
      boxId: lostBox!,
      fromStatus: 'in_stock',
      toStatus: 'lost',
      cause: 'marked_lost',
      actorId,
    });
    await db
      .update(boxes)
      .set({ flags: ['missing_in_transit'] })
      .where(eq(boxes.id, missingBox!));

    const after = await lossesInPeriod(today, today);
    expect(after.lost.boxes - before.lost.boxes).toBe(1);
    expect(Math.round((after.lost.m3 - before.lost.m3) * 1000) / 1000).toBe(0.2);
    expect(Math.round((after.lost.usd - before.lost.usd) * 100) / 100).toBe(40);
    expect(after.missing.boxes - before.missing.boxes).toBe(1);
    expect(Math.round((after.missing.usd - before.missing.usd) * 100) / 100).toBe(40);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await buildPnlXlsx(today, today, 'uz')) as unknown as ArrayBuffer);
    const cells: string[] = [];
    workbook.worksheets[0]!.eachRow((row) => cells.push(String(row.getCell(1).value ?? '')));
    const lostLine = cells.find((cell) => cell.startsWith('❌ Davrda yo‘qolgan'));
    const missingLine = cells.find((cell) => cell.startsWith('⚠ Yo‘lda qolgan'));
    expect(lostLine).toContain(`: ${after.lost.boxes} · `);
    expect(missingLine).toContain(`: ${after.missing.boxes} · `);
    expect(cells).toContain('Bu pul yuqoridagi yuk xarajatlari ichida bor — foydadan qayta ayrilmaydi.');
    // The rate line reads the way a person quotes it (the stored rate is
    // dollars per ONE so'm, and the file used to print it raw). The demo
    // seed carries UZS 0.00008 from 2026-07-01, so the line is always there.
    const rateLine = cells.find((cell) => cell.startsWith('UZS bugungi kurs'));
    expect(rateLine).toMatch(/: 1 \$ = \d{3,} UZS$/);
  });
});
