import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { stockWarehouseOptions } from '@/modules/wms/inventory/service';

/**
 * The stock screen's warehouse picker (owner: «skladni ostatkka ko'radigan
 * payit inactive bo'lib turgan skladlar ham skladlar spiskasida turib
 * qolyabti»).
 *
 * Three deactivated warehouses: one empty (must leave the list), one still
 * holding a carton (must stay — deactivating moves no cargo, and the picker
 * is the only filter that finds it), and one whose ONLY carton was handed
 * over (an issued box is not on a shelf — it must leave too, or the rule
 * reads «ever held cargo» instead of «holds cargo»).
 */

const SUFFIX = String(Date.now()).slice(-6);
let actorId: string;
let whActive: string;
let whEmpty: string;
let whHolding: string;
let whIssued: string;
let clientId: string;
const madeBoxes: string[] = [];

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  const mint = async (code: string, active: boolean) =>
    (
      await db
        .insert(warehouses)
        .values({
          code,
          batchPrefix: code,
          name: `Ostatka sklad ${code}`,
          type: 'origin',
          country: 'CN',
          timezone: 'Asia/Shanghai',
          active,
        })
        .returning({ id: warehouses.id })
    )[0]!.id;
  whActive = await mint(`SA${SUFFIX}`, true);
  whEmpty = await mint(`SE${SUFFIX}`, false);
  whHolding = await mint(`SH${SUFFIX}`, false);
  whIssued = await mint(`SI${SUFFIX}`, false);

  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `SW${SUFFIX}`, name: `Ostatka mijoz ${SUFFIX}` })
      .returning({ id: clients.id })
  )[0]!.id;
  const receiptId = (
    await db
      .insert(receipts)
      .values({ warehouseId: whActive, clientId, status: 'confirmed', createdBy: actorId })
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
        totalVolumeM3: '1',
      })
      .returning({ id: receiptLots.id })
  )[0]!.id;
  const rows = await db
    .insert(boxes)
    .values([
      {
        lotId,
        shortCode: `SWB${SUFFIX}1`,
        seqInLot: 1,
        currentWarehouseId: whHolding,
        status: 'in_stock',
      },
      {
        lotId,
        shortCode: `SWB${SUFFIX}2`,
        seqInLot: 2,
        currentWarehouseId: whIssued,
        status: 'issued',
      },
    ] as (typeof boxes.$inferInsert)[])
    .returning({ id: boxes.id });
  madeBoxes.push(...rows.map((row) => row.id));
});

afterAll(async () => {
  await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  const lots = await db
    .select({ id: receiptLots.id, receiptId: receiptLots.receiptId })
    .from(receiptLots)
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(eq(receipts.clientId, clientId));
  if (lots.length) {
    await db.delete(receiptLots).where(
      inArray(
        receiptLots.id,
        lots.map((l) => l.id),
      ),
    );
    await db.delete(receipts).where(
      inArray(
        receipts.id,
        lots.map((l) => l.receiptId),
      ),
    );
  }
  await db.delete(clients).where(eq(clients.id, clientId));
  await db
    .delete(warehouses)
    .where(inArray(warehouses.id, [whActive, whEmpty, whHolding, whIssued]));
  await pgClient.end();
});

describe('stockWarehouseOptions', () => {
  it('drops a deactivated warehouse and keeps one that still holds cargo, marked', async () => {
    const options = await stockWarehouseOptions();
    const byId = new Map(options.map((option) => [option.id, option]));

    expect(byId.get(whActive)?.active).toBe(true);
    expect(byId.has(whEmpty)).toBe(false);
    expect(byId.get(whHolding)).toMatchObject({ active: false });
    // «Holds cargo», not «ever held cargo»: the handed-over carton is gone.
    expect(byId.has(whIssued)).toBe(false);
  });

  it('keeps the warehouse the address names, and ignores a value that is not an id', async () => {
    expect((await stockWarehouseOptions(whEmpty)).some((o) => o.id === whEmpty)).toBe(true);
    // A hand-typed `?wh=` must not become a 22P02 on the page (#514).
    await expect(stockWarehouseOptions('YW')).resolves.toBeInstanceOf(Array);
  });
});
