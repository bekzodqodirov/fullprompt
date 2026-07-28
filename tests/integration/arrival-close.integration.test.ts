import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  clients,
  expectedArrivals,
  notifications,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  arrivalMismatch,
  createExpectedArrival,
} from '@/modules/wms/arrivals/service';
import { confirmReceipt } from '@/modules/wms/receipts/service';

/**
 * «Qabul qilish» on a promise closes THAT promise, and its author hears
 * about a difference (owner, 2026-07-28: item 9 — "qabul qilgandan keyin
 * yana kutilayotgan yukga qaytib qabul qilindini bosishi kerak bo'lyapti,
 * bu juda noqulay" + "kubi va kilosida farq bo'lsa ham xabar kelsin").
 *
 * What only a real database can prove: the exact-id close inside the receipt
 * transaction, its refusal across warehouses, and who ends up in the
 * notifications table — including that the receiver is never told about
 * their own receipt.
 */

const STAMP = Date.now();

let whId: string;
let otherWhId: string;
let authorId: string; // the manager who wrote the promise
let receiverId: string; // the operator who confirms the receipt
let clientId: string;

async function ensureWarehouse(code: string): Promise<string> {
  const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
  if (existing) return existing.id;
  const [wh] = await db
    .insert(warehouses)
    .values({ code, name: `AC ${code}`, country: 'UZ', type: 'origin', timezone: 'Asia/Tashkent', batchPrefix: code })
    .returning();
  return wh!.id;
}

/** A confirmable receipt: one mixed lot with a photo already attached. */
async function receive(input: {
  boxes: number;
  kg: number;
  m3: number;
  arrivalId: string | null;
}) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `actest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: receiverId,
  });
  return confirmReceipt(
    {
      receiptId,
      warehouseId: whId,
      clientId,
      unclaimedMarking: '',
      expectedArrivalId: input.arrivalId,
      lots: [
        {
          id: lotId,
          productNameZh: '测试货',
          boxCount: input.boxes,
          dimsMode: 'mixed',
          totalWeightKg: input.kg,
          totalVolumeM3: input.m3,
        },
      ],
      extraCosts: [],
    },
    { actorId: receiverId, ip: null, userAgent: null },
  );
}

beforeAll(async () => {
  whId = await ensureWarehouse('ACWH1');
  otherWhId = await ensureWarehouse('ACWH2');
  const staff = await db.select().from(users).where(eq(users.active, true)).limit(2);
  authorId = staff[0]!.id;
  receiverId = (staff[1] ?? staff[0])!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AC${STAMP}`.slice(0, 12), name: `Arrival ${STAMP}`, phones: [] })
    .returning({ id: clients.id });
  clientId = c!.id;
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.type, 'ArrivalDiff'));
  await db.delete(expectedArrivals).where(eq(expectedArrivals.clientId, clientId));
  // Receipts/lots/boxes stay — other suites leave theirs too, and deleting a
  // receipt would orphan movement rows. The client is deactivated instead of
  // deleted for the same reason.
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whId, otherWhId]));
  await pgClient.end();
});

describe('is the difference worth a message (pure)', () => {
  const base = { boxes: 10, kg: 100, m3: 1 };
  it('any box difference counts — boxes are counted, not estimated', () => {
    expect(arrivalMismatch(base, { boxes: 9, kg: 100, m3: 1 })).toBe(true);
    expect(arrivalMismatch(base, { boxes: 10, kg: 100, m3: 1 })).toBe(false);
  });
  it('weight and volume get 5 % of estimate-drift before anyone is told', () => {
    expect(arrivalMismatch(base, { boxes: 10, kg: 104, m3: 1 })).toBe(false);
    expect(arrivalMismatch(base, { boxes: 10, kg: 110, m3: 1 })).toBe(true);
    expect(arrivalMismatch(base, { boxes: 10, kg: 100, m3: 1.2 })).toBe(true);
  });
  it('a promise that never stated a number cannot mismatch on it', () => {
    expect(arrivalMismatch({ boxes: null, kg: null, m3: null }, { boxes: 5, kg: 1, m3: 9 })).toBe(false);
  });
});

describe('the tapped promise closes itself, and the author hears of the gap', () => {
  it('closes exactly that promise and notifies on a short delivery', async () => {
    const promise = await createExpectedArrival(
      { warehouseId: whId, clientId, weightKg: 100, volumeM3: 1, boxCount: 3 },
      { actorId: authorId, ip: null, userAgent: null },
    );
    const result = await receive({ boxes: 2, kg: 80, m3: 1, arrivalId: promise.id });

    const closed = await db.query.expectedArrivals.findFirst({
      where: eq(expectedArrivals.id, promise.id),
    });
    expect(closed!.status).toBe('arrived');
    expect(closed!.receiptId).toBe(result.receiptId);

    // The author is told; the receiver — the actor — is not.
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'ArrivalDiff'));
    const mine = rows.filter((r) =>
      (r.payload as { text?: string })?.text?.includes(result.number),
    );
    expect(mine.map((r) => r.userId)).toEqual([authorId]);
    expect((mine[0]!.payload as { text: string }).text).toContain(`AC${STAMP}`.slice(0, 12));
  });

  it('a delivery matching the promise closes it silently', async () => {
    const promise = await createExpectedArrival(
      { warehouseId: whId, clientId, weightKg: 100, volumeM3: 1, boxCount: 2 },
      { actorId: authorId, ip: null, userAgent: null },
    );
    const result = await receive({ boxes: 2, kg: 102, m3: 1.01, arrivalId: promise.id });

    const closed = await db.query.expectedArrivals.findFirst({
      where: eq(expectedArrivals.id, promise.id),
    });
    expect(closed!.status).toBe('arrived');
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'ArrivalDiff'));
    expect(
      rows.filter((r) => (r.payload as { text?: string })?.text?.includes(result.number)),
    ).toHaveLength(0);
  });

  it('refuses a promise that belongs to another warehouse', async () => {
    // A stale tab, a forwarded link — the id arrives but the promise is not
    // this warehouse's to close. The receipt itself must still go through.
    const foreign = await createExpectedArrival(
      { warehouseId: otherWhId, clientId, boxCount: 5 },
      { actorId: authorId, ip: null, userAgent: null },
    );
    const result = await receive({ boxes: 5, kg: 10, m3: 0.1, arrivalId: foreign.id });
    expect(result.receiptId).toBeTruthy();
    const untouched = await db.query.expectedArrivals.findFirst({
      where: eq(expectedArrivals.id, foreign.id),
    });
    expect(untouched!.status).toBe('waiting');
  });
});
