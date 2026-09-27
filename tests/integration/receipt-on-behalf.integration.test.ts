import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  boxMovements,
  boxes,
  clientNotices,
  clients,
  receiptLots,
  receipts,
  userWarehouses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { addDays, dayIn, noonIn } from '@/modules/platform/time/tashkent';
import { confirmReceipt, ReceiptError } from '@/modules/wms/receipts/service';
import { EditError, setReceiptReceived } from '@/modules/wms/receipts/edit';
import { receivedFacts } from '@/modules/wms/notices/client-summary';
import { cargoOverview } from '@/modules/wms/client-cabinet/service';

/**
 * The office receipt (0112, the owner's Q9 b), through the real service: the
 * logist types a prixod from the floor's photos, names who physically took
 * the cartons in and the day they came. Its own warehouse (in YIWU's zone, so
 * «today» is the warehouse's and not Tashkent's), its own people; audited
 * rows point at them, so they are DEACTIVATED at the end, never deleted.
 */

const S = String(Date.now()).slice(-7);
const TZ = 'Asia/Shanghai';
let whId = '';
let otherWhId = '';
let clientId = '';
const U = { office: '', operator: '', stranger: '', gone: '' };
const madeReceipts: string[] = [];

async function mintUser(tag: string, active = true) {
  const [row] = await db
    .insert(users)
    .values({ phone: `+99877${S}${tag}`, fullName: `Ofis ${tag} ${S}`, passwordHash: 'x', active })
    .returning({ id: users.id });
  return row!.id;
}

function actorOf(id: string, permissions: string[]): Actor {
  return {
    id,
    fullName: `Ofis ${S}`,
    roles: [],
    permissions: new Set(permissions),
    warehouseScoped: false,
    warehouseIds: [],
  } as unknown as Actor;
}

/** A one-lot prixod as the wizard posts it; the photo row is the confirm gate's. */
async function input(extra: Record<string, unknown> = {}, lot: Record<string, unknown> = {}) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `ofis/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: U.office,
  });
  madeReceipts.push(receiptId);
  return {
    receiptId,
    warehouseId: whId,
    clientId,
    dealId: null,
    unclaimedMarking: '',
    lots: [
      {
        id: lotId,
        productNameZh: '办公室收货',
        boxCount: 2,
        dimsMode: 'uniform' as const,
        boxLengthCm: 40,
        boxWidthCm: 30,
        boxHeightCm: 20,
        boxWeightKg: 5,
        ...lot,
      },
    ],
    extraCosts: [],
    ...extra,
  };
}

const ctx = () => ({ actorId: U.office });
const today = () => dayIn(new Date(), TZ);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no refusal';
  } catch (err) {
    if (err instanceof ReceiptError || err instanceof EditError) return err.code;
    throw err;
  }
}

beforeAll(async () => {
  const [wh] = await db
    .insert(warehouses)
    .values({ code: `OF${S}`, batchPrefix: `OF${S}`, name: `Ofis ${S}`, country: 'CN', type: 'origin', timezone: TZ })
    .returning({ id: warehouses.id });
  whId = wh!.id;
  const [other] = await db
    .insert(warehouses)
    .values({ code: `OG${S}`, batchPrefix: `OG${S}`, name: `Ofis2 ${S}`, country: 'CN', type: 'origin', timezone: TZ })
    .returning({ id: warehouses.id });
  otherWhId = other!.id;
  U.office = await mintUser('1');
  U.operator = await mintUser('2');
  U.stranger = await mintUser('3');
  U.gone = await mintUser('4', false);
  await db.insert(userWarehouses).values([
    { userId: U.operator, warehouseId: whId },
    { userId: U.gone, warehouseId: whId },
    { userId: U.stranger, warehouseId: otherWhId },
  ]);
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `OF${S}`, name: `Ofis mijoz ${S}` })
    .returning({ id: clients.id });
  clientId = client!.id;
});

afterAll(async () => {
  // The «qabul qilindi» claims the notice drain would otherwise read.
  if (clientId) await db.delete(clientNotices).where(eq(clientNotices.clientId, clientId));
  await db.update(users).set({ active: false }).where(inArray(users.id, Object.values(U).filter(Boolean)));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whId, otherWhId].filter(Boolean)));
  await pgClient.end();
});

describe('the office receipt', () => {
  it('files the real day at the warehouse noon and names who received it; the number keeps the entry day', async () => {
    const day = addDays(today(), -3);
    const posted = await input({ receivedDay: day, receivedBy: { userId: U.operator } });
    const before = Date.now();
    const result = await confirmReceipt(posted as never, ctx(), { onBehalf: true });
    const [row] = await db.select().from(receipts).where(eq(receipts.id, result.receiptId));
    expect(row!.receivedAt.toISOString()).toBe(noonIn(day, TZ).toISOString());
    expect(Math.abs(row!.createdAt.getTime() - before)).toBeLessThan(60_000);
    expect(row!.receivedByUserId).toBe(U.operator);
    expect(row!.receivedByName).toBeNull();
    // The number is printed on cartons: it carries the day it was TYPED.
    expect(result.number).toContain(`-IN-${today().slice(2).replaceAll('-', '')}-`);
    // …and so does the movement, which money timestamps are compared with.
    const [move] = await db
      .select({ at: boxMovements.createdAt })
      .from(boxMovements)
      .where(and(eq(boxMovements.refId, result.receiptId), eq(boxMovements.cause, 'receipt')))
      .limit(1);
    expect(Math.abs(move!.at.getTime() - before)).toBeLessThan(60_000);
    // The audit carries what the office said.
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, result.receiptId), eq(auditLog.action, 'create')));
    expect(audit!.after).toMatchObject({ receivedByUserId: U.operator, receivedAt: noonIn(day, TZ).toISOString() });
  });

  it('keeps the column default on the entry day, so the prixod is not back-dated', async () => {
    const posted = await input({ receivedDay: today(), receivedBy: { userId: U.office } });
    const result = await confirmReceipt(posted as never, ctx(), { onBehalf: true });
    const [row] = await db.select().from(receipts).where(eq(receipts.id, result.receiptId));
    expect(row!.receivedAt.getTime()).toBe(row!.createdAt.getTime());
    // «Men o'zim» is the office person — assigned to no warehouse, still allowed.
    expect(row!.receivedByUserId).toBe(U.office);
  });

  it('refuses the two fields unless the action said the actor may enter on the floor’s behalf', async () => {
    expect(await refusal(confirmReceipt((await input({ receivedBy: { userId: U.operator } })) as never, ctx()))).toBe(
      'on_behalf_forbidden',
    );
    expect(await refusal(confirmReceipt((await input({ receivedDay: today() })) as never, ctx()))).toBe(
      'on_behalf_forbidden',
    );
  });

  it('requires the receiver on an office entry', async () => {
    expect(await refusal(confirmReceipt((await input()) as never, ctx(), { onBehalf: true }))).toBe('receiver_required');
  });

  it('refuses a receiver who is not this warehouse’s, or who is gone', async () => {
    for (const userId of [U.stranger, U.gone, uuidv4()]) {
      expect(
        await refusal(confirmReceipt((await input({ receivedBy: { userId } })) as never, ctx(), { onBehalf: true })),
      ).toBe('receiver_invalid');
    }
  });

  it('refuses a day outside [entry − 7, entry] in words', async () => {
    const cases: [string, string][] = [
      [addDays(today(), -8), 'received_too_old'],
      [addDays(today(), 1), 'received_in_future'],
      ['2026-02-30', 'received_day_invalid'],
    ];
    for (const [receivedDay, code] of cases) {
      const posted = await input({ receivedDay, receivedBy: { userId: U.operator } });
      expect(await refusal(confirmReceipt(posted as never, ctx(), { onBehalf: true }))).toBe(code);
    }
    // Entry − 7 is still allowed.
    const edge = await input({ receivedDay: addDays(today(), -7), receivedBy: { name: 'Haydovchi Ali' } });
    const result = await confirmReceipt(edge as never, ctx(), { onBehalf: true });
    expect(result.number).toBeTruthy();
  });

  it('stores a typed name, and the table refuses both columns at once', async () => {
    const posted = await input({ receivedBy: { name: '  Zavod yukchisi Wang  ' } });
    const result = await confirmReceipt(posted as never, ctx(), { onBehalf: true });
    const [row] = await db.select().from(receipts).where(eq(receipts.id, result.receiptId));
    expect(row!.receivedByName).toBe('Zavod yukchisi Wang');
    expect(row!.receivedByUserId).toBeNull();
    const both = await db
      .update(receipts)
      .set({ receivedByUserId: U.operator })
      .where(eq(receipts.id, result.receiptId))
      .then(() => 'written')
      .catch((err: { code?: string; cause?: { code?: string } }) => err.cause?.code ?? err.code);
    expect(both).toBe('23514');
  });

  it('tells the customer and the cabinet the REAL day', async () => {
    const day = addDays(today(), -2);
    const posted = await input({ receivedDay: day, receivedBy: { userId: U.operator } });
    const result = await confirmReceipt(posted as never, ctx(), { onBehalf: true });
    const [row] = await db.select().from(receipts).where(eq(receipts.id, result.receiptId));
    // Make «confirmed» differ from «received», as it does for every office entry.
    expect(row!.confirmedAt!.getTime()).not.toBe(row!.receivedAt.getTime());

    const facts = await receivedFacts(clientId, result.receiptId);
    expect('summary' in facts).toBe(true);
    if ('summary' in facts) {
      expect(new Date(facts.summary.receivedAt!).toISOString()).toBe(row!.receivedAt.toISOString());
    }

    const lots = await cargoOverview(clientId);
    const lot = lots.find((l) => l.lotId === posted.lots[0]!.id);
    expect(lot, 'the lot is in the cabinet').toBeTruthy();
    const received = lot!.journey.find((step) => step.key === 'received');
    expect(received && dayIn(new Date(received.atIso), TZ)).toBe(day);
  });
});

describe('the correction door', () => {
  async function officeReceipt(day: string) {
    const posted = await input({ receivedDay: day, receivedBy: { userId: U.operator } });
    return (await confirmReceipt(posted as never, ctx(), { onBehalf: true })).receiptId;
  }
  const updates = async (receiptId: string) =>
    (
      await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, receiptId), eq(auditLog.action, 'update')))
    ).length;

  it('corrects the day and the receiver on the entry day with one audit row, and nothing when nothing changed', async () => {
    const receiptId = await officeReceipt(addDays(today(), -3));
    const office = actorOf(U.office, ['plans.manage']);
    const day = addDays(today(), -1);
    await setReceiptReceived({ receiptId, receivedDay: day, receivedBy: { name: 'Haydovchi Bobur' } }, office, ctx());
    const [row] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(row!.receivedAt.toISOString()).toBe(noonIn(day, TZ).toISOString());
    expect(row!.receivedByName).toBe('Haydovchi Bobur');
    expect(row!.receivedByUserId).toBeNull();
    expect(await updates(receiptId)).toBe(1);
    // The same answer again writes nothing.
    const again = await setReceiptReceived(
      { receiptId, receivedDay: day, receivedBy: { name: 'Haydovchi Bobur' } },
      office,
      ctx(),
    );
    expect(again.changed).toBe(false);
    expect(await updates(receiptId)).toBe(1);

    // Back to the entry day: received_at = created_at again, «not back-dated».
    await setReceiptReceived({ receiptId, receivedDay: today(), receivedBy: { userId: U.operator } }, office, ctx());
    const [back] = await db.select().from(receipts).where(eq(receipts.id, receiptId));
    expect(back!.receivedAt.getTime()).toBe(back!.createdAt.getTime());
  });

  it('is the office’s alone — a receipts.edit operator is refused, the named receiver included', async () => {
    const receiptId = await officeReceipt(addDays(today(), -1));
    const operator = actorOf(U.operator, ['receipts.edit', 'receipts.create']);
    expect(
      await refusal(
        setReceiptReceived({ receiptId, receivedDay: today(), receivedBy: { userId: U.operator } }, operator, ctx()),
      ),
    ).toBe('received_locked');
  });

  it('closes after the entry day, and bounds the day from the ENTRY', async () => {
    const receiptId = await officeReceipt(today());
    const office = actorOf(U.office, ['plans.manage']);
    // Within the day: the bound is measured from created_at.
    expect(
      await refusal(
        setReceiptReceived(
          { receiptId, receivedDay: addDays(today(), -8), receivedBy: { userId: U.operator } },
          office,
          ctx(),
        ),
      ),
    ).toBe('received_too_old');
    // The next day it is locked for everybody.
    const [row] = await db.select({ createdAt: receipts.createdAt }).from(receipts).where(eq(receipts.id, receiptId));
    await db
      .update(receipts)
      .set({ createdAt: new Date(row!.createdAt.getTime() - 24 * 3600_000) })
      .where(eq(receipts.id, receiptId));
    expect(
      await refusal(
        setReceiptReceived({ receiptId, receivedDay: addDays(today(), -1), receivedBy: { userId: U.operator } }, office, ctx()),
      ),
    ).toBe('received_locked');
  });

  it('refuses a receiver from elsewhere through the same check as the receive door', async () => {
    const receiptId = await officeReceipt(today());
    const office = actorOf(U.office, ['plans.manage']);
    expect(
      await refusal(
        setReceiptReceived({ receiptId, receivedDay: today(), receivedBy: { userId: U.stranger } }, office, ctx()),
      ),
    ).toBe('receiver_invalid');
  });
});

describe('the receipt keeps its lots and boxes whatever the day', () => {
  it('mints the boxes at the receiving warehouse', async () => {
    const posted = await input({ receivedDay: addDays(today(), -4), receivedBy: { userId: U.operator } });
    await confirmReceipt(posted as never, ctx(), { onBehalf: true });
    const rows = await db
      .select({ wh: boxes.currentWarehouseId })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .where(eq(receiptLots.receiptId, posted.receiptId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.wh === whId)).toBe(true);
  });
});
