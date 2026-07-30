import 'dotenv/config';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxMovements,
  boxes,
  clients,
  dealStages,
  deals,
  events,
  notifications,
  receiptLots,
  receipts,
  roles,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { emitEvent } from '@/modules/platform/events/service';
import { processPendingEvents } from '@/modules/platform/notifications/service';
import { createClient } from '@/modules/platform/clients/service';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { finishUnload } from '@/modules/wms/scanning/unload';
import {
  createDeal,
  deleteDealStage,
  linkReceipt,
  listStages,
  moveDeal,
  reorderDealStages,
  saveDealStage,
} from '@/modules/wms/deals/service';

/**
 * Round 26, the owner's item 6: «yuk holati o'zgarishi bilan sdelka
 * varonkasida etaplarga avtomatik o'tadigan qilsa bo'ladimi?» — cargo events
 * through the REAL event worker, deals that move themselves, and the guards
 * that keep an automatic funnel honest: forward only, open deals only, never
 * into a lost stage.
 *
 * The stages this file mints carry cargo triggers, which makes them
 * CONFIGURATION (#183): while they exist, every processed cargo event obeys
 * them. So pending events left by earlier files are drained BEFORE the first
 * trigger stage is born (the automation file's discipline), and the stages
 * are deleted afterwards.
 */

const STAMP = Date.now();
/** Client codes allow 2–10 alphanumerics, so the code carries a short stamp. */
const CODE_STAMP = String(STAMP).slice(-7);
let actorId: string;
let warehouseId: string;
let clientId: string;
let otherClientId: string;
const ctx = () => ({ actorId });

let stReceived: { id: string; sortOrder: number };
let stDeparted: { id: string; sortOrder: number };
let stReady: { id: string; sortOrder: number };
let stPartial: { id: string; sortOrder: number };
let stHanded: { id: string; sortOrder: number };
const madeStages: string[] = [];
const madeDeals: string[] = [];
const madeReceipts: string[] = [];
const madeBatches: string[] = [];

/** The truck and the handovers this file pretends happened — `ref_id` carries
 * no foreign key (the movement log outlives its batches), so a minted uuid
 * behaves exactly like a real one. */
const fakeBatchId = uuidv4();
const fakeHandoverId = uuidv4();
const fakeHandover2Id = uuidv4();
const fakeHandover3Id = uuidv4();

async function stageOf(dealId: string): Promise<string> {
  const row = await db.query.deals.findFirst({ where: eq(deals.id, dealId) });
  return row!.stageId;
}

/** A confirmed one-box receipt, optionally already pointing at its deal. */
async function receiveCargo(dealId: string | null, forClient?: string): Promise<string> {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `astest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  const result = await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId: forClient ?? clientId,
      sourceNote: '',
      unclaimedMarking: '',
      dealId,
      lots: [
        {
          id: lotId,
          productNameZh: `自动阶段 ${STAMP}`,
          productNameRu: '',
          boxCount: 1,
          dimsMode: 'mixed',
          totalWeightKg: 10,
          totalVolumeM3: 0.1,
          note: '',
        },
      ],
      extraCosts: [],
    } as Parameters<typeof confirmReceipt>[0],
    ctx(),
  );
  madeReceipts.push(result.receiptId);
  return result.receiptId;
}

async function boxOf(receiptId: string): Promise<string> {
  const [row] = await db
    .select({ id: boxes.id })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(eq(receiptLots.receiptId, receiptId));
  return row!.id;
}

/** The movement row the real scan path writes — the fact the resolver reads. */
async function movement(boxId: string, cause: string, refType: string, refId: string) {
  await db.insert(boxMovements).values({
    boxId,
    fromWarehouseId: warehouseId,
    toWarehouseId: warehouseId,
    fromStatus: 'in_stock',
    toStatus: 'in_transit',
    cause,
    refType,
    refId,
    actorId,
  });
}

/** What the real issue path does: the movement row AND the box's own status —
 * `dealFullyIssued` reads the status, the resolver reads the movement. */
async function issueBox(boxId: string, handoverId: string) {
  await movement(boxId, 'issued', 'handover', handoverId);
  await db.update(boxes).set({ status: 'issued' }).where(eq(boxes.id, boxId));
}

beforeAll(async () => {
  const staff = await db
    .select({ id: users.id, code: roles.code })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(users.active, true));
  actorId = staff.find((row) => row.code === 'super_admin')!.id;
  warehouseId = (await db.select({ id: warehouses.id }).from(warehouses).limit(1))[0]!.id;

  // Earlier files leave THEIR events unprocessed. Drain them while no stage
  // carries a trigger yet, or an old receipt would move a deal this file
  // never meant to touch.
  await processPendingEvents();

  clientId = (
    await createClient(
      { clientCode: `AS${CODE_STAMP}`, name: `Avto etap ${STAMP}`, phones: [] },
      ctx(),
    )
  ).id;
  otherClientId = (
    await createClient(
      { clientCode: `AX${CODE_STAMP}`, name: `Boshqa avto ${STAMP}`, phones: [] },
      ctx(),
    )
  ).id;

  // The owner's funnel-with-triggers, far to the right of every seeded stage
  // so each move in this file is a FORWARD move.
  const mk = async (name: string, sortOrder: number, cargoTrigger: string) => {
    const row = await saveDealStage(
      {
        name: `${name} ${STAMP}`,
        kind: 'open',
        color: 'blue',
        sortOrder,
        active: true,
        cargoTrigger,
      } as Parameters<typeof saveDealStage>[0],
      ctx(),
    );
    madeStages.push(row.id);
    return { id: row.id, sortOrder: row.sortOrder };
  };
  stReceived = await mk('AS-qabul', 9100, 'received');
  stDeparted = await mk("AS-jo'nadi", 9200, 'departed');
  stReady = await mk('AS-tayyor', 9250, 'ready');
  stPartial = await mk('AS-qisman', 9280, 'handed_partial');
  stHanded = await mk('AS-topshirildi', 9300, 'handed');
});

afterAll(async () => {
  // Everything this file processed grew notification rows, and events hold
  // the FK they hang from — so notifications go first, then the events, then
  // the records, then the CONFIGURATION (stages last: deals point at them).
  // The fake batch and the clients carried events too (ReadyForPickup rides
  // on the batch, BoxIssued on the client).
  const entityIds = [
    ...madeReceipts,
    ...madeDeals,
    ...madeBatches,
    fakeBatchId,
    clientId,
    otherClientId,
  ].filter(Boolean);
  if (entityIds.length > 0) {
    const eventRows = await db
      .select({ id: events.id })
      .from(events)
      .where(inArray(events.entityId, entityIds));
    if (eventRows.length > 0) {
      await db.delete(notifications).where(
        inArray(notifications.eventId, eventRows.map((row) => row.id)),
      );
      await db.delete(events).where(inArray(events.id, eventRows.map((row) => row.id)));
    }
  }
  for (const id of madeReceipts) {
    const lots = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(eq(receiptLots.receiptId, id));
    const lotIds = lots.map((lot) => lot.id);
    if (lotIds.length > 0) {
      const rows = await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds));
      if (rows.length > 0) {
        await db.delete(boxMovements).where(inArray(boxMovements.boxId, rows.map((b) => b.id)));
        await db.delete(boxes).where(inArray(boxes.lotId, lotIds));
      }
      await db.delete(attachments).where(inArray(attachments.entityId, lotIds));
      await db.delete(receiptLots).where(eq(receiptLots.receiptId, id));
    }
    await db.delete(receipts).where(eq(receipts.id, id));
  }
  for (const id of madeDeals) await db.delete(deals).where(eq(deals.id, id));
  for (const id of madeBatches) await db.delete(batches).where(eq(batches.id, id));
  for (const id of madeStages) await db.delete(dealStages).where(eq(dealStages.id, id));
  // Filtered, so a beforeAll that died half-way still lets the rest clean up.
  const clientIds = [clientId, otherClientId].filter(Boolean);
  if (clientIds.length > 0) await db.delete(clients).where(inArray(clients.id, clientIds));
  await pgClient.end();
});

describe('the stage editor guards the funnel', () => {
  it('refuses a cargo trigger on a lost stage — only a person may lose a deal', async () => {
    await expect(
      saveDealStage(
        {
          name: `AS-lost ${STAMP}`,
          kind: 'lost',
          color: 'red',
          sortOrder: 9400,
          active: true,
          cargoTrigger: 'received',
        } as Parameters<typeof saveDealStage>[0],
        ctx(),
      ),
    ).rejects.toThrow('trigger_on_lost');
  });

  it('a save that would leave no won stage rolls back inside the transaction', async () => {
    const won = (await listStages()).find((stage) => stage.kind === 'won')!;
    await expect(
      saveDealStage(
        {
          id: won.id,
          name: won.name,
          kind: won.kind,
          color: won.color,
          sortOrder: won.sortOrder,
          active: false,
          cargoTrigger: null,
        } as Parameters<typeof saveDealStage>[0] & { id: string },
        ctx(),
      ),
    ).rejects.toThrow('needs_won');
    // The refusal must have UNDONE the write, not just complained after it.
    const after = await db.query.dealStages.findFirst({ where: eq(dealStages.id, won.id) });
    expect(after!.active).toBe(true);
  });
});

describe('cargo walks a deal through the funnel', () => {
  let dealId: string;
  let otherDealId: string;
  let receipt1: string;
  let receipt2: string;
  let otherReceipt: string;

  it('a confirmed receipt on the deal moves it to the received stage', async () => {
    dealId = await createDeal({ clientId, title: `AS ${STAMP}` }, ctx());
    madeDeals.push(dealId);
    receipt1 = await receiveCargo(dealId);
    await processPendingEvents();
    expect(await stageOf(dealId)).toBe(stReceived.id);

    // The second client's deal on the SAME truck, for the per-client tests.
    otherDealId = await createDeal({ clientId: otherClientId, title: `AS-x ${STAMP}` }, ctx());
    madeDeals.push(otherDealId);
    otherReceipt = await receiveCargo(otherDealId, otherClientId);
    await movement(await boxOf(receipt1), 'batch_departed', 'batch', fakeBatchId);
    await movement(await boxOf(otherReceipt), 'batch_departed', 'batch', fakeBatchId);
    await processPendingEvents();
  });

  it('departure moves every deal on the truck — resolved through the movement rows', async () => {
    await emitEvent(db, {
      type: 'BatchDeparted',
      payload: { batchId: fakeBatchId, code: `AS-${STAMP}`, boxCount: 2 },
      entityType: 'batch',
      entityId: fakeBatchId,
      actorId,
    });
    await processPendingEvents();
    expect(await stageOf(dealId)).toBe(stDeparted.id);
    expect(await stageOf(otherDealId)).toBe(stDeparted.id);
  });

  it('forward only: the same state arriving again never drags a deal back', async () => {
    // A second receipt lands on the job after the first truck left — the
    // owner's split-shipment reality, and exactly the case that would yo-yo
    // the funnel without the guard.
    receipt2 = await receiveCargo(dealId);
    await processPendingEvents();
    expect(await stageOf(dealId)).toBe(stDeparted.id);
  });

  it('ready-for-pickup is per CLIENT of the batch, not per truck', async () => {
    await emitEvent(db, {
      type: 'ReadyForPickup',
      payload: { clientId, warehouseId, warehouseCode: 'AS', batchCode: `AS-${STAMP}`, boxCount: 1 },
      entityType: 'batch',
      entityId: fakeBatchId,
      actorId,
    });
    await processPendingEvents();
    expect(await stageOf(dealId)).toBe(stReady.id);
    // The other client's cargo on the same truck was NOT announced ready.
    expect(await stageOf(otherDealId)).toBe(stDeparted.id);
  });

  it('the first handover of a split job parks the deal at «qisman topshirildi»', async () => {
    // One of the deal's two boxes goes out; the other is still in the
    // warehouse — the owner's rule: «o'sha yerda turadi hammasi
    // topshirilgungacha».
    await issueBox(await boxOf(receipt1), fakeHandoverId);
    await emitEvent(db, {
      type: 'BoxIssued',
      payload: { handoverId: fakeHandoverId, clientId, boxCount: 1 },
      entityType: 'client',
      entityId: clientId,
      actorId,
    });
    await processPendingEvents();
    expect(await stageOf(dealId)).toBe(stPartial.id);
    // A handover moves only what was actually issued: the other client's
    // deal saw none and stays put.
    expect(await stageOf(otherDealId)).toBe(stDeparted.id);
  });

  it('the LAST box hands the deal fully; a single-shipment deal skips the partial stop', async () => {
    await issueBox(await boxOf(receipt2), fakeHandover2Id);
    await emitEvent(db, {
      type: 'BoxIssued',
      payload: { handoverId: fakeHandover2Id, clientId, boxCount: 1 },
      entityType: 'client',
      entityId: clientId,
      actorId,
    });
    // The other client's ONE box goes out in one handover — everything is
    // issued at once, so the deal jumps straight past ready AND the partial
    // stop, from «jo'nadi» to «topshirildi».
    await issueBox(await boxOf(otherReceipt), fakeHandover3Id);
    await emitEvent(db, {
      type: 'BoxIssued',
      payload: { handoverId: fakeHandover3Id, clientId: otherClientId, boxCount: 1 },
      entityType: 'client',
      entityId: otherClientId,
      actorId,
    });
    await processPendingEvents();
    expect(await stageOf(dealId)).toBe(stHanded.id);
    expect(await stageOf(otherDealId)).toBe(stHanded.id);
  });

  it('a won deal is settled — cargo does not reopen it', async () => {
    const won = (await listStages()).find((stage) => stage.kind === 'won')!;
    const wonDealId = await createDeal({ clientId, title: `AS-won ${STAMP}` }, ctx());
    madeDeals.push(wonDealId);
    await moveDeal(wonDealId, won.id, ctx());
    await receiveCargo(wonDealId);
    await processPendingEvents();
    expect(await stageOf(wonDealId)).toBe(won.id);
  });

  it('linking cargo after the fact counts as received — where the owner starts', async () => {
    const lateDealId = await createDeal({ clientId, title: `AS-late ${STAMP}` }, ctx());
    madeDeals.push(lateDealId);
    const receiptId = await receiveCargo(null);
    // No event processing: the LINK itself is the trigger.
    await linkReceipt(receiptId, lateDealId, ctx());
    expect(await stageOf(lateDealId)).toBe(stReceived.id);
  });
});

describe('the editor reorders and removes (round 30)', () => {
  it('reorder rewrites the order; delete moves the deals somewhere first', async () => {
    const mk = async (name: string, sortOrder: number) => {
      const row = await saveDealStage(
        {
          name: `${name} ${STAMP}`,
          kind: 'open',
          color: 'gray',
          sortOrder,
          active: true,
          cargoTrigger: null,
        } as Parameters<typeof saveDealStage>[0],
        ctx(),
      );
      madeStages.push(row.id);
      return row;
    };
    const a = await mk('AS-ra', 9500);
    const b = await mk('AS-rb', 9600);

    // Exactly what the screen posts: the FULL list, with the two swapped.
    const before = await listStages(true);
    const ids = before.map((stage) => stage.id);
    const ia = ids.indexOf(a.id);
    const ib = ids.indexOf(b.id);
    [ids[ia], ids[ib]] = [ids[ib]!, ids[ia]!];
    await reorderDealStages(ids, ctx());
    const after = await listStages(true);
    expect(after.findIndex((s) => s.id === b.id)).toBeLessThan(
      after.findIndex((s) => s.id === a.id),
    );
    // Moved numbers moved BACK (#154): the funnel's order is CONFIGURATION.
    await reorderDealStages(before.map((stage) => stage.id), ctx());

    // Delete refuses nonsense, then moves the stage's deals before removing.
    const dealId = await createDeal({ clientId, title: `AS-del ${STAMP}` }, ctx());
    madeDeals.push(dealId);
    await moveDeal(dealId, a.id, ctx());
    await expect(deleteDealStage(a.id, a.id, ctx())).rejects.toThrow('same_stage');
    await deleteDealStage(a.id, b.id, ctx());
    expect(await stageOf(dealId)).toBe(b.id);

    // And B goes too — a deleted stage's deals land on a real column, and no
    // throwaway configuration outlives the test.
    const home = (await listStages()).find(
      (stage) => stage.kind === 'open' && !madeStages.includes(stage.id),
    )!;
    await deleteDealStage(b.id, home.id, ctx());
    expect(await stageOf(dealId)).toBe(home.id);
  });
});

describe('the warehouse announces the unload', () => {
  it('finishUnload emits BatchUnloaded — the trigger that was declared but never fired', async () => {
    const dest = (
      await db.select({ id: warehouses.id }).from(warehouses).where(ne(warehouses.id, warehouseId)).limit(1)
    )[0]!.id;
    const [batch] = await db
      .insert(batches)
      .values({
        code: `ASB-${STAMP}`,
        originWarehouseId: warehouseId,
        destWarehouseId: dest,
        status: 'in_transit',
        createdBy: actorId,
      })
      .returning();
    madeBatches.push(batch!.id);

    await finishUnload(batch!.id, { actorId, ip: null, userAgent: null });

    const emitted = await db
      .select()
      .from(events)
      .where(and(eq(events.entityId, batch!.id), eq(events.type, 'BatchUnloaded')));
    expect(emitted.length).toBe(1);
    expect((emitted[0]!.payload as { batchCode: string }).batchCode).toBe(`ASB-${STAMP}`);
    // Leave nothing pending behind this file (#183's spirit for events).
    await processPendingEvents();
  });
});
