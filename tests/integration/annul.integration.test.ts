import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  boxes,
  boxMovements,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  crates,
  loadPlanLines,
  loadPlans,
  loadPlanVersions,
  partners,
  partnerTypes,
  partnerTransactions,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { annulPreview, annulReceipt } from '@/modules/wms/receipts/annul';

/**
 * The super-admin annul (owner, 2026-08-26): test data through the WHOLE
 * flow — departed on a REAL truck beside real cargo, with costs and a partner
 * debt — cascade-voided in one press. What these tests pin, each of them a
 * confirmed finding of the design review: the money voids in the SAME
 * transaction as the cargo (a refusal destroys nothing), the shared truck's
 * costs REDISTRIBUTE onto the real cargo, a truck left empty retires with
 * its own freight voided, the re-press is the repair, and nobody below
 * super_admin can reach any of it (#531).
 */
const STAMP = String(Date.now()).slice(-6);
const ctx: { actorId: string; ip: null; userAgent: null } = { actorId: '', ip: null, userAgent: null };
let actorId = '';
let superActor = { id: '', roles: ['super_admin'] };
let plainActor = { id: '', roles: ['admin'] };
let whOrigin = '';
let whDest = '';
let testClient = '';
let realClient = '';
let batchId = '';
let costTypeId = '';
let partnerId = '';
let testReceipt = '';
let realReceipt = '';
let testLot = '';
let realLot = '';
let testBoxes: string[] = [];
let realBoxes: string[] = [];
let receiptEntry = '';
let batchEntry = '';
let partnerCharge = '';
let crateId = '';

async function mintBoxes(lotId: string, prefix: string, n: number, status: string, batch: string | null) {
  const rows = await db
    .insert(boxes)
    .values(
      Array.from({ length: n }, (_, i) => ({
        lotId,
        shortCode: `${prefix}-${i}`,
        seqInLot: i + 1,
        status,
        currentBatchId: batch,
        currentWarehouseId: null,
      })),
    )
    .returning();
  await db.insert(boxMovements).values(
    rows.map((r) => ({
      boxId: r.id,
      fromWarehouseId: whOrigin,
      toWarehouseId: whDest,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batch ?? batchId,
      actorId,
    })),
  );
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99895${STAMP}1`, fullName: `AN ${STAMP}`, passwordHash: 'x', active: true })
    .returning();
  actorId = u!.id;
  ctx.actorId = actorId;
  superActor = { id: actorId, roles: ['super_admin'] };
  plainActor = { id: actorId, roles: ['admin'] };

  const wh = async (code: string, type: string, country: string) => {
    const [row] = await db
      .insert(warehouses)
      .values({ code, name: `AN ${code}`, country, type, timezone: 'Asia/Tashkent', batchPrefix: code })
      .returning();
    return row!.id;
  };
  whOrigin = await wh(`ANO${STAMP}`.slice(0, 8), 'origin', 'CN');
  whDest = await wh(`AND${STAMP}`.slice(0, 8), 'customs', 'UZ');

  const client = async (code: string) => {
    const [row] = await db.insert(clients).values({ clientCode: code, name: `AN ${code}` }).returning();
    return row!.id;
  };
  testClient = await client(`ANT${STAMP}`.slice(0, 10));
  realClient = await client(`ANR${STAMP}`.slice(0, 10));

  const [batch] = await db
    .insert(batches)
    .values({
      code: `ANB${STAMP}`,
      originWarehouseId: whOrigin,
      destWarehouseId: whDest,
      status: 'in_transit',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  batchId = batch!.id;

  const receipt = async (clientId: string) => {
    const [row] = await db
      .insert(receipts)
      .values({ warehouseId: whOrigin, clientId, status: 'confirmed', confirmedAt: new Date(), createdBy: actorId })
      .returning();
    return row!.id;
  };
  testReceipt = await receipt(testClient);
  realReceipt = await receipt(realClient);
  const lot = async (receiptId: string, n: number) => {
    const [row] = await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: 1,
        letter: 'A',
        dimsMode: 'mixed',
        productNameZh: '测试',
        boxCount: n,
        totalWeightKg: String(n * 10),
        totalVolumeM3: String(n * 0.3),
      })
      .returning();
    return row!.id;
  };
  testLot = await lot(testReceipt, 3);
  realLot = await lot(realReceipt, 2);
  testBoxes = await mintBoxes(testLot, `ANT${STAMP}`, 3, 'in_transit', batchId);
  realBoxes = await mintBoxes(realLot, `ANR${STAMP}`, 2, 'in_transit', batchId);

  // A crate the test boxes were packed into (still ACTIVE, holding one box
  // live — the annul must dissolve it once it empties).
  const [crate] = await db
    .insert(crates)
    .values({ code: `ANC${STAMP}`, warehouseId: whOrigin, clientId: testClient, createdBy: actorId })
    .returning();
  crateId = crate!.id;
  await db.update(boxes).set({ crateId }).where(eq(boxes.id, testBoxes[0]!));

  const [type] = await db.select({ id: costTypes.id }).from(costTypes).limit(1);
  costTypeId = type!.id;
  const [ptype] = await db
    .insert(partnerTypes)
    .values({ code: `an_${STAMP}`, name: `AN tip ${STAMP}` })
    .returning();
  const [partner] = await db
    .insert(partners)
    .values({ name: `AN firma ${STAMP}`, typeId: ptype!.id, createdBy: actorId })
    .returning();
  partnerId = partner!.id;

  // Receipt-scope money on the TEST receipt, with the partner's derived debt.
  const [re] = await db
    .insert(costEntries)
    .values({
      scope: 'receipt',
      receiptId: testReceipt,
      costTypeId,
      amount: '60',
      currency: 'USD',
      amountUsd: '60',
      fxRateUsed: '1',
      costDate: '2026-08-01',
      allocationBasis: 'boxes',
      enteredBy: actorId,
      partnerId,
    })
    .returning();
  receiptEntry = re!.id;
  await db.insert(costAllocations).values(
    testBoxes.map((boxId) => ({ costEntryId: receiptEntry, boxId, clientId: testClient, amountUsd: '20' })),
  );
  const [charge] = await db
    .insert(partnerTransactions)
    .values({
      partnerId,
      type: 'charge',
      amount: '60',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '60',
      txDate: '2026-08-01',
      costEntryId: receiptEntry,
      createdBy: actorId,
    })
    .returning();
  partnerCharge = charge!.id;

  // Batch-scope freight on the SHARED truck: 5 boxes × $20.
  const [be] = await db
    .insert(costEntries)
    .values({
      scope: 'batch',
      batchId,
      costTypeId,
      amount: '100',
      currency: 'USD',
      amountUsd: '100',
      fxRateUsed: '1',
      costDate: '2026-08-01',
      allocationBasis: 'boxes',
      enteredBy: actorId,
    })
    .returning();
  batchEntry = be!.id;
  await db.insert(costAllocations).values(
    [...testBoxes, ...realBoxes].map((boxId) => ({
      costEntryId: batchEntry,
      boxId,
      clientId: testBoxes.includes(boxId) ? testClient : realClient,
      amountUsd: '20',
    })),
  );
});

afterAll(async () => {
  const boxIds = [...testBoxes, ...realBoxes];
  await db.delete(costAllocations).where(inArray(costAllocations.costEntryId, [receiptEntry, batchEntry]));
  await db.delete(partnerTransactions).where(eq(partnerTransactions.id, partnerCharge));
  await db.delete(costEntries).where(inArray(costEntries.id, [receiptEntry, batchEntry]));
  await db.update(partners).set({ active: false }).where(eq(partners.id, partnerId));
  if (boxIds.length) {
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
    await db.delete(boxes).where(inArray(boxes.id, boxIds));
  }
  await db.delete(loadPlanLines).where(inArray(loadPlanLines.lotId, [testLot, realLot]));
  await db.delete(receiptLots).where(inArray(receiptLots.id, [testLot, realLot]));
  await db.delete(receipts).where(inArray(receipts.id, [testReceipt, realReceipt]));
  await db.delete(crates).where(eq(crates.id, crateId));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.update(clients).set({ active: false }).where(inArray(clients.id, [testClient, realClient]));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whOrigin, whDest]));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('annulReceipt — the cascade', () => {
  it('refuses everybody below super_admin, in the SERVICE (#531)', async () => {
    await expect(annulReceipt(testReceipt, 'test tozalash', plainActor, ctx)).rejects.toThrow(
      'annul_forbidden',
    );
  });

  it('refuses a short reason and a missing receipt', async () => {
    await expect(annulReceipt(testReceipt, 'x', superActor, ctx)).rejects.toThrow('reason_required');
    await expect(
      annulReceipt('00000000-0000-4000-8000-000000000000', 'test tozalash', superActor, ctx),
    ).rejects.toThrow('not_found');
  });

  it('refuses while a submitted plan names the cargo, and destroys NOTHING on the refusal', async () => {
    const [plan] = await db
      .insert(loadPlans)
      .values({
        originWarehouseId: whOrigin,
        destWarehouseId: whDest,
        status: 'pending_agent',
        currentVersionNo: 1,
        createdBy: actorId,
      })
      .returning();
    const [version] = await db
      .insert(loadPlanVersions)
      .values({ planId: plan!.id, versionNo: 1, submittedBy: actorId, totalBoxes: 3, totalKg: '30', totalM3: '0.9' })
      .returning();
    await db.insert(loadPlanLines).values({
      versionId: version!.id,
      lotId: testLot,
      plannedBoxCount: 3,
      plannedKg: '30',
      plannedM3: '0.9',
    });

    await expect(annulReceipt(testReceipt, 'test tozalash', superActor, ctx)).rejects.toThrow(
      'box_on_active_plan',
    );
    // The refusal rolled EVERYTHING back — the review's first blocker was a
    // version that had already committed the money voids at this point.
    const [entry] = await db.select().from(costEntries).where(eq(costEntries.id, receiptEntry));
    expect(entry!.voidedAt).toBeNull();
    const allocs = await db
      .select()
      .from(costAllocations)
      .where(eq(costAllocations.costEntryId, receiptEntry));
    expect(allocs).toHaveLength(3);

    await db.delete(loadPlanLines).where(eq(loadPlanLines.versionId, version!.id));
    await db.delete(loadPlanVersions).where(eq(loadPlanVersions.id, version!.id));
    await db.delete(loadPlans).where(eq(loadPlans.id, plan!.id));
  });

  it('annuls the test receipt: cargo, its own money, its crate — and redistributes the truck', async () => {
    const preview = await annulPreview(testReceipt);
    expect(preview!.liveCostEntries).toBe(1);
    expect(preview!.affectedBatches).toHaveLength(1);
    expect(preview!.affectedBatches[0]!.willRetire).toBe(false); // the real cargo keeps the truck alive

    const res = await annulReceipt(testReceipt, 'test tozalash', superActor, ctx);
    expect(res.repaired).toBe(false);
    expect(res.boxesVoided).toBe(3);
    expect(res.costEntriesVoided).toBe(1);
    expect(res.batchesRetired).toHaveLength(0);
    expect(res.cratesDissolved).toBe(1);

    const [receipt] = await db.select().from(receipts).where(eq(receipts.id, testReceipt));
    expect(receipt!.status).toBe('voided');
    expect(receipt!.voidReason).toBe('test tozalash');

    const rows = await db.select().from(boxes).where(inArray(boxes.id, testBoxes));
    for (const b of rows) {
      expect(b.status).toBe('void');
      expect(b.currentBatchId).toBeNull();
      expect(b.crateId).toBeNull();
    }
    const moves = await db
      .select()
      .from(boxMovements)
      .where(and(inArray(boxMovements.boxId, testBoxes), eq(boxMovements.cause, 'receipt_void')));
    expect(moves).toHaveLength(3);

    // The receipt's own money went WITH it, pair rule included.
    const [entry] = await db.select().from(costEntries).where(eq(costEntries.id, receiptEntry));
    expect(entry!.voidedAt).not.toBeNull();
    expect(
      await db.select().from(costAllocations).where(eq(costAllocations.costEntryId, receiptEntry)),
    ).toHaveLength(0);
    const [charge] = await db
      .select()
      .from(partnerTransactions)
      .where(eq(partnerTransactions.id, partnerCharge));
    expect(charge!.voidedAt).not.toBeNull();

    // The crate the annul emptied is dissolved, not an active scannable ghost.
    const [crate] = await db.select().from(crates).where(eq(crates.id, crateId));
    expect(crate!.status).toBe('dissolved');

    // THE REDISTRIBUTION: the shared $100 freight now sits entirely on the
    // real client's two boxes — $50 each, not $20 with $60 on phantoms.
    const allocs = await db
      .select()
      .from(costAllocations)
      .where(eq(costAllocations.costEntryId, batchEntry));
    expect(allocs).toHaveLength(2);
    expect(allocs.every((a) => realBoxes.includes(a.boxId))).toBe(true);
    expect(allocs.reduce((s, a) => s + Number(a.amountUsd), 0)).toBeCloseTo(100, 2);

    // The truck itself is still a real trip.
    const [batch] = await db.select().from(batches).where(eq(batches.id, batchId));
    expect(batch!.status).toBe('in_transit');
  });

  it('the re-press is the repair, and repeats nothing', async () => {
    const before = await db
      .select()
      .from(boxMovements)
      .where(and(inArray(boxMovements.boxId, testBoxes), eq(boxMovements.cause, 'receipt_void')));
    const res = await annulReceipt(testReceipt, 'test tozalash', superActor, ctx);
    expect(res.repaired).toBe(true);
    const after = await db
      .select()
      .from(boxMovements)
      .where(and(inArray(boxMovements.boxId, testBoxes), eq(boxMovements.cause, 'receipt_void')));
    expect(after).toHaveLength(before.length);
  });

  it('annulling the LAST cargo retires the truck and voids its now-empty freight', async () => {
    const preview = await annulPreview(realReceipt);
    expect(preview!.affectedBatches[0]!.willRetire).toBe(true);

    const res = await annulReceipt(realReceipt, 'test tozalash 2', superActor, ctx);
    expect(res.batchesRetired).toEqual([`ANB${STAMP}`]);
    // The phantom truck is retired — /transit, the map and the silent-truck
    // sweep all key on the batch row.
    const [batch] = await db.select().from(batches).where(eq(batches.id, batchId));
    expect(batch!.status).toBe('cancelled');
    // …and its own freight did not survive as a live P&L cost allocated to
    // nothing: the empty-scope sweep voided it.
    const [entry] = await db.select().from(costEntries).where(eq(costEntries.id, batchEntry));
    expect(entry!.voidedAt).not.toBeNull();
    expect(
      await db.select().from(costAllocations).where(eq(costAllocations.costEntryId, batchEntry)),
    ).toHaveLength(0);
  });

  it('the audit trail names the annul on every layer', async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, testReceipt)));
    const voidRow = rows.find((r) => r.action === 'void');
    expect(voidRow).toBeTruthy();
    expect((voidRow!.after as Record<string, unknown>).annul).toBe(true);
  });
});
