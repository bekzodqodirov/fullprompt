import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  events,
  notifications,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';

/**
 * Audit U41, the door half: when the post-commit re-split of a lot
 * correction failed (it did, measurably, on two corrections at once), the
 * rejection escaped `editLot` AFTER the correction had committed — the
 * manager read an error page over a saved fix, and the author's notice was
 * skipped. The failure is now logged and handed to the job queue as a
 * durable retry of the same re-split.
 *
 * The recompute is made to fail and the queue is stood in for, because this
 * suite never starts pg-boss; both are the modules editLot imports
 * dynamically, so the mocks are exactly what it reaches.
 */
const enqueued: { name: string; data: unknown }[] = [];
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (name: string, data: unknown) => {
    enqueued.push({ name, data });
  }),
}));
vi.mock('@/modules/wms/costing/service', async (original) => ({
  ...(await original<typeof import('@/modules/wms/costing/service')>()),
  recomputeForLot: vi.fn(async () => {
    throw new Error(
      'duplicate key value violates unique constraint "cost_allocations_entry_box_unique"',
    );
  }),
  recomputeForLots: vi.fn(async () => {
    throw new Error('deadlock detected');
  }),
}));

const { assignReceiptClient, editLot } = await import('@/modules/wms/receipts/edit');
const { JOB_RECOMPUTE_COSTS } = await import('@/modules/platform/jobs/boss');

const STAMP = String(Date.now()).slice(-6);
let managerId = '';
let authorId = '';
let whId = '';
let clientId = '';
/** Whom the client correction moves the prixod to. */
let otherClientId = '';
let receiptId = '';
let lotId = '';

beforeAll(async () => {
  const mint = async (tag: string) =>
    (
      await db
        .insert(users)
        .values({
          phone: `+99892${STAMP}${tag.length}`,
          fullName: `LR ${tag} ${STAMP}`,
          passwordHash: 'x',
          active: true,
        })
        .returning()
    )[0]!.id;
  managerId = await mint('M');
  authorId = await mint('Op');
  const [wh] = await db
    .insert(warehouses)
    .values({
      code: `LRO${STAMP}`.slice(0, 8),
      name: `LR ${STAMP}`,
      country: 'CN',
      type: 'origin',
      timezone: 'Asia/Tashkent',
      batchPrefix: `LRO${STAMP}`.slice(0, 8),
    })
    .returning();
  whId = wh!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `LR${STAMP}`, name: `LR ${STAMP}` })
    .returning();
  clientId = client!.id;
  const [other] = await db
    .insert(clients)
    .values({ clientCode: `LQ${STAMP}`, name: `LQ ${STAMP}` })
    .returning();
  otherClientId = other!.id;
  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId: whId,
      clientId,
      status: 'confirmed',
      confirmedAt: new Date(),
      createdBy: authorId,
    })
    .returning();
  receiptId = receipt!.id;
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId,
      seq: 1,
      letter: 'A',
      dimsMode: 'mixed',
      productNameZh: '测试货',
      boxCount: 2,
      totalWeightKg: '100',
      totalVolumeM3: '1.5',
    })
    .returning();
  lotId = lot!.id;
  // One box already left the shelf: the correction is a manager's over the
  // author's head, which is the case that tells the author.
  await db.insert(boxes).values([
    { lotId, shortCode: `LR${STAMP}-1`, seqInLot: 1, status: 'in_transit' },
    { lotId, shortCode: `LR${STAMP}-2`, seqInLot: 2, status: 'in_stock', currentWarehouseId: whId },
  ]);
});

afterAll(async () => {
  await db
    .delete(notifications)
    .where(
      and(eq(notifications.type, 'ReceiptMeasureCorrected'), eq(notifications.userId, authorId)),
    );
  // The client correction announced itself as a ReceiptConfirmed.
  await db.delete(events).where(eq(events.entityId, receiptId));
  await db.delete(boxes).where(eq(boxes.lotId, lotId));
  await db.delete(receiptLots).where(eq(receiptLots.id, lotId));
  await db.delete(receipts).where(eq(receipts.id, receiptId));
  await db
    .update(clients)
    .set({ active: false })
    .where(inArray(clients.id, [clientId, otherClientId].filter(Boolean)));
  await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, whId));
  await db
    .update(users)
    .set({ active: false })
    .where(inArray(users.id, [managerId, authorId]));
  await pgClient.end();
});

describe('a saved lot correction whose re-split fails', () => {
  it('still answers success, queues the re-split for a retry, and tells the author', async () => {
    const manager = {
      id: managerId,
      fullName: `LR boshliq ${STAMP}`,
      roles: ['warehouse_manager'],
      permissions: new Set(['receipts.edit', 'receipts.void']),
    } as unknown as Actor;

    await expect(
      editLot(
        {
          lotId,
          productNameZh: '测试货',
          productNameRu: '',
          boxCount: 2,
          totalWeightKg: 180,
          totalVolumeM3: 1.5,
          note: null,
        } as Parameters<typeof editLot>[0],
        manager,
        { actorId: managerId, ip: null, userAgent: null },
      ),
    ).resolves.toBeDefined();

    expect(
      Number(
        (await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, lotId) }))?.totalWeightKg,
      ),
    ).toBe(180);
    // (The author's notice queues its own send job beside it.)
    expect(enqueued.filter((j) => j.name === JOB_RECOMPUTE_COSTS)).toEqual([
      { name: JOB_RECOMPUTE_COSTS, data: { lotId } },
    ]);
    const told = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(eq(notifications.type, 'ReceiptMeasureCorrected'), eq(notifications.userId, authorId)),
      );
    expect(told).toHaveLength(1);
  });
});

describe('a saved client correction whose re-split fails', () => {
  it('stays saved and queues the same re-split — the nightly sweep cannot see a wrong stamp', async () => {
    enqueued.length = 0;
    await expect(
      assignReceiptClient(receiptId, otherClientId, {
        actorId: managerId,
        ip: null,
        userAgent: null,
      }),
    ).resolves.toBeUndefined();
    const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
    expect(receipt?.clientId).toBe(otherClientId);
    expect(enqueued.filter((j) => j.name === JOB_RECOMPUTE_COSTS)).toEqual([
      { name: JOB_RECOMPUTE_COSTS, data: { lotId } },
    ]);
  });
});
