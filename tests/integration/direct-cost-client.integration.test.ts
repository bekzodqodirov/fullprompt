import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  boxes,
  boxMovements,
  clients,
  costEntries,
  costTypes,
  events,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { addCostEntry, recomputeAll } from '@/modules/wms/costing/service';
import { assignReceiptClient, editLot } from '@/modules/wms/receipts/edit';
import type { Actor } from '@/modules/platform/rbac/authorize';

/**
 * Audit U39: a cost typed «only for this client» (direct_to_client) named
 * the OLD client after a prixod's client was corrected, while the share rows
 * were re-stamped with the new one — so the next recompute split the fee over
 * the old client's boxes, found none, and the money left every tannarx while
 * staying in the P&L. Where the old client has nothing else in the cost's
 * scope the cost now moves with the prixod; where they do, it stays theirs
 * (owner's answer A, 2026-09-25) and is re-split onto their remaining cargo
 * the moment the correction commits.
 *
 * Money parked in 1637 — a private year no other file uses.
 */
const STAMP = String(Date.now()).slice(-6);
const DAY = '1637-09-09';
let actorId = '';
let whOrigin = '';
let whDest = '';
let clientX = '';
let clientY = '';
let clientZ = '';
let customs = '';
let freight = '';
const madeReceipts: string[] = [];
const madeBatches: string[] = [];
const madeCosts: string[] = [];
let seq = 0;

const ctx = () => ({ actorId, ip: null, userAgent: null });

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({
      code,
      name: `DC ${code}`,
      country,
      type,
      timezone: 'Asia/Tashkent',
      batchPrefix: code,
    })
    .returning();
  return row!.id;
}

async function mintLot(clientId: string, count: number, kg = 10) {
  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId: whOrigin,
      clientId,
      status: 'confirmed',
      confirmedAt: new Date(),
      createdBy: actorId,
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
      totalWeightKg: String(kg * count),
      totalVolumeM3: String(0.1 * count),
    })
    .returning();
  const rows = await db
    .insert(boxes)
    .values(
      Array.from({ length: count }, (_, i) => ({
        lotId: lot!.id,
        shortCode: `DC${STAMP}-${(seq += 1)}`,
        seqInLot: i + 1,
        status: 'in_stock',
        currentWarehouseId: whOrigin,
      })),
    )
    .returning();
  return { receiptId: receipt!.id, lotId: lot!.id, boxIds: rows.map((b) => b.id) };
}

/** A forming truck with these boxes reserved on it (the pre-departure base). */
async function mintForming(boxIds: string[]) {
  const [batch] = await db
    .insert(batches)
    .values({
      code: `DCB${STAMP}-${madeBatches.length}`,
      originWarehouseId: whOrigin,
      destWarehouseId: whDest,
      status: 'loading',
      createdBy: actorId,
    })
    .returning();
  madeBatches.push(batch!.id);
  await db.update(boxes).set({ currentBatchId: batch!.id }).where(inArray(boxes.id, boxIds));
  return batch!;
}

/** What the depart job's input is: the movement ledger, then `recomputeAll({ batchId })`. */
async function depart(batchId: string, boxIds: string[]) {
  await db
    .update(boxes)
    .set({ status: 'in_transit', currentWarehouseId: null })
    .where(inArray(boxes.id, boxIds));
  await db.insert(boxMovements).values(
    boxIds.map((boxId) => ({
      boxId,
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
  await db
    .update(batches)
    .set({ status: 'in_transit', departedAt: new Date() })
    .where(eq(batches.id, batchId));
  await recomputeAll({ batchId });
}

async function cost(input: Parameters<typeof addCostEntry>[0]) {
  const entry = await addCostEntry(input, ctx());
  madeCosts.push(entry.id);
  return entry;
}

/** client → Σ shares of one entry, and the entry's own dollars. */
async function byClient(entryId: string) {
  const rows = await db.execute<{ client_id: string | null; usd: string }>(sql`
    SELECT client_id, sum(amount_usd) AS usd FROM cost_allocations
     WHERE cost_entry_id = ${entryId} GROUP BY client_id
  `);
  return Object.fromEntries(rows.map((r) => [r.client_id ?? '-', Number(r.usd)]));
}

/** boxId → share of one entry. */
async function boxShares(entryId: string) {
  const rows = await db.execute<{ box_id: string; usd: string }>(sql`
    SELECT box_id, amount_usd AS usd FROM cost_allocations WHERE cost_entry_id = ${entryId}
  `);
  return Object.fromEntries(rows.map((r) => [r.box_id, Number(r.usd)]));
}

const clientOf = async (entryId: string) =>
  (await db.query.costEntries.findFirst({ where: eq(costEntries.id, entryId) }))?.clientId;

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99890${STAMP}6`,
      fullName: `DC manager ${STAMP}`,
      passwordHash: 'x',
      active: true,
    })
    .returning();
  actorId = u!.id;
  whOrigin = await mintWarehouse(`DCO${STAMP}`.slice(0, 8), 'CN', 'origin');
  whDest = await mintWarehouse(`DCD${STAMP}`.slice(0, 8), 'UZ', 'customs');
  const mintClient = async (tag: string) =>
    (
      await db
        .insert(clients)
        .values({ clientCode: `${tag}${STAMP}`, name: `DC ${tag} ${STAMP}` })
        .returning()
    )[0]!.id;
  clientX = await mintClient('DX');
  clientY = await mintClient('DY');
  clientZ = await mintClient('DZ');
  const typeId = async (code: string) =>
    (await db.query.costTypes.findFirst({ where: eq(costTypes.code, code) }))!.id;
  customs = await typeId('customs');
  freight = await typeId('freight');
});

afterAll(async () => {
  if (madeCosts.length) await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  const lotIds = (
    await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(inArray(receiptLots.receiptId, madeReceipts))
  ).map((r) => r.id);
  if (lotIds.length) {
    const boxIds = (
      await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))
    ).map((b) => b.id);
    if (boxIds.length) {
      await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
      await db.delete(boxes).where(inArray(boxes.id, boxIds));
    }
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  // assignReceiptClient emits ReceiptConfirmed about each corrected prixod.
  await db.delete(events).where(inArray(events.entityId, madeReceipts));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  if (madeBatches.length) await db.delete(batches).where(inArray(batches.id, madeBatches));
  await db
    .update(clients)
    .set({ active: false })
    .where(inArray(clients.id, [clientX, clientY, clientZ]));
  await db
    .update(warehouses)
    .set({ active: false })
    .where(inArray(warehouses.id, [whOrigin, whDest]));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('a direct cost follows the corrected prixod when it has nowhere else to go', () => {
  it('A — a truck fee «only for X» survives the departure after X’s only prixod becomes Y’s', async () => {
    const r = await mintLot(clientX, 2);
    const z = await mintLot(clientZ, 2);
    const truck = await mintForming([...r.boxIds, ...z.boxIds]);
    const e = await cost({
      scope: 'batch',
      batchId: truck.id,
      costTypeId: freight,
      amount: 50,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'direct_to_client',
      clientId: clientX,
    });
    expect(await byClient(e.id)).toEqual({ [clientX]: 50 });

    await assignReceiptClient(r.receiptId, clientY, ctx());
    expect(await clientOf(e.id)).toBe(clientY);

    await depart(truck.id, [...r.boxIds, ...z.boxIds]);
    expect(await byClient(e.id)).toEqual({ [clientY]: 50 });

    // Whose tannarx a fee belongs to is a money fact: the move is on record.
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'cost_entry'),
          eq(auditLog.entityId, e.id),
          eq(auditLog.action, 'update'),
        ),
      );
    expect(audit.map((a) => [a.before, a.after])).toEqual([
      [
        { clientId: clientX },
        { clientId: clientY, from: 'receipt_client_change', receiptId: r.receiptId },
      ],
    ]);
  });

  it('B — the prixod’s own «only for X» fee survives a lot correction after the client change', async () => {
    const r = await mintLot(clientX, 3);
    const e = await cost({
      scope: 'receipt',
      receiptId: r.receiptId,
      costTypeId: customs,
      amount: 30,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'direct_to_client',
      clientId: clientX,
    });
    await assignReceiptClient(r.receiptId, clientY, ctx());

    await editLot(
      {
        lotId: r.lotId,
        productNameZh: '测试货',
        productNameRu: '',
        boxCount: 3,
        totalWeightKg: 36,
        totalVolumeM3: 0.3,
        note: null,
      } as Parameters<typeof editLot>[0],
      {
        id: actorId,
        fullName: `DC manager ${STAMP}`,
        roles: ['warehouse_manager'],
        permissions: new Set(['receipts.edit', 'receipts.void']),
      } as unknown as Actor,
      ctx(),
    );

    expect(await clientOf(e.id)).toBe(clientY);
    expect(await byClient(e.id)).toEqual({ [clientY]: 30 });
  });

  it('C — X still has cargo aboard: the fee stays X’s and lands on X’s REMAINING cargo at once (owner, A)', async () => {
    const r1 = await mintLot(clientX, 2);
    const r2 = await mintLot(clientX, 2);
    const truck = await mintForming([...r1.boxIds, ...r2.boxIds]);
    const e = await cost({
      scope: 'batch',
      batchId: truck.id,
      costTypeId: freight,
      amount: 40,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'direct_to_client',
      clientId: clientX,
    });
    expect(Object.keys(await boxShares(e.id)).sort()).toEqual([...r1.boxIds, ...r2.boxIds].sort());

    await assignReceiptClient(r1.receiptId, clientY, ctx());

    // Whoever typed it wrote «for X»: the cost is not re-addressed…
    expect(await clientOf(e.id)).toBe(clientX);
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, 'cost_entry'),
          eq(auditLog.entityId, e.id),
          eq(auditLog.action, 'update'),
        ),
      );
    expect(audit).toEqual([]);
    // …and the corrected prixod carries none of it — not «until some later
    // recompute», straight away.
    const now = await boxShares(e.id);
    expect(Object.keys(now).sort()).toEqual([...r2.boxIds].sort());
    expect(await byClient(e.id)).toEqual({ [clientX]: 40 });

    // The depart job's recompute agrees with it: nothing moves.
    await depart(truck.id, [...r1.boxIds, ...r2.boxIds]);
    expect(await boxShares(e.id)).toEqual(now);
  });
});
