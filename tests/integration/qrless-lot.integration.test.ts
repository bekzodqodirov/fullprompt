import 'dotenv/config';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  boxes,
  clientNotices,
  clients,
  receiptLots,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { confirmReceipt, type ConfirmReceiptInput } from '@/modules/wms/receipts/service';
import { EditError, editLot, setLotQrSkipped } from '@/modules/wms/receipts/edit';
import { labelsForReceipt, recordLabelPrint } from '@/modules/wms/labels/sheet';
import { qrlessBoxSql } from '@/modules/wms/labels/qrless-sql';
import {
  confirmQrLabelled,
  lotQrState,
  qrlessCountsAt,
  qrlessLabelsAt,
  qrlessLotsAt,
  QrlessError,
} from '@/modules/wms/labels/qrless';
import { acceptFoundBox, inventorySnapshot, reconcileInventory } from '@/modules/wms/inventory/service';
import { createCrate } from '@/modules/wms/crates/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, loadScanInTx } from '@/modules/wms/scanning/service';
import { cancelBatch, landUnloadInput } from '@/modules/wms/scanning/unload';

/**
 * «QR yopishtirilmadi» (0112, the owner's Q8) through the real doors: the
 * wizard's confirm, the receipt card's switch, the receipt's own sheet, the
 * print-later sheet and its «stikerlar yopishtirildi», the lot form, and the
 * stocktake that must never write a stickerless carton off.
 *
 * Its own two warehouses (a Chinese origin, an Uzbek distribution one) and its
 * own clients; the warehouses are DEACTIVATED at the end, never deleted
 * (audit_log FK). The cargo stays — it is data, not configuration (#183).
 */

const S = String(Date.now()).slice(-6);
const W = { a: '', b: '' };
const codeOf = { a: `QSA${S}`, b: `QSB${S}` };
let actorId: string;
let otherUserId: string;
const madeClients: string[] = [];
const madeBatches: string[] = [];
const ctx = () => ({ actorId });

/** An Actor for a service that takes one; scope is unscoped unless given. */
function actorWith(perms: string[], opts: { id?: string; warehouseIds?: string[] } = {}): Actor {
  return {
    id: opts.id ?? actorId,
    fullName: 'QR-siz test',
    permissions: new Set(perms),
    warehouseScoped: Boolean(opts.warehouseIds),
    warehouseIds: opts.warehouseIds ?? [],
  } as unknown as Actor;
}
/** The warehouse floor: prints a prixod's stickers, edits its own same day. */
const operator = () => actorWith(['receipts.create', 'receipts.edit', 'scan.load']);
/** A manager: may change a lot whose cartons have left the shelf. */
const manager = () => actorWith(['receipts.create', 'receipts.edit', 'receipts.void', 'scan.load']);
/** The count door (plans.manage) — may stamp a PLANNED carton too. */
const logist = () => actorWith(['receipts.create', 'receipts.edit', 'receipts.void', 'plans.manage']);

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, batchPrefix: code, name: `QR-siz ${code}`, country, type, timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  return row!.id;
}

let seq = 0;
interface Made {
  receiptId: string;
  lots: { lotId: string; boxes: { id: string; code: string }[] }[];
}
async function mkReceipt(lots: { count: number; qrSkipped?: boolean }[], warehouseId = W.a): Promise<Made> {
  seq += 1;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `QS${seq}${S}`.slice(0, 10), name: `QR-siz ${seq} ${S}` })
    .returning({ id: clients.id });
  madeClients.push(client!.id);
  const receiptId = uuidv4();
  const lotIds = lots.map(() => uuidv4());
  for (const lotId of lotIds) {
    await db.insert(attachments).values({
      entityType: 'receipt_lot',
      entityId: lotId,
      kind: 'photo',
      storageKey: `qrsiz/${lotId}`,
      fileName: 'x.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
      uploadedBy: actorId,
    });
  }
  const input: ConfirmReceiptInput = {
    receiptId,
    warehouseId,
    clientId: client!.id,
    unclaimedMarking: '',
    lots: lots.map((lot, i) => ({
      id: lotIds[i]!,
      productNameZh: `无码货${seq}`,
      boxCount: lot.count,
      dimsMode: 'uniform' as const,
      boxLengthCm: 50,
      boxWidthCm: 40,
      boxHeightCm: 30,
      boxWeightKg: 10,
      ...(lot.qrSkipped ? { qrSkipped: true } : {}),
    })),
    extraCosts: [],
  };
  await confirmReceipt(input, ctx());
  const out: Made = { receiptId, lots: [] };
  for (const lotId of lotIds) {
    const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(boxes.seqInLot);
    out.lots.push({ lotId, boxes: rows.map((b) => ({ id: b.id, code: b.shortCode })) });
  }
  return out;
}

async function qrlessIds(lotId: string): Promise<string[]> {
  const rows = await db
    .select({ id: boxes.id })
    .from(boxes)
    .where(and(eq(boxes.lotId, lotId), qrlessBoxSql()))
    .orderBy(boxes.seqInLot);
  return rows.map((row) => row.id);
}

async function planTruck(lotId: string, take: number) {
  const sub = await submitPlan(
    { originWarehouseId: W.a, destWarehouseId: W.b, lines: [{ lotId, boxCount: take }] } as never,
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' } as never, ctx());
  madeBatches.push(batch!.id);
  return batch!;
}

const manual = (batchId: string, code: string, manualReason: string) => ({
  clientEventUuid: uuidv4(),
  batchId,
  code,
  method: 'manual' as const,
  manualReason,
  addedOnSpot: false,
  scannedAt: new Date().toISOString(),
});

async function boxRow(id: string) {
  return (await db.select().from(boxes).where(eq(boxes.id, id)))[0]!;
}

async function receiptAudits(receiptId: string, action: 'update' | 'label_print') {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, receiptId), eq(auditLog.action, action)))
    .orderBy(desc(auditLog.createdAt));
}

beforeAll(async () => {
  const people = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(2);
  actorId = people[0]!.id;
  otherUserId = people[1]!.id;
  W.a = await mintWarehouse(codeOf.a, 'CN', 'origin');
  W.b = await mintWarehouse(codeOf.b, 'UZ', 'distribution');
});

afterAll(async () => {
  for (const id of madeBatches) {
    // A truck that never left goes back to the shelf; one that did stays.
    await cancelBatch(id, 'qrsiz test', ctx()).catch(() => {});
  }
  // The count-accept landing claims a «yukingiz keldi»; the notice drain's
  // queue is read by later files.
  if (madeClients.length) await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(W)));
  await pgClient.end();
});

describe('the marker at the door (I1)', () => {
  it('a ticked lot is QR-siz on every carton, and the receipt’s own sheet leaves it out', async () => {
    const made = await mkReceipt([{ count: 3, qrSkipped: true }, { count: 2 }]);
    const [marked, plain] = made.lots;
    const lots = await db.select().from(receiptLots).where(inArray(receiptLots.id, [marked!.lotId, plain!.lotId]));
    expect(lots.find((l) => l.id === marked!.lotId)!.qrSkippedAt).not.toBeNull();
    expect(lots.find((l) => l.id === plain!.lotId)!.qrSkippedAt).toBeNull();
    expect(await qrlessIds(marked!.lotId)).toEqual(marked!.boxes.map((b) => b.id));
    expect(await qrlessIds(plain!.lotId)).toEqual([]);

    // The receipt's sheet prints the plain lot alone, and nothing for the marked one.
    const sheet = await labelsForReceipt(made.receiptId, {});
    expect(sheet!.labels.map((l) => l.shortCode).sort()).toEqual(plain!.boxes.map((b) => b.code).sort());
    expect(await labelsForReceipt(made.receiptId, { lotId: marked!.lotId })).toBeNull();
    expect(await labelsForReceipt(made.receiptId, { boxId: marked!.boxes[0]!.id })).toBeNull();

    // …and the create audit says which lot went in stickerless.
    const [create] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, made.receiptId), eq(auditLog.action, 'create')));
    const auditedLots = (create!.after as { lots: { qrSkipped?: boolean }[] }).lots;
    expect(auditedLots.map((l) => Boolean(l.qrSkipped))).toEqual([true, false]);
  });
});

describe('the switch on the receipt card (I2, I3)', () => {
  it('marking a printed lot takes its stickers back, names them, and a second press writes nothing', async () => {
    const made = await mkReceipt([{ count: 3 }]);
    const lot = made.lots[0]!;
    const sheet = (await labelsForReceipt(made.receiptId, {}))!;
    await recordLabelPrint(ctx(), sheet, sheet.labels.map((l) => l.shortCode));
    expect(await qrlessIds(lot.lotId)).toEqual([]);

    const first = await setLotQrSkipped({ lotId: lot.lotId, skipped: true }, operator(), ctx());
    expect(first).toEqual({ changed: true, reverted: 3 });
    expect(await qrlessIds(lot.lotId)).toEqual(lot.boxes.map((b) => b.id));
    const updates = await receiptAudits(made.receiptId, 'update');
    expect(updates).toHaveLength(1);
    const after = updates[0]!.after as { qrSkipped: string; qrReverted: number; qrRevertedCodes: string[] };
    expect(after.qrReverted).toBe(3);
    expect(after.qrRevertedCodes.sort()).toEqual(lot.boxes.map((b) => b.code).sort());

    // Already QR-siz on every live carton: a no-op, and no audit row.
    expect(await setLotQrSkipped({ lotId: lot.lotId, skipped: true }, operator(), ctx())).toEqual({
      changed: false,
      reverted: 0,
    });
    expect(await receiptAudits(made.receiptId, 'update')).toHaveLength(1);

    // Unmarking makes them «expect a scan» again; twice is once.
    expect((await setLotQrSkipped({ lotId: lot.lotId, skipped: false }, operator(), ctx())).changed).toBe(true);
    expect(await qrlessIds(lot.lotId)).toEqual([]);
    expect((await setLotQrSkipped({ lotId: lot.lotId, skipped: false }, operator(), ctx())).changed).toBe(false);
    expect(await receiptAudits(made.receiptId, 'update')).toHaveLength(2);
  });

  it('the creator changes it while the cartons are on the shelf; once planned, only the count door', async () => {
    const made = await mkReceipt([{ count: 3 }]);
    const lot = made.lots[0]!;
    // Somebody else's receipt is not the operator's to change.
    await expect(
      setLotQrSkipped({ lotId: lot.lotId, skipped: true }, actorWith(['receipts.edit'], { id: otherUserId }), ctx()),
    ).rejects.toThrow(new EditError('edit_window_closed'));
    expect((await setLotQrSkipped({ lotId: lot.lotId, skipped: true }, operator(), ctx())).changed).toBe(true);

    await planTruck(lot.lotId, 2);
    await expect(setLotQrSkipped({ lotId: lot.lotId, skipped: false }, operator(), ctx())).rejects.toThrow(
      new EditError('structural_locked'),
    );
    // A manager's `receipts.void` no longer opens it: unmarking a PLANNED lot
    // is «yuklash tugadi»'s dropQrless by another door (review access-1).
    await expect(setLotQrSkipped({ lotId: lot.lotId, skipped: false }, manager(), ctx())).rejects.toThrow(
      new EditError('structural_locked'),
    );
    expect((await db.select().from(receiptLots).where(eq(receiptLots.id, lot.lotId)))[0]!.qrSkippedAt).not.toBeNull();
    expect((await setLotQrSkipped({ lotId: lot.lotId, skipped: false }, logist(), ctx())).changed).toBe(true);
  });

  it('a lot on the road is flipped only by the count door at BOTH ends of its truck', async () => {
    const made = await mkReceipt([{ count: 3 }]);
    const lot = made.lots[0]!;
    const truck = await planTruck(lot.lotId, 3);
    for (const box of lot.boxes) {
      await db.transaction((tx) => loadScanInTx(tx, { ...manual(truck.id, box.code, 'sticker_lost') }, actorId, {}));
    }
    await finishLoading(truck.id, ctx());
    await departBatch(truck.id, ctx());
    // The origin's manager — or the origin's logist alone — must not re-mark
    // cargo the destination is about to scan with its stickers on.
    const originManager = actorWith(['receipts.create', 'receipts.edit', 'receipts.void'], { warehouseIds: [W.a] });
    const originLogist = actorWith(['receipts.create', 'receipts.edit', 'plans.manage'], { warehouseIds: [W.a] });
    for (const who of [originManager, originLogist]) {
      await expect(setLotQrSkipped({ lotId: lot.lotId, skipped: true }, who, ctx())).rejects.toThrow(
        new EditError('structural_locked'),
      );
    }
    expect((await db.select().from(receiptLots).where(eq(receiptLots.id, lot.lotId)))[0]!.qrSkippedAt).toBeNull();
    expect((await setLotQrSkipped({ lotId: lot.lotId, skipped: true }, logist(), ctx())).changed).toBe(true);
  });
});

describe('printing later, where the cartons STAND (I4)', () => {
  it('the sheet is the warehouse’s, the press stamps what the sheet drew, the audit is the printer’s', async () => {
    const made = await mkReceipt([{ count: 3, qrSkipped: true }]);
    const lot = made.lots[0]!;
    // One sack walked to Tashkent without a truck.
    await acceptFoundBox({ warehouseId: W.b, code: lot.boxes[2]!.code }, ctx());

    const atA = (await qrlessLabelsAt(W.a, { lotId: lot.lotId }, operator()))!;
    expect(atA.boxIds).toEqual([lot.boxes[0]!.id, lot.boxes[1]!.id]);
    expect(atA.total).toBe(2);
    const atB = (await qrlessLabelsAt(W.b, { lotId: lot.lotId }, operator()))!;
    expect(atB.boxIds).toEqual([lot.boxes[2]!.id]);
    // The sticker printed in Tashkent says where the cargo was RECEIVED.
    expect(atB.hereCode).toBe(codeOf.b);
    expect(atB.labels[0]!.warehouseCode).toBe(codeOf.a);
    expect(atB.labels[0]!.shortCode).toBe(lot.boxes[2]!.code);

    const countsA = await qrlessCountsAt([W.a, W.b], operator());
    expect(countsA.find((c) => c.warehouseId === W.b)?.n).toBeGreaterThanOrEqual(1);

    // Every id of the lot posted at the origin: the one standing elsewhere is skipped.
    const at = await confirmQrLabelled(W.a, lot.boxes.map((b) => b.id), operator(), ctx());
    expect(at).toEqual({ labelled: 2, skipped: 1 });
    expect((await qrlessLabelsAt(W.a, { lotId: lot.lotId }, operator()))!.labels).toEqual([]);
    expect(await qrlessIds(lot.lotId)).toEqual([lot.boxes[2]!.id]);

    // A person scoped to the origin cannot stamp Tashkent's carton…
    await expect(
      confirmQrLabelled(W.b, [lot.boxes[2]!.id], actorWith(['receipts.create'], { warehouseIds: [W.a] }), ctx()),
    ).rejects.toThrow(new QrlessError('forbidden'));
    // …the person standing there can, and the row is written at THEIR warehouse.
    expect(await confirmQrLabelled(W.b, [lot.boxes[2]!.id], operator(), ctx())).toEqual({ labelled: 1, skipped: 0 });
    expect(await qrlessIds(lot.lotId)).toEqual([]);

    const prints = await receiptAudits(made.receiptId, 'label_print');
    expect(prints).toHaveLength(2);
    const byWarehouse = new Map(prints.map((row) => [row.warehouseId, row.after as Record<string, unknown>]));
    expect(byWarehouse.get(W.a)).toMatchObject({ qrless: true, count: 2, at: codeOf.a });
    expect(byWarehouse.get(W.b)).toMatchObject({ qrless: true, count: 1, at: codeOf.b });

    // The receipt card reads «labelled later» off the same stamps.
    const state = (await lotQrState([lot.lotId], operator())).get(lot.lotId)!;
    expect(state).toMatchObject({ qrlessLive: 0, labelledLater: 3, printableAt: [] });
  });

  it('a planned carton is the count door’s to stamp — an operator’s press leaves it QR-siz', async () => {
    const made = await mkReceipt([{ count: 3, qrSkipped: true }]);
    const lot = made.lots[0]!;
    await planTruck(lot.lotId, 2);
    const planned = [lot.boxes[0]!.id, lot.boxes[1]!.id];
    expect((await boxRow(planned[0]!)).status).toBe('planned');

    expect((await qrlessLabelsAt(W.a, { lotId: lot.lotId }, operator()))!.boxIds).toEqual([lot.boxes[2]!.id]);
    const rows = await qrlessLotsAt(W.a, operator());
    expect(rows.find((row) => row.lotId === lot.lotId)).toMatchObject({ n: 1, plannedLocked: 2 });

    // Posted anyway — the service asks again and stamps the shelf carton only.
    expect(await confirmQrLabelled(W.a, lot.boxes.map((b) => b.id), operator(), ctx())).toEqual({
      labelled: 1,
      skipped: 2,
    });
    expect(await qrlessIds(lot.lotId)).toEqual(planned);

    expect((await qrlessLabelsAt(W.a, { lotId: lot.lotId }, logist()))!.boxIds).toEqual(planned);
    expect(await confirmQrLabelled(W.a, planned, logist(), ctx())).toEqual({ labelled: 2, skipped: 0 });
    expect(await qrlessIds(lot.lotId)).toEqual([]);
  });
});

describe('a crate’s label stands in for its members (I5)', () => {
  it('crated cartons are never QR-siz, never on the sheet, and counted apart', async () => {
    const made = await mkReceipt([{ count: 4, qrSkipped: true }]);
    const lot = made.lots[0]!;
    await createCrate(
      {
        crateId: uuidv4(),
        warehouseId: W.a,
        boxIds: [lot.boxes[0]!.id, lot.boxes[1]!.id],
        kind: 'yashik',
        logistApproved: true,
      },
      ctx(),
    );
    expect(await qrlessIds(lot.lotId)).toEqual([lot.boxes[2]!.id, lot.boxes[3]!.id]);
    expect((await qrlessLabelsAt(W.a, { lotId: lot.lotId }, operator()))!.boxIds).toEqual([
      lot.boxes[2]!.id,
      lot.boxes[3]!.id,
    ]);
    const row = (await qrlessLotsAt(W.a, operator())).find((r) => r.lotId === lot.lotId);
    expect(row).toMatchObject({ n: 2, crated: 2 });
  });
});

describe('the stocktake never writes them off (I6, decision 33)', () => {
  it('a QR-siz carton is flagged, kept even when posted, and named as kept', async () => {
    const made = await mkReceipt([{ count: 2, qrSkipped: true }, { count: 2 }]);
    const [marked, plain] = made.lots;
    const mine = [...marked!.boxes, ...plain!.boxes];

    const snapshot = await inventorySnapshot(W.a);
    const flags = new Map(snapshot.boxes.map((b) => [b.boxId, b.qrless]));
    expect(marked!.boxes.map((b) => flags.get(b.id))).toEqual([true, true]);
    expect(plain!.boxes.map((b) => flags.get(b.id))).toEqual([false, false]);

    const summary = await reconcileInventory(
      { warehouseId: W.a, foundHereCodes: [], lostBoxIds: mine.map((b) => b.id), scannedCount: 0 },
      { canMarkLost: true },
      ctx(),
    );
    expect(summary.lost.sort()).toEqual(plain!.boxes.map((b) => b.code).sort());
    expect(summary.qrlessKept.sort()).toEqual(marked!.boxes.map((b) => b.code).sort());
    expect(summary.countKept).toEqual([]);
    for (const b of marked!.boxes) expect((await boxRow(b.id)).status).toBe('in_stock');
    for (const b of plain!.boxes) expect((await boxRow(b.id)).status).toBe('lost');
  });

  it('a carton the office counted off a truck is kept too — its last scan was a count', async () => {
    const made = await mkReceipt([{ count: 2 }]);
    const lot = made.lots[0]!;
    const truck = await planTruck(lot.lotId, 2);
    for (const box of lot.boxes) {
      const ack = await db.transaction((tx) =>
        loadScanInTx(tx, manual(truck.id, box.code, 'count_load'), actorId, {
          door: 'count_load',
          boxId: box.id,
          quietSpot: true,
        }),
      );
      expect(ack.result).toBe('ok');
    }
    await finishLoading(truck.id, ctx());
    await departBatch(truck.id, ctx());
    const landed = await db.transaction((tx) =>
      landUnloadInput(tx, manual(truck.id, lot.boxes[0]!.code, 'count_accept'), actorId, new Set(), {
        door: 'count_accept',
        boxId: lot.boxes[0]!.id,
        quietSpot: true,
      }),
    );
    expect(landed.result).toBe('ok');
    const box = await boxRow(lot.boxes[0]!.id);
    expect(box.currentWarehouseId).toBe(W.b);

    const snapshot = await inventorySnapshot(W.b);
    const row = snapshot.boxes.find((b) => b.boxId === lot.boxes[0]!.id)!;
    expect([row.qrless, row.countMoved]).toEqual([false, true]);

    const summary = await reconcileInventory(
      { warehouseId: W.b, foundHereCodes: [], lostBoxIds: [lot.boxes[0]!.id], scannedCount: 0 },
      { canMarkLost: true },
      ctx(),
    );
    expect(summary.lost).toEqual([]);
    expect(summary.countKept).toEqual([lot.boxes[0]!.code]);
    expect((await boxRow(lot.boxes[0]!.id)).status).toBe(box.status);
  });
});

describe('the lot form on a QR-siz lot (I10)', () => {
  it('growing mints QR-siz cartons with nothing to print; shrinking tears off no sticker that never was', async () => {
    const made = await mkReceipt([{ count: 3, qrSkipped: true }]);
    const lot = made.lots[0]!;
    const form = (boxCount: number) => ({
      lotId: lot.lotId,
      productNameZh: '无码货',
      boxCount,
      boxLengthCm: 50,
      boxWidthCm: 40,
      boxHeightCm: 30,
      boxWeightKg: 10,
    });
    const grown = await editLot(form(5), manager(), ctx());
    expect(grown.labelsToPrint).toBe(0);
    expect(await qrlessIds(lot.lotId)).toHaveLength(5);
    const shrunk = await editLot(form(4), manager(), ctx());
    expect(shrunk.labelsToDestroy).toEqual([]);

    // The control: an ordinary lot still prints what it grew.
    const plain = await mkReceipt([{ count: 2 }]);
    const plainGrow = await editLot({ ...form(3), lotId: plain.lots[0]!.lotId }, manager(), ctx());
    expect(plainGrow.labelsToPrint).toBe(1);
  });
});
