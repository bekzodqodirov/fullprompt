import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxes,
  clients,
  crates,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt, voidReceipt } from '@/modules/wms/receipts/service';
import { createCrate, dissolveCrate } from '@/modules/wms/crates/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ingestLoadScans } from '@/modules/wms/scanning/service';
import { buildManifestXlsx } from '@/modules/wms/documents/manifest-xlsx';
import { buildPackingXlsx } from '@/modules/wms/documents/ved-xlsx';
import {
  batchMemberFilter,
  closeBatch,
  finishUnload,
  ingestUnloadScans,
  remainingToUnload,
  resolveMissing,
  unloadRemaining,
} from '@/modules/wms/scanning/unload';

/** M4: unload reconciliation per spec 6.5 — acceptance tests 13/14 core. */

const WH_O = 'M4STO';
const WH_D = 'M4STD';
/** The real Uzbekistan destination is a distribution warehouse, not an origin. */
const WH_DIST = 'M4DIS';
let originId: string;
let destId: string;
let distId: string;
let actorId: string;
let clientId: string;
const ctx = () => ({ actorId });

async function makeLot(boxCount: number, warehouseId = originId) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `m4test/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '转运货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 40,
          boxWidthCm: 40,
          boxHeightCm: 40,
          boxWeightKg: 7,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
  return { lotId, boxIds: rows.map((b) => b.id), shortCodes: rows.map((b) => b.shortCode) };
}

function scan(batchId: string, code: string, extra: Record<string, unknown> = {}) {
  return {
    clientEventUuid: uuidv4(),
    batchId,
    code,
    method: 'qr' as const,
    scannedAt: new Date().toISOString(),
    ...extra,
  };
}

/** Full M3 path: plan → approve → load all → depart. Returns the batch. */
async function departedBatch(
  planCount: number,
  lot: Awaited<ReturnType<typeof makeLot>>,
  destination?: string,
) {
  const sub = await submitPlan(
    {
      originWarehouseId: originId,
      destWarehouseId: destination ?? destId,
      lines: [{ lotId: lot.lotId, boxCount: planCount }],
    },
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
  for (const code of lot.shortCodes.slice(0, planCount)) {
    const [ack] = await ingestLoadScans([{ ...scan(batch!.id, code), addedOnSpot: false }], ctx());
    expect(ack!.result).toBe('ok');
  }
  await departBatch(batch!.id, ctx());
  return batch!;
}

beforeAll(async () => {
  async function ensureWarehouse(code: string, type = 'origin'): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `M4 ${code}`, country: 'CN', type, timezone: 'Asia/Shanghai', batchPrefix: code })
      .returning();
    return wh!.id;
  }
  originId = await ensureWarehouse(WH_O);
  destId = await ensureWarehouse(WH_D);
  distId = await ensureWarehouse(WH_DIST, 'distribution');
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const suffix = String(Date.now()).slice(-6);
  const [c] = await db.insert(clients).values({ clientCode: `M4${suffix}`, name: 'M4 client' }).returning();
  clientId = c!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('unload reconciliation', () => {
  it('manifest scan lands in stock at destination; replay idempotent; duplicate soft', async () => {
    const lot = await makeLot(2);
    const batch = await departedBatch(2, lot);

    const first = scan(batch.id, lot.shortCodes[0]!);
    let [ack] = await ingestUnloadScans([first], ctx());
    expect(ack!.result).toBe('ok');
    [ack] = await ingestUnloadScans([first], ctx());
    expect(ack!.detail).toBe('replay');
    [ack] = await ingestUnloadScans([scan(batch.id, lot.shortCodes[0]!)], ctx());
    expect(ack!.result).toBe('duplicate');

    const row = (await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[0]!)))[0]!;
    expect(row.status).toBe('in_stock');
    expect(row.currentWarehouseId).toBe(destId);
    expect(row.currentBatchId).toBeNull();

    // Batch flipped to arrived on first scan
    expect(
      (await db.query.batches.findFirst({ where: eq(batches.id, batch.id) }))?.status,
    ).toBe('arrived');

    // Second box unscanned → finish flags missing_in_transit
    // Closing over cartons nobody scanned declares them lost, which is a
    // manager act since the corrections round — this is that path.
    const summary = await finishUnload(batch.id, ctx(), { mayCloseWithMissing: true });
    expect(summary.missing).toEqual([lot.shortCodes[1]!]);
    const missingRow = (await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[1]!)))[0]!;
    expect(missingRow.status).toBe('in_transit');
    expect(missingRow.flags).toContain('missing_in_transit');

    // Resolve: found at origin → back to origin stock
    await resolveMissing({ boxId: lot.boxIds[1]!, resolution: 'found_at_origin' }, ctx());
    const resolved = (await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[1]!)))[0]!;
    expect(resolved.status).toBe('in_stock');
    expect(resolved.currentWarehouseId).toBe(originId);
    expect(resolved.flags).toEqual([]);

    const closed = await closeBatch(batch.id, ctx());
    expect(closed.status).toBe('closed');
  });

  it('edge case 4: known box not on manifest is auto-transferred here, flagged', async () => {
    const lot = await makeLot(1);
    const batch = await departedBatch(1, lot);
    // A rogue box that officially sits at the ORIGIN warehouse in stock
    const rogue = await makeLot(1);

    const [ack] = await ingestUnloadScans([scan(batch.id, rogue.shortCodes[0]!)], ctx());
    expect(ack!.result).toBe('auto_transfer');

    const row = (await db.select().from(boxes).where(eq(boxes.id, rogue.boxIds[0]!)))[0]!;
    expect(row.status).toBe('in_stock');
    expect(row.currentWarehouseId).toBe(destId);
    expect(row.flags).toContain('undocumented_transfer');

    // Unknown code
    const [unknown] = await ingestUnloadScans([scan(batch.id, 'ZZ99-999999')], ctx());
    expect(unknown!.result).toBe('unknown_code');
  });
});

/**
 * Owner's report: cargo arrived at the Uzbekistan warehouse, boxes were
 * accepted by hand, the screen never moved, and finishing the unload declared
 * the whole truck "missing in transit".
 */
describe('accepting cargo at a distribution destination (owner bug round)', () => {
  it('an accepted box stays on the batch snapshot instead of vanishing', async () => {
    const lot = await makeLot(3);
    const batch = await departedBatch(3, lot, distId);

    const before = await db.select({ id: boxes.id }).from(boxes).where(batchMemberFilter(batch.id));
    expect(before).toHaveLength(3);

    const [ack] = await ingestUnloadScans([scan(batch.id, lot.shortCodes[0]!)], ctx());
    expect(ack!.result).toBe('ok');

    // The regression: the box used to disappear the moment it was accepted,
    // so the counter fell from 0/3 to 0/2 instead of rising to 1/3.
    const after = await db
      .select({ id: boxes.id, status: boxes.status })
      .from(boxes)
      .where(batchMemberFilter(batch.id));
    expect(after).toHaveLength(3);
    expect(after.filter((b) => b.status !== 'in_transit')).toHaveLength(1);
  });

  it('lands cargo in ready_for_pickup, which the screen must read as accepted', async () => {
    const lot = await makeLot(1);
    const batch = await departedBatch(1, lot, distId);

    await ingestUnloadScans([scan(batch.id, lot.shortCodes[0]!)], ctx());
    const row = (await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[0]!)))[0]!;
    expect(row.status).toBe('ready_for_pickup');
    expect(row.currentWarehouseId).toBe(distId);
    expect(await remainingToUnload(batch.id)).toHaveLength(0);
  });

  it('accept-all takes the whole truck in; finishing then reports nothing missing', async () => {
    const lot = await makeLot(4);
    const batch = await departedBatch(4, lot, distId);

    await ingestUnloadScans([scan(batch.id, lot.shortCodes[0]!)], ctx());
    expect(await remainingToUnload(batch.id)).toHaveLength(3);

    const bulk = await unloadRemaining(batch.id, ctx());
    expect(bulk.accepted).toBe(3);
    expect(await remainingToUnload(batch.id)).toHaveLength(0);

    // Pressing it again must not write a second round of scan events.
    expect((await unloadRemaining(batch.id, ctx())).accepted).toBe(0);

    // Closing over cartons nobody scanned declares them lost, which is a
    // manager act since the corrections round — this is that path.
    const summary = await finishUnload(batch.id, ctx(), { mayCloseWithMissing: true });
    expect(summary.missing).toEqual([]);
    const rows = await db.select().from(boxes).where(batchMemberFilter(batch.id));
    expect(rows.every((b) => b.status === 'ready_for_pickup')).toBe(true);
    expect(rows.every((b) => b.currentWarehouseId === distId)).toBe(true);
  });

  it('a box resolved as found here lands exactly where a scanned one lands', async () => {
    const lot = await makeLot(2);
    const batch = await departedBatch(2, lot, distId);

    await ingestUnloadScans([scan(batch.id, lot.shortCodes[0]!)], ctx());
    await finishUnload(batch.id, ctx(), { mayCloseWithMissing: true });
    await resolveMissing({ boxId: lot.boxIds[1]!, resolution: 'found_here' }, ctx());

    const resolved = (await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[1]!)))[0]!;
    // Used to be in_stock — the client would never have seen it as ready.
    expect(resolved.status).toBe('ready_for_pickup');
    expect(resolved.currentWarehouseId).toBe(distId);
    expect(resolved.flags).toEqual([]);
  });

  it('refuses to bulk-accept a batch that is not being unloaded', async () => {
    const lot = await makeLot(1);
    const batch = await departedBatch(1, lot, distId);
    await unloadRemaining(batch.id, ctx());
    await finishUnload(batch.id, ctx(), { mayCloseWithMissing: true });
    await expect(unloadRemaining(batch.id, ctx())).rejects.toThrow('batch_not_unloading');
  });
});

/**
 * The customs papers are regenerated at the border and after arrival —
 * exactly when unloading has already cleared `current_batch_id` box by box.
 * Documents that read the live pointer came out EMPTY at the one moment the
 * export agent needed them; membership must be what DEPARTED.
 */
describe('customs documents after unload (audit defect)', () => {
  it('the manifest and packing list still list every box after a full unload', async () => {
    const lot = await makeLot(2);
    const batch = await departedBatch(2, lot, distId);
    await unloadRemaining(batch.id, ctx());
    await finishUnload(batch.id, ctx(), { mayCloseWithMissing: true });
    // The state the documents are regenerated in: no live pointers left.
    expect(await db.select().from(boxes).where(eq(boxes.currentBatchId, batch.id))).toHaveLength(0);

    const open = async (buffer: Buffer) => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      return workbook;
    };

    const manifest = await open((await buildManifestXlsx(batch.id))!);
    const detailTexts: string[] = [];
    manifest.worksheets[1]!.eachRow((row) => detailTexts.push(JSON.stringify(row.values)));
    for (const code of lot.shortCodes) {
      expect(detailTexts.join('\n')).toContain(code);
    }

    const packing = (await open((await buildPackingXlsx(batch.id))!)).worksheets[0]!;
    // Last row is the totals row; column 5 is the box count.
    expect(Number(packing.getRow(packing.rowCount).getCell(5).value)).toBe(2);
  });
});

/**
 * Voiding a receipt used to void its boxes in WHATEVER state they were:
 * cargo on a departed truck became unscannable at unload, and cargo already
 * handed to the client was un-happened on paper.
 */
describe('receipt void guard (audit defect)', () => {
  it('refuses to void a receipt whose cargo already left the shelf', async () => {
    const lot = await makeLot(1);
    await departedBatch(1, lot);
    const [lotRow] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.lotId));

    await expect(voidReceipt(lotRow!.receiptId, 'kech qoldik', ctx())).rejects.toThrow(
      'box_not_in_stock',
    );

    // The throw rolls the whole transaction back: receipt and box untouched.
    const receipt = await db.query.receipts.findFirst({
      where: eq(receipts.id, lotRow!.receiptId),
    });
    expect(receipt!.voidedAt).toBeNull();
    expect(receipt!.status).not.toBe('voided');
    expect((await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[0]!)))[0]!.status).toBe(
      'in_transit',
    );
  });

  it('still voids a receipt whose boxes are all on the shelf', async () => {
    const good = await makeLot(1);
    const [goodLot] = await db.select().from(receiptLots).where(eq(receiptLots.id, good.lotId));
    await voidReceipt(goodLot!.receiptId, 'xato kiritilgan', ctx());
    expect((await db.select().from(boxes).where(eq(boxes.id, good.boxIds[0]!)))[0]!.status).toBe(
      'void',
    );
  });
});

describe('a crate arrives (round 31)', () => {
  it('the crate’s warehouse follows its boxes, and journey flags retire on landing', async () => {
    /**
     * crates.warehouse_id was written once at packing and never again, so an
     * arrived yashik could neither be planned onward from where it really
     * stands nor counted at inventory there — and the origin's count sheet
     * went on listing it. The box flags are the same story: added_on_spot
     * describes ONE trip, and a box that kept it was printing last truck's
     * deviation on the next truck's manifest.
     */
    const lot = await makeLot(2);
    const crateId = uuidv4();
    const crate = await createCrate(
      { crateId, warehouseId: originId, boxIds: lot.boxIds, kind: 'yashik', logistApproved: true },
      ctx(),
    );
    const sub = await submitPlan(
      { originWarehouseId: originId, destWarehouseId: destId, lines: [], crateIds: [crateId] },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    const [loadAck] = await ingestLoadScans(
      [{ ...scan(batch!.id, crate.code), addedOnSpot: false }],
      ctx(),
    );
    expect(loadAck!.result).toBe('ok');
    await departBatch(batch!.id, ctx());
    // A leftover journey flag rides in — landing must retire it.
    await db.update(boxes).set({ flags: ['added_on_spot'] }).where(eq(boxes.id, lot.boxIds[0]!));

    const [ack] = await ingestUnloadScans([scan(batch!.id, crate.code)], ctx());
    expect(ack!.result).toBe('ok');

    const after = (await db.query.crates.findFirst({ where: eq(crates.id, crateId) }))!;
    expect(after.warehouseId).toBe(destId);
    const landed = await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[0]!));
    expect(landed[0]!.flags).toEqual([]);
    // …and the crate can now be dissolved WHERE IT IS.
    const { boxCount } = await dissolveCrate(crateId, ctx());
    expect(boxCount).toBe(2);
  });

  it('a member left at the origin is NOT teleported by the crate scan (round 31)', async () => {
    /**
     * The audit's unload-side twin of #221. C is damaged at the door, so A
     * and B are scanned individually and finish-loading short-loads C back to
     * the shelf — WITH its crateId, because no per-box un-crate exists. The
     * crate scan at the destination used to "reality-wins" C here: the client
     * was told three boxes arrived while C is physically in China, Yiwu stock
     * lost it, and C was immediately issuable at Tashkent. The crate label
     * vouches for the crate, not for boxes nobody saw.
     */
    const lot = await makeLot(3);
    const crateId = uuidv4();
    const crate = await createCrate(
      { crateId, warehouseId: originId, boxIds: lot.boxIds, kind: 'yashik', logistApproved: true },
      ctx(),
    );
    const sub = await submitPlan(
      { originWarehouseId: originId, destWarehouseId: destId, lines: [], crateIds: [crateId] },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    for (const code of lot.shortCodes.slice(0, 2)) {
      const [a] = await ingestLoadScans([{ ...scan(batch!.id, code), addedOnSpot: false }], ctx());
      expect(a!.result).toBe('ok');
    }
    await finishLoading(batch!.id, ctx());
    await departBatch(batch!.id, ctx());

    const [ack] = await ingestUnloadScans([scan(batch!.id, crate.code)], ctx());
    expect(ack!.result).toBe('ok');
    expect(ack!.boxes).toHaveLength(2);
    // The shortage is NAMED, so the screen can say "2 of 3, C stayed behind".
    expect(ack!.notArrived).toEqual([lot.shortCodes[2]!]);

    // C is still on the Yiwu shelf — not moved, not announced to the client.
    const c = (await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[2]!)))[0]!;
    expect(c.status).toBe('in_stock');
    expect(c.currentWarehouseId).toBe(originId);
    // The pair that really rode the truck landed normally.
    const landed = await db.select().from(boxes).where(inArray(boxes.id, lot.boxIds.slice(0, 2)));
    expect(landed.every((b) => b.status === 'in_stock' && b.currentWarehouseId === destId)).toBe(
      true,
    );
  });
});
