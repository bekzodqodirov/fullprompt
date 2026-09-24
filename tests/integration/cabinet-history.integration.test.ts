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
  handovers,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { issuedHandovers, paidHistory } from '@/modules/wms/client-cabinet/service';

/**
 * F (owner, 2026-09-24): «alohida topshirilgan yuklar ko'rinib tursin —
 * qaysi partiyada kelgan, ichki tashqi sanalari, rasmlari, kim bergan …
 * klientga tan narx ko'rinmasin, faqat pul to'langandan keyin bergan puli
 * ko'rinsin».
 *
 * One lot of three boxes: all three ride Yiwu → Kashgar, then Kashgar →
 * Tashkent; two are handed over today, the third stays in stock. A handover
 * from half a year ago is outside the window, and another client's handover
 * is somebody else's business.
 */

const S = String(Date.now()).slice(-6);
const DAY = 86_400_000;
let actorId: string;
let actorName: string;
let yw: string;
let ka: string;
let tas: string;
let clientId: string;
let otherId: string;
let internal: string;
let exportLeg: string;
let receiptId: string;
let lotId: string;
const boxIds: string[] = [];
const handoverIds: string[] = [];

async function wh(code: string, country: string, name: string) {
  return (
    await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name, country, type: 'origin', timezone: 'Asia/Shanghai' })
      .returning({ id: warehouses.id })
  )[0]!.id;
}

async function batch(code: string, origin: string, dest: string, departedAt: Date) {
  const id = uuidv4();
  await db.insert(batches).values({
    id,
    code,
    originWarehouseId: origin,
    destWarehouseId: dest,
    status: 'arrived',
    departedAt,
    createdBy: actorId,
  });
  return id;
}

async function move(boxId: string, cause: string, refType: string, refId: string, at: Date, from: string | null, to: string | null, toStatus: string) {
  await db.insert(boxMovements).values({
    boxId,
    fromWarehouseId: from,
    toWarehouseId: to,
    fromStatus: 'in_stock',
    toStatus,
    cause,
    refType,
    refId,
    actorId,
    createdAt: at,
  });
}

async function handover(forClient: string, at: Date, issued: string[]) {
  const [row] = await db
    .insert(handovers)
    .values({
      clientId: forClient,
      warehouseId: tas,
      kind: 'issued_to_client',
      personName: `Oluvchi ${S}`,
      personPhone: '+998900000000',
      note: `ICHKI IZOH ${S}`,
      createdBy: actorId,
      createdAt: at,
    })
    .returning();
  handoverIds.push(row!.id);
  for (const boxId of issued) await move(boxId, 'issued', 'handover', row!.id, at, tas, tas, 'issued');
  return row!.id;
}

beforeAll(async () => {
  const [actor] = await db.select().from(users).where(eq(users.active, true)).limit(1);
  actorId = actor!.id;
  actorName = actor!.fullName;
  yw = await wh(`HY${S}`, 'CN', `Yiwu ${S}`);
  ka = await wh(`HK${S}`, 'CN', `Kashgar ${S}`);
  tas = await wh(`HT${S}`, 'UZ', `Toshkent ${S}`);
  clientId = (
    await db.insert(clients).values({ clientCode: `HC${S}`, name: `Tarix ${S}` }).returning()
  )[0]!.id;
  otherId = (
    await db.insert(clients).values({ clientCode: `HO${S}`, name: `Boshqa ${S}` }).returning()
  )[0]!.id;
  const now = Date.now();
  internal = await batch(`HY${S}-001`, yw, ka, new Date(now - 20 * DAY));
  exportLeg = await batch(`HK${S}-001`, ka, tas, new Date(now - 12 * DAY));
  receiptId = (
    await db
      .insert(receipts)
      .values({ warehouseId: yw, clientId, status: 'confirmed', createdBy: actorId, receivedAt: new Date(now - 25 * DAY) })
      .returning()
  )[0]!.id;
  lotId = (
    await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: 1,
        letter: 'A',
        productNameZh: `玩具${S}`,
        productNameRu: `Oyinchoq ${S}`,
        boxCount: 3,
        dimsMode: 'mixed',
        totalWeightKg: '30',
        totalVolumeM3: '0.3',
      })
      .returning()
  )[0]!.id;
  for (let i = 1; i <= 3; i += 1) {
    const [box] = await db
      .insert(boxes)
      .values({ lotId, shortCode: `HB${S}${i}`, seqInLot: i, currentWarehouseId: tas, status: i < 3 ? 'issued' : 'ready_for_pickup' })
      .returning();
    boxIds.push(box!.id);
    await move(box!.id, 'batch_departed', 'batch', internal, new Date(now - 20 * DAY), yw, ka, 'in_transit');
    await move(box!.id, 'unload_scan', 'batch', internal, new Date(now - 14 * DAY), yw, ka, 'in_stock');
    await move(box!.id, 'batch_departed', 'batch', exportLeg, new Date(now - 12 * DAY), ka, tas, 'in_transit');
    await move(box!.id, 'unload_scan', 'batch', exportLeg, new Date(now - 5 * DAY), ka, tas, 'ready_for_pickup');
  }
  await handover(clientId, new Date(now - DAY), boxIds.slice(0, 2));
  // Half a year ago: outside the three months.
  await handover(clientId, new Date(now - 180 * DAY), []);
  // Somebody else's.
  await handover(otherId, new Date(now - DAY), []);

  await db.insert(clientTransactions).values([
    { clientId, type: 'charge', amount: '500', currency: 'USD', rateToUsd: '1', amountUsd: '500', txDate: new Date(now - 3 * DAY).toISOString().slice(0, 10), createdBy: actorId, note: 'NARX IZOH' },
    { clientId, type: 'payment', amount: '300', currency: 'USD', rateToUsd: '1', amountUsd: '300', txDate: new Date(now - 2 * DAY).toISOString().slice(0, 10), createdBy: actorId, method: 'cash' },
    { clientId, type: 'payment', amount: '99', currency: 'USD', rateToUsd: '1', amountUsd: '99', txDate: new Date(now - 200 * DAY).toISOString().slice(0, 10), createdBy: actorId, method: 'cash' },
  ]);
});

afterAll(async () => {
  await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, [clientId, otherId]));
  await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
  await db.delete(handovers).where(inArray(handovers.id, handoverIds));
  await db.delete(boxes).where(inArray(boxes.id, boxIds));
  await db.delete(receiptLots).where(eq(receiptLots.id, lotId));
  await db.delete(receipts).where(eq(receipts.id, receiptId));
  await db.delete(batches).where(inArray(batches.id, [internal, exportLeg]));
  await db.delete(clients).where(inArray(clients.id, [clientId, otherId]));
  await db.delete(warehouses).where(inArray(warehouses.id, [yw, ka, tas]));
  await pgClient.end();
});

describe('the client history of handed-over cargo (F)', () => {
  it('one entry per handover in the last three months, its own boxes only', async () => {
    const history = await issuedHandovers(clientId);
    expect(history).toHaveLength(1);
    const [h] = history;
    expect(h!.receiver).toBe(`Oluvchi ${S}`);
    expect(h!.issuedBy).toBe(actorName);
    expect(h!.place).toBe(`Toshkent ${S}`);
    // Two of the three boxes — the third is still in the warehouse.
    expect(h!.lots).toEqual([
      expect.objectContaining({ lotId, letter: 'A', n: 2, weightKg: 20, volumeM3: 0.2 }),
    ]);
  });

  it('names both trucks, the domestic leg and the international one, with their dates', async () => {
    const [h] = await issuedHandovers(clientId);
    expect(h!.legs.map((l) => [l.batchCode, l.domestic, l.n])).toEqual([
      [`HY${S}-001`, true, 2],
      [`HK${S}-001`, false, 2],
    ]);
    for (const leg of h!.legs) {
      expect(leg.departedAt).not.toBeNull();
      expect(leg.arrivedAt).not.toBeNull();
      expect(new Date(leg.arrivedAt!).getTime()).toBeGreaterThan(new Date(leg.departedAt!).getTime());
    }
  });

  it('carries nothing the company keeps to itself', async () => {
    const text = JSON.stringify(await issuedHandovers(clientId));
    expect(text).not.toContain('ICHKI IZOH'); // the handover's staff note
    expect(text).not.toContain('+998900000000'); // the receiver's phone
    expect(text).not.toMatch(/debtOk|costUsd|landed|margin|plate|driver/i);
  });

  it('shows only the money the client PAID, in the same window', async () => {
    const paid = await paidHistory(clientId);
    expect(paid).toEqual([expect.objectContaining({ amount: 300, currency: 'USD' })]);
    expect(JSON.stringify(paid)).not.toContain('NARX IZOH');
  });

  it("another client's handover is not in this history", async () => {
    expect(await issuedHandovers(otherId)).toHaveLength(1);
    const mine = await issuedHandovers(clientId);
    expect(mine.every((h) => !handoverIds.slice(2).includes(h.id))).toBe(true);
  });
});
