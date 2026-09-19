import 'dotenv/config';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { boxes, receiptLots, receipts, users, warehouses } from '@/modules/platform/db/schema';
import { mayReadReceipt } from '@/modules/wms/receipts/read-door';

/**
 * Who may open a prixod — and the case that matters is the one the column
 * cannot answer: cargo received in Kashgar, standing in Andijan.
 *
 * Written as a behavioural test on purpose. The first version of this rule was
 * two conditions inside the page, fenced by grepping the file for the helper's
 * name — and the red proof (wrapping the call in `false &&`) stayed GREEN,
 * because the name was still there (#531, #166).
 */

const SUFFIX = String(Date.now()).slice(-6);
let whFrom: string;
let whTo: string;
let whThird: string;
let receiptId: string;
const madeBoxes: string[] = [];

const actorAt = (...ids: string[]) => ({ warehouseScoped: true, warehouseIds: ids });

beforeAll(async () => {
  const actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  const wh = (code: string, country: 'CN' | 'UZ'): typeof warehouses.$inferInsert => ({
    name: `Eshik sklad ${code}`,
    code,
    batchPrefix: code,
    country,
    type: country === 'CN' ? 'origin' : 'distribution',
    timezone: country === 'CN' ? 'Asia/Shanghai' : 'Asia/Tashkent',
  });
  whFrom = (
    await db.insert(warehouses).values(wh(`RF${SUFFIX}`, 'CN')).returning({ id: warehouses.id })
  )[0]!.id;
  whTo = (
    await db.insert(warehouses).values(wh(`RT${SUFFIX}`, 'UZ')).returning({ id: warehouses.id })
  )[0]!.id;
  whThird = (
    await db.insert(warehouses).values(wh(`RX${SUFFIX}`, 'UZ')).returning({ id: warehouses.id })
  )[0]!.id;

  receiptId = (
    await db
      .insert(receipts)
      .values({
        warehouseId: whFrom,
        unclaimedMarking: `GS${SUFFIX}NOBODY`,
        status: 'confirmed',
        createdBy: actorId,
      })
      .returning({ id: receipts.id })
  )[0]!.id;
  const lotId = (
    await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: 1,
        productNameZh: `货${SUFFIX}`,
        boxCount: 2,
        dimsMode: 'mixed',
        totalWeightKg: '20',
        totalVolumeM3: '2',
      })
      .returning({ id: receiptLots.id })
  )[0]!.id;
  const rows = await db
    .insert(boxes)
    .values([
      // The cargo has moved: received in China, standing in Uzbekistan.
      { lotId, shortCode: `RD${SUFFIX}1`, seqInLot: 1, currentWarehouseId: whTo, status: 'ready_for_pickup' },
      { lotId, shortCode: `RD${SUFFIX}2`, seqInLot: 2, currentWarehouseId: whTo, status: 'ready_for_pickup' },
    ] as (typeof boxes.$inferInsert)[])
    .returning({ id: boxes.id });
  madeBoxes.push(...rows.map((row) => row.id));
});

afterAll(async () => {
  await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  await db.delete(receiptLots).where(inArray(receiptLots.receiptId, [receiptId]));
  await db.delete(receipts).where(inArray(receipts.id, [receiptId]));
  await db.delete(warehouses).where(inArray(warehouses.id, [whFrom, whTo, whThird]));
  await pgClient.end();
});

describe('mayReadReceipt', () => {
  const receipt = () => ({ id: receiptId, warehouseId: whFrom });

  it('opens for the warehouse that RECEIVED the cargo', async () => {
    expect(await mayReadReceipt(actorAt(whFrom), receipt())).toBe(true);
  });

  it('opens for the warehouse the cargo is STANDING in now', async () => {
    // The handover list sends this person here to name the client (3.2a), and
    // they can already see the photographs on this page (round 90).
    expect(await mayReadReceipt(actorAt(whTo), receipt())).toBe(true);
  });

  it('stays shut for a warehouse the cargo has never touched', async () => {
    expect(await mayReadReceipt(actorAt(whThird), receipt())).toBe(false);
  });

  it('opens for an unscoped actor, as every other screen does', async () => {
    expect(
      await mayReadReceipt({ warehouseScoped: false, warehouseIds: [] }, receipt()),
    ).toBe(true);
  });
});
