import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  boxes,
  boxMovements,
  clientNotices,
  clients,
  costEntries,
  costTypes,
  deals,
  dealStages,
  events,
  notifications,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { addCostEntry } from '@/modules/wms/costing/service';
import { resolveMissing, resolveMissingSchema } from '@/modules/wms/scanning/unload';
import { setBoxStatus } from '@/modules/wms/boxes/status';
import { dealFullyIssued } from '@/modules/wms/deals/service';
import { clientFeed } from '@/modules/wms/crm/feed';
import { cargoRiskList } from '@/modules/wms/reports/business';

/**
 * Audit U38: a carton the truck arrived without had no honest end state —
 * both resolutions said «found», and every door to `lost` needs a shelf. The
 * third answer, `lost_in_transit`: lost in NO warehouse, with a written
 * reason, a movement naming the truck, no arrival notice, and the money left
 * exactly where it was (owner, 6a).
 *
 * Money parked in 1637 — a private year no other file uses.
 */
const STAMP = String(Date.now()).slice(-6);
const DAY = '1637-07-02';
let actorId = '';
let sellerId = '';
let whOrigin = '';
let whDest = '';
let whOther = '';
let clientA = '';
let clientC = '';
let dealId = '';
let batchId = '';
let batchCode = '';
let freightEntry = '';
const madeReceipts: string[] = [];
let arrivedA = '';
let missingA = '';
let missingC = '';

const ctx = () => ({ actorId, ip: null, userAgent: null });

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({
      code,
      name: `RL ${code}`,
      country,
      type,
      timezone: 'Asia/Tashkent',
      batchPrefix: code,
    })
    .returning();
  return row!.id;
}

async function mintLot(clientId: string, count: number, deal: string | null) {
  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId: whOrigin,
      clientId,
      status: 'confirmed',
      confirmedAt: new Date(),
      createdBy: actorId,
      dealId: deal,
    })
    .returning();
  madeReceipts.push(receipt!.id);
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt!.id,
      seq: 1,
      letter: 'A',
      dimsMode: 'mixed',
      productNameZh: '测试货',
      boxCount: count,
      totalWeightKg: String(10 * count),
      totalVolumeM3: String(0.1 * count),
    })
    .returning();
  const rows = await db
    .insert(boxes)
    .values(
      Array.from({ length: count }, (_, i) => ({
        lotId: lot!.id,
        shortCode: `RL${STAMP}-${madeReceipts.length}${i}`,
        seqInLot: i + 1,
        status: 'in_transit',
        currentBatchId: batchId,
      })),
    )
    .returning();
  await db.insert(boxMovements).values(
    rows.map((b) => ({
      boxId: b.id,
      fromWarehouseId: whOrigin,
      toWarehouseId: whDest,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batchId,
      actorId,
    })),
  );
  return rows.map((b) => b.id);
}

async function shares(entryId: string) {
  const rows = await db.execute<{ box_id: string; usd: string }>(sql`
    SELECT box_id, amount_usd AS usd FROM cost_allocations WHERE cost_entry_id = ${entryId}
  `);
  return new Map(rows.map((r) => [r.box_id, Number(r.usd)]));
}

beforeAll(async () => {
  const mint = async (tag: string) =>
    (
      await db
        .insert(users)
        .values({
          phone: `+99891${STAMP}${tag.length}`,
          fullName: `RL ${tag} ${STAMP}`,
          passwordHash: 'x',
          active: true,
        })
        .returning()
    )[0]!.id;
  actorId = await mint('M');
  sellerId = await mint('Sot');
  whOrigin = await mintWarehouse(`RLO${STAMP}`.slice(0, 8), 'CN', 'origin');
  whDest = await mintWarehouse(`RLD${STAMP}`.slice(0, 8), 'UZ', 'customs');
  whOther = await mintWarehouse(`RLX${STAMP}`.slice(0, 8), 'UZ', 'customs');
  const [a] = await db
    .insert(clients)
    .values({ clientCode: `LA${STAMP}`, name: `RL A ${STAMP}`, salesManagerId: sellerId })
    .returning();
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `LC${STAMP}`, name: `RL C ${STAMP}`, salesManagerId: sellerId })
    .returning();
  clientA = a!.id;
  clientC = c!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  dealId = (
    await db
      .insert(deals)
      .values({ code: `RL-${STAMP}`, clientId: clientA, stageId: stage!.id, createdBy: actorId })
      .returning({ id: deals.id })
  )[0]!.id;
  const [batch] = await db
    .insert(batches)
    .values({
      code: `RLB${STAMP}`,
      originWarehouseId: whOrigin,
      destWarehouseId: whDest,
      status: 'unloaded',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  batchId = batch!.id;
  batchCode = batch!.code;
  [arrivedA, missingA] = (await mintLot(clientA, 2, dealId)) as [string, string];
  [missingC] = (await mintLot(clientC, 1, null)) as [string];
  const freight = (await db.query.costTypes.findFirst({ where: eq(costTypes.code, 'freight') }))!
    .id;
  freightEntry = (
    await addCostEntry(
      {
        scope: 'batch',
        batchId,
        costTypeId: freight,
        amount: 300,
        currency: 'USD',
        costDate: DAY,
        allocationBasis: 'weight',
      },
      ctx(),
    )
  ).id;
  // The unload: A's first carton arrived and was handed over; the other two
  // never came off the truck, and the manager closed over them.
  await db
    .update(boxes)
    .set({ status: 'issued', currentBatchId: null, currentWarehouseId: whDest })
    .where(eq(boxes.id, arrivedA));
  await db
    .update(boxes)
    .set({ flags: ['missing_in_transit'] })
    .where(inArray(boxes.id, [missingA, missingC]));
});

afterAll(async () => {
  await db.delete(costEntries).where(eq(costEntries.id, freightEntry));
  await db.delete(clientNotices).where(eq(clientNotices.refId, batchId));
  await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.type, 'BoxLost'),
        sql`${notifications.payload}->>'text' like ${`%${STAMP}%`}`,
      ),
    );
  const lotIds = (
    await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(inArray(receiptLots.receiptId, madeReceipts))
  ).map((r) => r.id);
  const boxIds = (
    await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))
  ).map((b) => b.id);
  await db.delete(events).where(inArray(events.entityId, boxIds));
  await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
  await db.delete(boxes).where(inArray(boxes.id, boxIds));
  await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db
    .update(clients)
    .set({ active: false })
    .where(inArray(clients.id, [clientA, clientC]));
  await db
    .update(warehouses)
    .set({ active: false })
    .where(inArray(warehouses.id, [whOrigin, whDest, whOther]));
  await db
    .update(users)
    .set({ active: false })
    .where(inArray(users.id, [actorId, sellerId]));
  await pgClient.end();
});

describe('lost on the road — the third resolution', () => {
  it('refuses without a written reason, at the form and in the service', async () => {
    expect(
      resolveMissingSchema.safeParse({ boxId: missingC, resolution: 'lost_in_transit' }).success,
    ).toBe(false);
    expect(
      resolveMissingSchema.safeParse({
        boxId: missingC,
        resolution: 'lost_in_transit',
        reason: 'ok',
      }).success,
    ).toBe(false);
    await expect(
      resolveMissing({ boxId: missingC, resolution: 'lost_in_transit', reason: '  ' }, ctx()),
    ).rejects.toMatchObject({ code: 'reason_required' });
    // The found answers stay reason-free.
    expect(
      resolveMissingSchema.safeParse({ boxId: missingC, resolution: 'found_here' }).success,
    ).toBe(true);
  });

  it('refuses a box that is not flagged missing', async () => {
    await expect(
      resolveMissing(
        { boxId: arrivedA, resolution: 'lost_in_transit', reason: 'yo‘qolgan' },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'not_missing' });
  });

  it('ends the carton lost in NO warehouse, off its truck, with the truck named — and nothing arrives', async () => {
    const before = await shares(freightEntry);
    await resolveMissing(
      {
        boxId: missingC,
        resolution: 'lost_in_transit',
        reason: 'tushirilmadi, haydovchi bilmaydi',
      },
      ctx(),
    );

    const box = await db.query.boxes.findFirst({ where: eq(boxes.id, missingC) });
    expect(box).toMatchObject({
      status: 'lost',
      statusReason: 'tushirilmadi, haydovchi bilmaydi',
      flags: [],
      currentBatchId: null,
      currentWarehouseId: null,
      crateId: null,
    });
    const [move] = await db
      .select()
      .from(boxMovements)
      .where(and(eq(boxMovements.boxId, missingC), eq(boxMovements.cause, 'lost_in_transit')));
    expect(move).toMatchObject({
      fromStatus: 'in_transit',
      toStatus: 'lost',
      refType: 'batch',
      refId: batchId,
      fromWarehouseId: null,
      toWarehouseId: null,
    });
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'box'), eq(auditLog.entityId, missingC)));
    expect(
      audit.some((a) => (a.after as { resolution?: string })?.resolution === 'lost_in_transit'),
    ).toBe(true);

    // Nothing arrived, so nobody is told it did.
    expect(
      await db
        .select()
        .from(clientNotices)
        .where(and(eq(clientNotices.clientId, clientC), eq(clientNotices.refId, batchId))),
    ).toEqual([]);
    // …but the seller hears the loss.
    const told = await db
      .select({ text: sql<string>`${notifications.payload}->>'text'` })
      .from(notifications)
      .where(and(eq(notifications.type, 'BoxLost'), eq(notifications.userId, sellerId)));
    expect(told.some((n) => n.text.includes(batchCode))).toBe(true);

    // The money does not move (6a): the lost carton keeps its freight share.
    const after = await shares(freightEntry);
    expect(after).toEqual(before);
    expect([...after.values()].reduce((a, v) => a + v, 0)).toBeCloseTo(300, 6);
  });

  it('lets the deal finish: the lost carton leaves the outstanding count', async () => {
    expect(await dealFullyIssued(dealId)).toBe(false);
    await resolveMissing(
      { boxId: missingA, resolution: 'lost_in_transit', reason: 'yo‘lda yo‘qoldi' },
      ctx(),
    );
    expect(await dealFullyIssued(dealId)).toBe(true);
  });

  it('the client’s lenta says «lost», on the truck’s line', async () => {
    const feed = await clientFeed(clientC);
    const lost = feed.find((f) => f.kind === 'lost');
    expect(lost?.meta).toMatchObject({ batch: batchCode });
  });

  it('counts at the truck’s two ends, not in every warehouse’s scope', async () => {
    const atDest = await cargoRiskList('lost', [whDest]);
    expect(atDest.find((r) => r.boxId === missingC)?.batchCode).toBe(batchCode);
    const elsewhere = await cargoRiskList('lost', [whOther]);
    expect(elsewhere.some((r) => r.boxId === missingC)).toBe(false);
  });

  it('a carton that turns up later comes back where the manager says it did', async () => {
    await expect(
      setBoxStatus({ boxId: missingC, to: 'in_stock', reason: 'Yiwuda topildi' }, ctx()),
    ).rejects.toMatchObject({ code: 'box_has_no_warehouse' });
    await setBoxStatus(
      { boxId: missingC, to: 'in_stock', reason: 'Yiwuda topildi', foundAtWarehouseId: whOrigin },
      ctx(),
    );
    const box = await db.query.boxes.findFirst({ where: eq(boxes.id, missingC) });
    expect(box).toMatchObject({
      status: 'in_stock',
      currentWarehouseId: whOrigin,
      statusReason: null,
    });
    const [found] = await db
      .select()
      .from(boxMovements)
      .where(and(eq(boxMovements.boxId, missingC), eq(boxMovements.cause, 'found')));
    expect(found?.toWarehouseId).toBe(whOrigin);
  });
});
