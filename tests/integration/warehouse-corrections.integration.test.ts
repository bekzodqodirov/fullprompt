import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  crates,
  events,
  notifications,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { removeLoadedCode } from '@/modules/wms/scanning/service';
import { finishUnload } from '@/modules/wms/scanning/unload';
import { acceptFoundBox, reconcileInventory } from '@/modules/wms/inventory/service';
import { editLot } from '@/modules/wms/receipts/edit';
import { markBoxLost } from '@/modules/wms/receipts/service';
import { usersWithPermission } from '@/modules/platform/notifications/service';
import type { Actor } from '@/modules/platform/rbac/authorize';

/**
 * The warehouse-corrections round (owner's five reports, 2026-08-25): a
 * scanned box comes back OFF a still-loading truck (his answer B — off the
 * plan, back to the shelf), a box found standing here while the record says a
 * truck or another warehouse is accepted by one scan, a crushed carton is
 * written off with a reason, and a manager corrects a receipt's measures
 * after the cargo left.
 */
const STAMP = String(Date.now()).slice(-6);
let actorId = '';
let authorId = '';
let sellerId = '';
let whOrigin = '';
let whCustoms = '';
let clientId = '';
const madeReceipts: string[] = [];
const madeBatches: string[] = [];
const madeCrates: string[] = [];
const madeWarehouses: string[] = [];

async function mintWarehouse(code: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({
      code,
      name: `WC ${code}`,
      country: type === 'origin' ? 'CN' : 'UZ',
      type,
      timezone: 'Asia/Tashkent',
      batchPrefix: code,
    })
    .returning();
  return row!.id;
}

async function mintReceipt(input: { boxes: number; kg: string; m3: string }) {
  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId: whOrigin,
      clientId,
      status: 'confirmed',
      confirmedAt: new Date(),
      createdBy: authorId,
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
      boxCount: input.boxes,
      totalWeightKg: input.kg,
      totalVolumeM3: input.m3,
    })
    .returning();
  const boxRows = await db
    .insert(boxes)
    .values(
      Array.from({ length: input.boxes }, (_, i) => ({
        lotId: lot!.id,
        shortCode: `WC${STAMP}-${madeReceipts.length}${i}`,
        seqInLot: i + 1,
        status: 'in_stock',
        currentWarehouseId: whOrigin,
      })),
    )
    .returning();
  return { receiptId: receipt!.id, lotId: lot!.id, boxes: boxRows };
}

async function mintBatch(status: string) {
  const [batch] = await db
    .insert(batches)
    .values({
      code: `WCB${STAMP}-${madeBatches.length}`,
      originWarehouseId: whOrigin,
      destWarehouseId: whCustoms,
      status,
      ...(status === 'in_transit' ? { departedAt: new Date() } : {}),
      createdBy: actorId,
    })
    .returning();
  madeBatches.push(batch!.id);
  return batch!;
}

const ctx = () => ({ actorId, ip: null, userAgent: null });

const managerActor = (): Actor =>
  ({
    id: actorId,
    fullName: `WC boshliq ${STAMP}`,
    roles: ['warehouse_manager'],
    permissions: new Set(['receipts.edit', 'receipts.void']),
  }) as unknown as Actor;
const authorActor = (): Actor =>
  ({
    id: authorId,
    fullName: `WC skladchi ${STAMP}`,
    roles: ['warehouse_operator'],
    permissions: new Set(['receipts.edit']),
  }) as unknown as Actor;

beforeAll(async () => {
  const mintUser = async (tag: string) => {
    const [u] = await db
      .insert(users)
      .values({
        phone: `+99895${STAMP}${tag.length}`,
        fullName: `WC ${tag} ${STAMP}`,
        passwordHash: 'x',
        active: true,
      })
      .returning();
    return u!.id;
  };
  actorId = await mintUser('M');
  authorId = await mintUser('Op');
  sellerId = await mintUser('Sot');
  whOrigin = await mintWarehouse(`WO${STAMP}`.slice(0, 8), 'origin');
  whCustoms = await mintWarehouse(`WU${STAMP}`.slice(0, 8), 'customs');
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `WC${STAMP}`.slice(0, 10), name: `WC ${STAMP}`, salesManagerId: sellerId })
    .returning();
  clientId = client!.id;
});

afterAll(async () => {
  // Cleanup is ordered by the FKs; the warehouses an audited action touched
  // can only be DEACTIVATED (audit_log references them, round 107's lesson).
  await db
    .delete(notifications)
    .where(
      and(
        inArray(notifications.type, ['BoxFoundHere', 'BoxLost', 'ReceiptMeasureCorrected']),
        sql`(${notifications.userId} in (${authorId}::uuid, ${sellerId}::uuid) or ${notifications.payload}->>'text' like ${`%${STAMP}%`})`,
      ),
    );
  // The stocktake's own event row goes with its warehouse — a pending
  // InventoryCompleted about a deactivated test warehouse is nobody's news.
  await db
    .delete(events)
    .where(and(eq(events.entityType, 'warehouse'), inArray(events.entityId, [whCustoms, whOrigin])));
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
    if (boxIds.length) await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
    await db.delete(boxes).where(inArray(boxes.lotId, lotIds));
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  if (madeCrates.length) await db.delete(crates).where(inArray(crates.id, madeCrates));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  if (madeBatches.length) await db.delete(batches).where(inArray(batches.id, madeBatches));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db
    .update(warehouses)
    .set({ active: false })
    .where(inArray(warehouses.id, [whOrigin, whCustoms, ...madeWarehouses]));
  await db
    .update(users)
    .set({ active: false })
    .where(inArray(users.id, [actorId, authorId, sellerId]));
  await pgClient.end();
});

describe('removeLoadedCode — off the truck, off the plan, back on the shelf', () => {
  it('returns a scanned box to stock and records why (his answer B)', async () => {
    const { boxes: minted } = await mintReceipt({ boxes: 2, kg: '40', m3: '0.6' });
    const batch = await mintBatch('loading');
    await db
      .update(boxes)
      .set({ status: 'loading', currentBatchId: batch.id })
      .where(eq(boxes.id, minted[0]!.id));

    const res = await removeLoadedCode(batch.id, minted[0]!.shortCode, ctx());
    expect(res.removed).toEqual([minted[0]!.shortCode]);
    const after = await db.query.boxes.findFirst({ where: eq(boxes.id, minted[0]!.id) });
    expect(after?.status).toBe('in_stock');
    expect(after?.currentBatchId).toBeNull();
    const move = await db.query.boxMovements.findFirst({
      where: and(eq(boxMovements.boxId, minted[0]!.id), eq(boxMovements.cause, 'load_removed')),
    });
    expect(move?.refId).toBe(batch.id);

    // A second press is a refusal, not a silent no-op — the box is no longer
    // on this truck and the screen must say so.
    await expect(removeLoadedCode(batch.id, minted[0]!.shortCode, ctx())).rejects.toMatchObject({
      code: 'not_loaded_here',
    });
  });

  it('refuses once the truck has departed — that is resolveMissing’s job', async () => {
    const { boxes: minted } = await mintReceipt({ boxes: 1, kg: '10', m3: '0.1' });
    const batch = await mintBatch('in_transit');
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentBatchId: batch.id, currentWarehouseId: null })
      .where(eq(boxes.id, minted[0]!.id));
    await expect(removeLoadedCode(batch.id, minted[0]!.shortCode, ctx())).rejects.toMatchObject({
      code: 'batch_not_loading',
    });
    expect(
      (await db.query.boxes.findFirst({ where: eq(boxes.id, minted[0]!.id) }))?.status,
    ).toBe('in_transit');
  });

  it('a single carton taken out of a loaded crate loses its crateId', async () => {
    const { boxes: minted } = await mintReceipt({ boxes: 2, kg: '20', m3: '0.4' });
    const batch = await mintBatch('loading');
    const [crate] = await db
      .insert(crates)
      .values({
        code: `CR-WC${STAMP}-${madeCrates.length}`,
        warehouseId: whOrigin,
        clientId,
        createdBy: actorId,
        status: 'active',
      })
      .returning();
    madeCrates.push(crate!.id);
    await db
      .update(boxes)
      .set({ status: 'loading', currentBatchId: batch.id, crateId: crate!.id })
      .where(inArray(boxes.id, minted.map((b) => b.id)));

    await removeLoadedCode(batch.id, minted[0]!.shortCode, ctx());
    const taken = await db.query.boxes.findFirst({ where: eq(boxes.id, minted[0]!.id) });
    const stayed = await db.query.boxes.findFirst({ where: eq(boxes.id, minted[1]!.id) });
    // The carton physically left the yashik; its sibling is still aboard IN it.
    expect(taken?.crateId).toBeNull();
    expect(stayed?.crateId).toBe(crate!.id);
    expect(stayed?.status).toBe('loading');

    // A crate-code removal takes the rest off intact — membership kept.
    const byCrate = await removeLoadedCode(batch.id, crate!.code, ctx());
    expect(byCrate.removed).toEqual([minted[1]!.shortCode]);
    const afterCrate = await db.query.boxes.findFirst({ where: eq(boxes.id, minted[1]!.id) });
    expect(afterCrate?.status).toBe('in_stock');
    expect(afterCrate?.crateId).toBe(crate!.id);
  });
});

describe('closing an unload over cartons nobody scanned', () => {
  it('is a MANAGER act — the service refuses, it is not only hidden on screen', async () => {
    // The owner took the accept-everything shortcut away from the operators so
    // the cartons get scanned. Leaving them the finish button would move the
    // same press one button right and LOSE the cargo instead of accepting it:
    // every outstanding box is flagged `missing_in_transit`, and the client's
    // handover then refuses until a manager resolves each one.
    const { boxes: minted } = await mintReceipt({ boxes: 1, kg: '11', m3: '0.2' });
    const batch = await mintBatch('in_transit');
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentBatchId: batch.id, currentWarehouseId: null })
      .where(eq(boxes.id, minted[0]!.id));

    await expect(finishUnload(batch.id, ctx())).rejects.toMatchObject({
      code: 'finish_needs_manager',
    });
    // Nothing was flagged by the refusal.
    expect(
      (await db.query.boxes.findFirst({ where: eq(boxes.id, minted[0]!.id) }))?.flags,
    ).toEqual([]);

    // The manager may, and then it means what it always meant.
    const res = await finishUnload(batch.id, ctx(), { mayCloseWithMissing: true });
    expect(res.missing).toEqual([minted[0]!.shortCode]);
  });
});

describe('acceptFoundBox — reality wins, one scan at a time', () => {
  it('takes a box off a truck bound ELSEWHERE and lands it ready_for_pickup here', async () => {
    // The genuine stray: recorded on a lorry heading somewhere else, standing
    // on this floor. A box on a truck bound for THIS warehouse is the unload
    // screen's job and is refused — the test below.
    const { boxes: minted } = await mintReceipt({ boxes: 1, kg: '15', m3: '0.2' });
    const elsewhere = await mintWarehouse(`WX${STAMP}`.slice(0, 8), 'distribution');
    const [batch] = await db
      .insert(batches)
      .values({
        code: `WCE${STAMP}`,
        originWarehouseId: whOrigin,
        destWarehouseId: elsewhere,
        status: 'in_transit',
        departedAt: new Date(),
        createdBy: actorId,
      })
      .returning();
    madeBatches.push(batch!.id);
    madeWarehouses.push(elsewhere);
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentBatchId: batch!.id, currentWarehouseId: null })
      .where(eq(boxes.id, minted[0]!.id));

    const found = await acceptFoundBox(
      { warehouseId: whCustoms, code: minted[0]!.shortCode.toLowerCase() },
      ctx(),
    );
    expect(found.fromBatchCode).toBe(batch!.code);
    const after = await db.query.boxes.findFirst({ where: eq(boxes.id, minted[0]!.id) });
    // A UZ customs warehouse issues to clients — landing `in_stock` there
    // hides the box from every «tayyor» list (resolveMissing's own rule).
    expect(after?.status).toBe('ready_for_pickup');
    expect(after?.currentWarehouseId).toBe(whCustoms);
    expect(after?.currentBatchId).toBeNull();
    const move = await db.query.boxMovements.findFirst({
      where: and(eq(boxMovements.boxId, minted[0]!.id), eq(boxMovements.cause, 'inventory_found')),
    });
    expect(move?.toWarehouseId).toBe(whCustoms);
    // The «planners are told» half is pinned source-shape in the wire test —
    // asserting the row here would hang on which SEEDED users happen to hold
    // plans.manage (#380's trap).
  });

  it('refuses a box riding a truck bound HERE — that is the unload screen', async () => {
    // The lower-gated bypass the review found: without this, an operator
    // denied the accept-everything shortcut scans the whole manifest into
    // /inventory instead, one tap each — through a weaker gate, and writing
    // records the logist's summary, the client's notice and the seller's
    // message all read as «nothing arrived».
    const { boxes: minted } = await mintReceipt({ boxes: 1, kg: '12', m3: '0.2' });
    const bound = await mintBatch('in_transit');
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentBatchId: bound.id, currentWarehouseId: null })
      .where(eq(boxes.id, minted[0]!.id));
    await expect(
      acceptFoundBox({ warehouseId: whCustoms, code: minted[0]!.shortCode }, ctx()),
    ).rejects.toMatchObject({ code: 'use_unload_screen' });
  });

  it('refuses what is not a stray: already here, still loading, issued, lost', async () => {
    const { boxes: minted } = await mintReceipt({ boxes: 4, kg: '40', m3: '0.8' });
    await expect(
      acceptFoundBox({ warehouseId: whOrigin, code: minted[0]!.shortCode }, ctx()),
    ).rejects.toMatchObject({ code: 'already_here' });

    const batch = await mintBatch('loading');
    await db
      .update(boxes)
      .set({ status: 'loading', currentBatchId: batch.id })
      .where(eq(boxes.id, minted[1]!.id));
    await expect(
      acceptFoundBox({ warehouseId: whCustoms, code: minted[1]!.shortCode }, ctx()),
    ).rejects.toMatchObject({ code: 'still_loading' });

    await db.update(boxes).set({ status: 'issued' }).where(eq(boxes.id, minted[2]!.id));
    await expect(
      acceptFoundBox({ warehouseId: whCustoms, code: minted[2]!.shortCode }, ctx()),
    ).rejects.toMatchObject({ code: 'box_issued' });

    await db.update(boxes).set({ status: 'lost' }).where(eq(boxes.id, minted[3]!.id));
    await expect(
      acceptFoundBox({ warehouseId: whCustoms, code: minted[3]!.shortCode }, ctx()),
    ).rejects.toMatchObject({ code: 'box_lost' });
  });

  it('the full stocktake lands found boxes by the same warehouse-type rule', async () => {
    const { boxes: minted } = await mintReceipt({ boxes: 1, kg: '5', m3: '0.1' });
    // Recorded at the origin, found while counting the customs warehouse.
    const summary = await reconcileInventory(
      {
        warehouseId: whCustoms,
        foundHereCodes: [minted[0]!.shortCode],
        lostBoxIds: [],
        scannedCount: 1,
      },
      { canMarkLost: false },
      ctx(),
    );
    expect(summary.moved).toEqual([minted[0]!.shortCode]);
    const after = await db.query.boxes.findFirst({ where: eq(boxes.id, minted[0]!.id) });
    expect(after?.status).toBe('ready_for_pickup');
  });
});

describe('markBoxLost — one crushed carton, one written reason', () => {
  it('writes the box off, unhooks its plan/crate, and tells the seller', async () => {
    const { boxes: minted } = await mintReceipt({ boxes: 1, kg: '8', m3: '0.1' });
    await expect(
      markBoxLost({ boxId: minted[0]!.id, reason: ' ', atWarehouseId: whOrigin }, ctx()),
    ).rejects.toMatchObject({ code: 'reason_required' });

    const res = await markBoxLost({ boxId: minted[0]!.id, reason: `suv tegdi ${STAMP}`, atWarehouseId: whOrigin }, ctx());
    expect(res.shortCode).toBe(minted[0]!.shortCode);
    const after = await db.query.boxes.findFirst({ where: eq(boxes.id, minted[0]!.id) });
    expect(after?.status).toBe('lost');
    expect(after?.statusReason).toContain('suv tegdi');
    const move = await db.query.boxMovements.findFirst({
      where: and(eq(boxMovements.boxId, minted[0]!.id), eq(boxMovements.cause, 'marked_lost')),
    });
    expect(move).toBeTruthy();
    const note = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(eq(notifications.type, 'BoxLost'), eq(notifications.userId, sellerId)),
      );
    expect(note.length).toBe(1);

    // Terminal is terminal: a second write-off is refused, not restated.
    await expect(
      markBoxLost({ boxId: minted[0]!.id, reason: 'yana', atWarehouseId: whOrigin }, ctx()),
    ).rejects.toMatchObject({ code: 'box_not_here' });
  });

  it('refuses a carton standing in ANOTHER warehouse, whatever the caller claims', async () => {
    // The bin scan authorises at the SCREEN's warehouse and resolves the code
    // globally, so without this fence a Yiwu operator typing a Tashkent code
    // wrote off cargo in another country — with the audit row naming that
    // country and that client's seller told their goods were destroyed.
    const { boxes: minted } = await mintReceipt({ boxes: 1, kg: '9', m3: '0.1' });
    await expect(
      markBoxLost(
        { boxId: minted[0]!.id, reason: 'boshqa skladdan', atWarehouseId: whCustoms },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'box_not_here' });
    expect(
      (await db.query.boxes.findFirst({ where: eq(boxes.id, minted[0]!.id) }))?.status,
    ).toBe('in_stock');
  });

  it('tells the LOGIST even when the cargo has no seller — his one stated requirement', async () => {
    // 1,402 of 1,692 active clients carry no sales manager, and unclaimed
    // cargo carries no client at all. Hanging the logist's copy off the
    // seller's made «xabar logistga ketadi» silent for exactly the cargo most
    // likely to be crushed and forgotten.
    const [orphan] = await db
      .insert(clients)
      .values({ clientCode: `WCO${STAMP}`.slice(0, 10), name: `WC orphan ${STAMP}`, salesManagerId: null })
      .returning();
    const [receipt] = await db
      .insert(receipts)
      .values({
        warehouseId: whOrigin,
        clientId: orphan!.id,
        status: 'confirmed',
        confirmedAt: new Date(),
        createdBy: authorId,
      })
      .returning();
    madeReceipts.push(receipt!.id);
    const [lot] = await db
      .insert(receiptLots)
      .values({
        receiptId: receipt!.id,
        seq: 1,
        letter: 'B',
        dimsMode: 'mixed',
        productNameZh: '孤儿货',
        boxCount: 1,
        totalWeightKg: '5',
        totalVolumeM3: '0.1',
      })
      .returning();
    const [box] = await db
      .insert(boxes)
      .values({
        lotId: lot!.id,
        shortCode: `WCX${STAMP}-0`,
        seqInLot: 1,
        status: 'in_stock',
        currentWarehouseId: whOrigin,
      })
      .returning();

    const planners = await usersWithPermission('plans.manage');
    const before = planners.length
      ? (
          await db
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(eq(notifications.type, 'BoxLost'), inArray(notifications.userId, planners)),
            )
        ).length
      : 0;
    await markBoxLost(
      { boxId: box!.id, reason: `singan ${STAMP}`, atWarehouseId: whOrigin },
      { actorId: authorId, ip: null, userAgent: null },
    );
    const after = planners.length
      ? (
          await db
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(eq(notifications.type, 'BoxLost'), inArray(notifications.userId, planners)),
            )
        ).length
      : 0;
    // A seeded database has plans.manage holders; a bare one does not, and the
    // assertion must say something either way rather than passing by accident.
    expect(after - before).toBe(planners.filter((id) => id !== authorId).length);
    await db.update(clients).set({ active: false }).where(eq(clients.id, orphan!.id));
  });

  it('refuses cargo that is on a truck — the missing flow owns that', async () => {
    const { boxes: minted } = await mintReceipt({ boxes: 1, kg: '8', m3: '0.1' });
    const batch = await mintBatch('in_transit');
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentBatchId: batch.id })
      .where(eq(boxes.id, minted[0]!.id));
    await expect(
      markBoxLost({ boxId: minted[0]!.id, reason: 'yo‘qoldi', atWarehouseId: whOrigin }, ctx()),
    ).rejects.toMatchObject({ code: 'box_not_here' });
  });
});

describe('editLot — the measure correction (owner’s 5b)', () => {
  it('stays locked for the author once a box left, opens for receipts.void, and the COUNT stays locked for everybody', async () => {
    const { receiptId, lotId, boxes: minted } = await mintReceipt({ boxes: 2, kg: '100', m3: '1.5' });
    const batch = await mintBatch('in_transit');
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentBatchId: batch.id })
      .where(eq(boxes.id, minted[0]!.id));

    const edit = (over: Partial<{ boxCount: number; totalWeightKg: number }>, actor: Actor) =>
      editLot(
        {
          lotId,
          productNameZh: '测试货',
          productNameRu: '',
          boxCount: over.boxCount ?? 2,
          totalWeightKg: over.totalWeightKg ?? 100,
          totalVolumeM3: 1.5,
          note: null,
        } as Parameters<typeof editLot>[0],
        actor,
        ctx(),
      );

    // The author (same-day creator) may still open the form — the measure is
    // what the lock refuses them now.
    await expect(edit({ totalWeightKg: 180 }, authorActor())).rejects.toMatchObject({
      code: 'structural_locked',
    });
    // The manager corrects the measure on the record…
    await edit({ totalWeightKg: 180 }, managerActor());
    const lot = await db.query.receiptLots.findFirst({ where: eq(receiptLots.id, lotId) });
    expect(Number(lot?.totalWeightKg)).toBe(180);
    // …and the receipt's author is told what changed over their head.
    const note = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, 'ReceiptMeasureCorrected'),
          eq(notifications.userId, authorId),
        ),
      );
    expect(note.length).toBe(1);
    // The box COUNT is a fact the truck and the labels agree on — locked even
    // for the manager while any box is away.
    await expect(edit({ boxCount: 3 }, managerActor())).rejects.toMatchObject({
      code: 'structural_locked',
    });
    void receiptId;
  });
});
