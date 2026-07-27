import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxes,
  boxMovements,
  clients,
  clientTransactions,
  costEntries,
  costTypes,
  driverDevices,
  loadPlanLines,
  loadPlans,
  scanEvents,
  tasks,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { createCrate } from '@/modules/wms/crates/service';
import {
  PlanError,
  cancelPlan,
  recordVerdict,
  renameBatch,
  submitPlan,
} from '@/modules/wms/planning/service';
import {
  ScanError,
  departBatch,
  finishLoading,
  ingestLoadScans,
} from '@/modules/wms/scanning/service';
import { cancelBatch } from '@/modules/wms/scanning/unload';
import { batchRegister } from '@/modules/wms/reports/queries';
import { devicesForBatch } from '@/modules/wms/tracking/devices';

/** M3: plan → verdict loop → batch reservation → scan → finish → depart. */

const WH_O = 'M3STO';
const WH_D = 'M3STD';
let originId: string;
let destId: string;
let actorId: string;
let clientId: string;
const ctx = () => ({ actorId });

async function makeLot(boxCount: number) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `m3test/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId: originId,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '货物',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 50,
          boxWidthCm: 40,
          boxHeightCm: 30,
          boxWeightKg: 10,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
  return { lotId, boxIds: rows.map((b) => b.id), shortCodes: rows.map((b) => b.shortCode) };
}

function scan(batchId: string, code: string, extra: Partial<Parameters<typeof ingestLoadScans>[0][0]> = {}) {
  return {
    clientEventUuid: uuidv4(),
    batchId,
    code,
    method: 'qr' as const,
    addedOnSpot: false,
    scannedAt: new Date().toISOString(),
    ...extra,
  };
}

beforeAll(async () => {
  async function ensureWarehouse(code: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `M3 ${code}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
      .returning();
    return wh!.id;
  }
  originId = await ensureWarehouse(WH_O);
  destId = await ensureWarehouse(WH_D);
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const suffix = String(Date.now()).slice(-6);
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `M3${suffix}`, name: 'M3 client' })
    .returning();
  clientId = c!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('plan lifecycle', () => {
  it('partial plan → changes_requested → v2 → approved reserves lowest-seq boxes', async () => {
    const lot = await makeLot(10);

    // Over-asking fails
    await expect(
      submitPlan(
        { originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId: lot.lotId, boxCount: 11 }] },
        ctx(),
      ),
    ).rejects.toThrowError(PlanError);

    const v1 = await submitPlan(
      { originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId: lot.lotId, boxCount: 6 }] },
      ctx(),
    );
    expect(v1.plan.status).toBe('pending_agent');
    expect(v1.version.versionNo).toBe(1);
    expect(Number(v1.version.totalKg)).toBe(60);

    const cr = await recordVerdict(
      { versionId: v1.version.id, verdict: 'changes_requested', comment: 'remove some' },
      ctx(),
    );
    expect(cr.plan.status).toBe('changes_requested');
    expect(cr.batch).toBeNull();

    const v2 = await submitPlan(
      {
        planId: v1.plan.id,
        originWarehouseId: originId,
        destWarehouseId: destId,
        lines: [{ lotId: lot.lotId, boxCount: 5 }],
      },
      ctx(),
    );
    expect(v2.version.versionNo).toBe(2);

    const approved = await recordVerdict({ versionId: v2.version.id, verdict: 'approved' }, ctx());
    expect(approved.plan.status).toBe('approved');
    expect(approved.batch!.code).toMatch(new RegExp(`^${WH_O}-\\d{3}$`));

    // The driver's pairing code is born with the batch (owner) — the loader
    // reads it off the batch header instead of pressing a button at the gate.
    const bornWith = await devicesForBatch(approved.batch!.id);
    expect(bornWith).toHaveLength(1);
    expect(bornWith[0]!.pairCode).toMatch(/^[A-Z2-9]{6}$/);

    const reserved = await db
      .select()
      .from(boxes)
      .where(inArray(boxes.id, lot.boxIds));
    const planned = reserved.filter((b) => b.status === 'planned');
    expect(planned).toHaveLength(5);
    // Lowest seq first
    expect(planned.map((b) => b.seqInLot).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(reserved.filter((b) => b.status === 'in_stock')).toHaveLength(5);

    // Double-verdict blocked
    await expect(
      recordVerdict({ versionId: v2.version.id, verdict: 'approved' }, ctx()),
    ).rejects.toThrowError(new PlanError('verdict_already_recorded'));
  });

  it('reserved boxes cannot be double-planned by a second plan', async () => {
    const lot = await makeLot(3);
    const p1 = await submitPlan(
      { originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId: lot.lotId, boxCount: 3 }] },
      ctx(),
    );
    await recordVerdict({ versionId: p1.version.id, verdict: 'approved' }, ctx());
    await expect(
      submitPlan(
        { originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId: lot.lotId, boxCount: 1 }] },
        ctx(),
      ),
    ).rejects.toThrowError(PlanError);
  });
});

describe('load scanning', () => {
  async function approvedBatch(boxCount: number, planCount: number) {
    const lot = await makeLot(boxCount);
    const sub = await submitPlan(
      { originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId: lot.lotId, boxCount: planCount }] },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    return { lot, batch: batch! };
  }

  /**
   * A batch whose plan covers a CRATE — the shape the warehouse actually
   * loads. `withStray` puts one extra box inside the crate that the plan does
   * not reserve, which is what happens when a box is added to a crate after
   * the plan was approved.
   */
  async function approvedCrateBatch(planCount: number, opts: { withStray?: boolean } = {}) {
    const lot = await makeLot(planCount + (opts.withStray ? 1 : 0));
    const inCrate = lot.boxIds.slice(0, planCount);
    const crateId = uuidv4();
    const crate = await createCrate(
      { crateId, warehouseId: originId, boxIds: inCrate, kind: 'yashik', logistApproved: true },
      ctx(),
    );
    // A crate plans WHOLE — `crateIds` is how the planner says "this box goes
    // as one place" (feedback round 5). The stray, if any, is added to the
    // crate AFTER approval, which is exactly how it happens in the warehouse.
    const sub = await submitPlan(
      {
        originWarehouseId: originId,
        destWarehouseId: destId,
        lines: [],
        crateIds: [crateId],
      },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());

    let strayCode: string | undefined;
    if (opts.withStray) {
      // Dropped into the crate after the plan was approved — the packer fits
      // one more box in and the paperwork never hears about it.
      const leftover = lot.boxIds.filter((id) => !inCrate.includes(id));
      await db.update(boxes).set({ crateId }).where(inArray(boxes.id, leftover));
      const rows = await db.select().from(boxes).where(inArray(boxes.id, leftover));
      strayCode = rows[0]?.shortCode;
    }
    return { batch: batch!, lot: { ...lot, crateCode: crate.code }, strayCode };
  }

  it('scan ok → duplicate soft; replay idempotent; finish reverts short-loaded; depart', async () => {
    const { lot, batch } = await approvedBatch(4, 3);
    const plannedCodes = lot.shortCodes.slice(0, 3);

    const first = scan(batch.id, plannedCodes[0]!);
    let [ack] = await ingestLoadScans([first], ctx());
    expect(ack!.result).toBe('ok');

    // Same event uuid replay → ok (no double row)
    [ack] = await ingestLoadScans([first], ctx());
    expect(ack!.detail).toBe('replay');
    const events = await db.select().from(scanEvents).where(eq(scanEvents.batchId, batch.id));
    expect(events).toHaveLength(1);

    // New uuid, same box → business duplicate
    [ack] = await ingestLoadScans([scan(batch.id, plannedCodes[0]!)], ctx());
    expect(ack!.result).toBe('duplicate');

    [ack] = await ingestLoadScans([scan(batch.id, plannedCodes[1]!)], ctx());
    expect(ack!.result).toBe('ok');

    // Finish: 1 planned box unscanned → back to stock
    const summary = await finishLoading(batch.id, ctx());
    expect(summary.loaded).toBe(2);
    expect(summary.shortLoaded).toBe(1);

    const departed = await departBatch(batch.id, ctx());
    expect(departed.boxCount).toBe(2);
    const after = await db.select().from(boxes).where(inArray(boxes.id, lot.boxIds));
    expect(after.filter((b) => b.status === 'in_transit')).toHaveLength(2);
    expect(after.filter((b) => b.status === 'in_stock')).toHaveLength(2);
  });

  it('not-on-plan needs confirmation, then loads flagged', async () => {
    const { batch } = await approvedBatch(2, 2);
    const stray = await makeLot(1); // not on the plan

    let [ack] = await ingestLoadScans([scan(batch.id, stray.shortCodes[0]!)], ctx());
    expect(ack!.result).toBe('not_on_plan');

    [ack] = await ingestLoadScans(
      [scan(batch.id, stray.shortCodes[0]!, { addedOnSpot: true, addedReason: 'boss said load it' })],
      ctx(),
    );
    expect(ack!.result).toBe('ok');
    const flagged = await db
      .select()
      .from(scanEvents)
      .where(eq(scanEvents.batchId, batch.id));
    expect(flagged.some((e) => e.addedOnSpot)).toBe(true);
  });

  it('refuses a crate that is not on this plan, and writes NOTHING', async () => {
    /**
     * The owner's live report: "scann qilganda sanayabti lekin mashinaga
     * qoshmayabti". A crate standing at the origin but belonging to another
     * truck was offered by the loading snapshot, accepted unconditionally by
     * the phone, refused here — and the refusal had no handler on screen, so
     * the box was counted, the outbox dropped the scan, and a re-scan said
     * "already scanned". The server half is asserted here: the verdict is
     * `not_on_plan` and the boxes must be untouched, so the phone's rollback
     * has something true to roll back TO.
     */
    const { batch } = await approvedBatch(2, 2);
    const stray = await makeLot(2);
    const crateId = uuidv4();
    const crate = await createCrate(
      { crateId, warehouseId: originId, boxIds: stray.boxIds, kind: 'yashik', logistApproved: true },
      ctx(),
    );

    const before = await db.select().from(boxes).where(inArray(boxes.id, stray.boxIds));
    const [ack] = await ingestLoadScans([scan(batch.id, crate.code)], ctx());
    expect(ack!.result).toBe('not_on_plan');
    // The phone needs the code back as a CRATE to re-open its confirm dialog.
    expect(ack!.scannedCode).toBe(crate.code);

    const after = await db.select().from(boxes).where(inArray(boxes.id, stray.boxIds));
    expect(after.map((b) => b.status)).toEqual(before.map((b) => b.status));
    expect(after.every((b) => b.currentBatchId === null)).toBe(true);
    // And nothing was recorded against the batch either.
    const events = await db.select().from(scanEvents).where(eq(scanEvents.crateId, crateId));
    expect(events).toHaveLength(0);
  });

  it('a crate half-loaded by a retry is still on the plan', async () => {
    /**
     * The regression the warehouse hit mid-load: "1 scan qilib ketidan
     * noto'g'ri deyabti va umuman ishlamayabti".
     *
     * `onPlan` demanded that EVERY member box still be `planned`. The moment
     * one of them is `loading` — an outbox retry over warehouse wifi, a second
     * phone on the same truck, or the operator simply scanning the crate
     * again — the crate stopped being "on the plan" and came back refused.
     * Before the loading screen learned to show refusals that was invisible;
     * once it showed them, the red confirm took over the screen and disabled
     * the scanner, and loading stopped dead.
     *
     * A box already loading on THIS batch is the same box on the same truck.
     */
    const { batch, lot } = await approvedCrateBatch(3);

    // One member gets loaded on its own first — exactly what a retry leaves
    // behind when the first ack never made it back to the phone.
    const [single] = await ingestLoadScans([scan(batch.id, lot.shortCodes[0]!)], ctx());
    expect(single!.result).toBe('ok');

    // Now the crate: two planned members, one already loading.
    const [ack] = await ingestLoadScans([scan(batch.id, lot.crateCode)], ctx());
    expect(ack!.result).toBe('ok');

    const after = await db.select().from(boxes).where(inArray(boxes.id, lot.boxIds));
    expect(after.every((b) => b.status === 'loading')).toBe(true);
    expect(after.every((b) => b.currentBatchId === batch.id)).toBe(true);
  });

  it('a planned crate holding one stray box still loads its planned boxes', async () => {
    /**
     * The second half of the same regression. `crates.boxShortCodes` in the
     * loading snapshot is every box PHYSICALLY in the crate, and the plan
     * reserves an exact count — so one box added to the crate after planning,
     * or a lot the planner did not list, made a legitimately planned crate
     * unscannable. The crate is one place and it is going on the truck; the
     * planned boxes must load, and the strays must be reported rather than
     * silently recorded.
     */
    const { batch, lot, strayCode } = await approvedCrateBatch(2, { withStray: true });

    const [ack] = await ingestLoadScans([scan(batch.id, lot.crateCode)], ctx());
    expect(ack!.result).toBe('ok');
    // The stray is named, so the screen can offer to add it on the spot.
    expect(ack!.unplanned).toContain(strayCode);

    const rows = await db.select().from(boxes).where(inArray(boxes.id, lot.boxIds));
    expect(rows.filter((b) => b.status === 'loading')).toHaveLength(2);
    // …and the stray is NOT on the truck until somebody says so.
    const stray = rows.find((b) => b.shortCode === strayCode);
    expect(stray?.status).not.toBe('loading');
  });

  it('crate scan fans out to member boxes with derived uuids', async () => {
    const { lot, batch } = await approvedBatch(3, 3);
    const crateId = uuidv4();
    // Crate the planned boxes (planned boxes are not in_stock — crate the
    // remaining stock instead: make a fresh lot, crate it, then plan it? For
    // fan-out semantics it's enough to crate in_stock boxes and load them
    // on-spot.)
    const stray = await makeLot(2);
    const crate = await createCrate(
      { crateId, warehouseId: originId, boxIds: stray.boxIds, kind: 'yashik', logistApproved: true },
      ctx(),
    );
    const [ack] = await ingestLoadScans(
      [scan(batch.id, crate.code, { addedOnSpot: true, addedReason: 'crate on spot' })],
      ctx(),
    );
    expect(ack!.result).toBe('ok');
    expect(ack!.boxes).toHaveLength(2);
    const events = await db
      .select()
      .from(scanEvents)
      .where(eq(scanEvents.crateId, crateId));
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.clientEventUuid)).size).toBe(2);
    void lot;
  });
});

describe('crate = one place (owner feedback round 5)', () => {
  it('crated boxes leave loose availability; crate plans whole and reserves its exact boxes', async () => {
    const lot = await makeLot(6);
    const crateId = uuidv4();
    // Crate boxes 3..6 (seq 3,4,5,6) — leaves 2 loose.
    const crate = await createCrate(
      { crateId, warehouseId: originId, boxIds: lot.boxIds.slice(2), kind: 'yashik', logistApproved: true },
      ctx(),
    );

    // Loose availability is now 2: asking 3 loose must fail.
    await expect(
      submitPlan(
        { originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId: lot.lotId, boxCount: 3 }] },
        ctx(),
      ),
    ).rejects.toThrowError(PlanError);

    const sub = await submitPlan(
      {
        originWarehouseId: originId,
        destWarehouseId: destId,
        lines: [{ lotId: lot.lotId, boxCount: 1 }],
        crateIds: [crateId],
      },
      ctx(),
    );
    // Two lines for the same lot: one loose, one carrying the crate.
    const lines = await db
      .select()
      .from(loadPlanLines)
      .where(eq(loadPlanLines.versionId, sub.version.id));
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.crateId === crateId)?.plannedBoxCount).toBe(4);
    expect(lines.find((l) => l.crateId === null)?.plannedBoxCount).toBe(1);
    expect(sub.version.totalBoxes).toBe(5);

    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    const after = await db.select().from(boxes).where(inArray(boxes.id, lot.boxIds));
    const planned = after.filter((b) => b.status === 'planned');
    expect(planned).toHaveLength(5);
    // The crate's 4 boxes exactly (seq 3-6) + the lowest loose seq (1).
    expect(planned.map((b) => b.seqInLot).sort((a, b) => a - b)).toEqual([1, 3, 4, 5, 6]);
    expect(planned.filter((b) => b.crateId === crateId)).toHaveLength(4);
    expect(batch).not.toBeNull();
    void crate;
  });

  it('a crate at another warehouse or already planned is rejected', async () => {
    const lot = await makeLot(2);
    const crateId = uuidv4();
    await createCrate(
      { crateId, warehouseId: originId, boxIds: lot.boxIds, kind: 'yashik', logistApproved: true },
      ctx(),
    );
    const sub = await submitPlan(
      { originWarehouseId: originId, destWarehouseId: destId, lines: [], crateIds: [crateId] },
      ctx(),
    );
    await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    // Boxes are now planned → the same crate cannot go into a second plan.
    await expect(
      submitPlan(
        { originWarehouseId: originId, destWarehouseId: destId, lines: [], crateIds: [crateId] },
        ctx(),
      ),
    ).rejects.toThrowError(PlanError);
  });
});

/** Owner: "YW-001/002 comes from the warehouse — let me type it myself." */
describe('renaming a batch', () => {
  async function newBatch(boxCount: number) {
    const lot = await makeLot(boxCount);
    const sub = await submitPlan(
      {
        originWarehouseId: originId,
        destWarehouseId: destId,
        lines: [{ lotId: lot.lotId, boxCount }],
      },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    return { lot, batch: batch! };
  }

  it('accepts a manual code before departure and refuses one that is taken', async () => {
    const { batch } = await newBatch(2);
    const wanted = `GSR-KASHGAR ${String(Date.now()).slice(-6)}`;

    // Trimmed, inner spaces collapsed, uppercased — so a near-duplicate
    // cannot hide behind whitespace or case.
    const renamed = await renameBatch(batch.id, `  ${wanted.toLowerCase()}  `, ctx());
    expect(renamed.code).toBe(wanted);

    const other = await newBatch(1);
    await expect(renameBatch(other.batch.id, wanted.toLowerCase(), ctx())).rejects.toThrow(
      'code_taken',
    );
    // Saving its own code again is a no-op, not a clash with itself.
    expect((await renameBatch(batch.id, wanted, ctx())).code).toBe(wanted);

    await expect(renameBatch(batch.id, 'X', ctx())).rejects.toThrow('bad_code');
  });

  it('locks the code once the truck has left', async () => {
    const { lot, batch } = await newBatch(1);
    for (const code of lot.shortCodes) {
      await ingestLoadScans([{ ...scan(batch.id, code), addedOnSpot: false }], ctx());
    }
    await departBatch(batch.id, ctx());
    await expect(renameBatch(batch.id, 'TOO-LATE', ctx())).rejects.toThrow('batch_departed');
  });
});

/**
 * The customs paperwork is bilingual RU/EN, which nearly went out broken: a
 * label with a slash was used as an Excel TAB name, and Excel rejects "/" in
 * one — every manifest download answered 500. Generating each document here
 * catches that class of mistake without a browser.
 */
describe('customs documents still generate', () => {
  it('invoice, packing list, manifest, packing photos and the agent file', async () => {
    const { buildInvoiceXlsx, buildPackingXlsx } = await import(
      '@/modules/wms/documents/ved-xlsx'
    );
    const { buildManifestXlsx } = await import('@/modules/wms/documents/manifest-xlsx');
    const { buildPackingPhotosXlsx } = await import(
      '@/modules/wms/documents/packing-photos-xlsx'
    );
    const { buildAgentXlsx } = await import('@/modules/wms/documents/agent-xlsx');

    const lot = await makeLot(2);
    const sub = await submitPlan(
      {
        originWarehouseId: originId,
        destWarehouseId: destId,
        lines: [{ lotId: lot.lotId, boxCount: 2 }],
      },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    for (const code of lot.shortCodes) {
      await ingestLoadScans([{ ...scan(batch!.id, code), addedOnSpot: false }], ctx());
    }

    const isXlsx = (buffer: Buffer | null) => buffer?.subarray(0, 2).toString() === 'PK';
    expect(isXlsx(await buildInvoiceXlsx(batch!.id)), 'invoice').toBe(true);
    expect(isXlsx(await buildPackingXlsx(batch!.id)), 'packing list').toBe(true);
    expect(isXlsx(await buildManifestXlsx(batch!.id)), 'manifest').toBe(true);
    expect(isXlsx(await buildPackingPhotosXlsx(batch!.id)), 'packing photos').toBe(true);
    expect(
      isXlsx(await buildAgentXlsx(sub.plan.id, sub.version.versionNo)),
      'agent file',
    ).toBe(true);
  });
});

/**
 * Getting rid of a batch that never went anywhere.
 *
 * The owner's clear-out: "dev payitida productionga partiyalar planlar
 * yaratib qo'ygandim … endi shularni o'chira olmayabman." What matters here is
 * not that cancelling works — it is that everything it must refuse, it does,
 * because this button sits next to real trucks on the same board.
 */
describe('cancelling a batch that never left', () => {
  async function approvedBatchOf(boxCount: number) {
    const lot = await makeLot(boxCount);
    const sub = await submitPlan(
      { originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId: lot.lotId, boxCount }] },
      ctx(),
    );
    const approved = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    return { lot, planId: sub.plan.id, batch: approved.batch! };
  }

  it('gives every reserved box back to stock and takes the plan down with it', async () => {
    const { lot, planId, batch } = await approvedBatchOf(4);

    const result = await cancelBatch(batch.id, 'test partiya', ctx());
    expect(result.boxesReleased).toBe(4);
    expect(result.batch.status).toBe('cancelled');

    // The cargo is back on the shelf it never left — reserved boxes that stay
    // reserved against a dead batch are boxes nobody can plan again, and the
    // stock screen would go on showing them as spoken for.
    const after = await db.select().from(boxes).where(inArray(boxes.id, lot.boxIds));
    expect(after.every((b) => b.status === 'in_stock')).toBe(true);
    expect(after.every((b) => b.currentBatchId === null)).toBe(true);

    // Each release says why, in the same shape a short-loaded box gets.
    const moves = await db
      .select()
      .from(boxMovements)
      .where(and(eq(boxMovements.refId, batch.id), eq(boxMovements.cause, 'batch_cancelled')));
    expect(moves).toHaveLength(4);

    // The plan cannot go on claiming a batch that no longer forms.
    const plan = await db.query.loadPlans.findFirst({ where: eq(loadPlans.id, planId) });
    expect(plan!.status).toBe('cancelled');

    // And the driver's phone stops being able to report against it.
    const devices = await db
      .select()
      .from(driverDevices)
      .where(eq(driverDevices.batchId, batch.id));
    expect(devices.every((d) => d.revokedAt !== null)).toBe(true);
    expect(devices.every((d) => d.pairCode === null)).toBe(true);
  });

  it('refuses a batch that has already departed', async () => {
    // The one that matters most. Past this point the code is on the customs
    // papers and the boxes are between two countries — "give them back to
    // stock" would be a lie about where the cargo is.
    const { lot, batch } = await approvedBatchOf(2);
    await ingestLoadScans(
      lot.shortCodes.map((code) => scan(batch.id, code)),
      ctx(),
    );
    await finishLoading(batch.id, ctx());
    await departBatch(batch.id, ctx());

    await expect(cancelBatch(batch.id, 'peshmonlik', ctx())).rejects.toThrowError(
      new ScanError('batch_already_departed'),
    );
    // Nothing moved.
    const after = await db.select().from(boxes).where(inArray(boxes.id, lot.boxIds));
    expect(after.every((b) => b.status === 'in_transit')).toBe(true);
  });

  it('refuses a batch somebody has already put a cost on', async () => {
    const { batch } = await approvedBatchOf(2);
    const [costType] = await db.select().from(costTypes).limit(1);
    await db.insert(costEntries).values({
      scope: 'batch',
      batchId: batch.id,
      costTypeId: costType!.id,
      amount: '250.00',
      currency: 'USD',
      costDate: '2026-07-27',
      enteredBy: actorId,
    });

    await expect(cancelBatch(batch.id, 'tozalash', ctx())).rejects.toThrowError(
      new ScanError('batch_has_costs'),
    );
    // Still forming, still holding its boxes: a refusal must change nothing.
    const still = await db.query.batches.findFirst({ where: eq(batches.id, batch.id) });
    expect(still!.status).toBe('forming');
  });

  it('refuses a batch a client has already been charged for', async () => {
    const { batch } = await approvedBatchOf(2);
    await db.insert(clientTransactions).values({
      clientId,
      type: 'charge',
      amount: '100.00',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '100.00',
      txDate: '2026-07-27',
      batchId: batch.id,
      createdBy: actorId,
    });

    await expect(cancelBatch(batch.id, 'tozalash', ctx())).rejects.toThrowError(
      new ScanError('batch_has_charges'),
    );
  });

  it('closes the open work raised on it, and drops out of the register report', async () => {
    const { batch } = await approvedBatchOf(1);
    const [task] = await db
      .insert(tasks)
      .values({
        title: 'Check this truck',
        entityType: 'batch',
        entityId: batch.id,
        assigneeId: actorId,
        createdBy: actorId,
        dueAt: new Date(),
      })
      .returning();
    // The register has no status filter of its own, so a cancelled batch
    // would sit in it — and its XLSX — for ever, which is exactly the list the
    // owner was trying to clear.
    expect((await batchRegister()).some((r) => r.id === batch.id)).toBe(true);

    await cancelBatch(batch.id, 'test partiya', ctx());

    const after = await db.query.tasks.findFirst({ where: eq(tasks.id, task!.id) });
    expect(after!.status).toBe('cancelled');
    expect((await batchRegister()).some((r) => r.id === batch.id)).toBe(false);
  });

  it('demands a reason, like every other void in this system', async () => {
    const { batch } = await approvedBatchOf(1);
    await expect(cancelBatch(batch.id, '  ', ctx())).rejects.toThrowError(
      new ScanError('reason_required'),
    );
  });

  it('a voided cost does not keep a test batch alive for ever', async () => {
    // The mirror of the guard above: money that was itself cancelled must not
    // go on blocking, or one mistaken cost entry would pin a junk batch to the
    // board permanently.
    const { batch } = await approvedBatchOf(1);
    const [costType] = await db.select().from(costTypes).limit(1);
    await db.insert(costEntries).values({
      scope: 'batch',
      batchId: batch.id,
      costTypeId: costType!.id,
      amount: '10.00',
      currency: 'USD',
      costDate: '2026-07-27',
      enteredBy: actorId,
      voidedAt: new Date(),
      voidedBy: actorId,
      voidReason: 'wrong batch',
    });
    const result = await cancelBatch(batch.id, 'test partiya', ctx());
    expect(result.batch.status).toBe('cancelled');
  });
});

describe('cancelling a plan that never became a batch', () => {
  it('retires a draft the agent sent back and nobody picked up', async () => {
    const lot = await makeLot(2);
    const sub = await submitPlan(
      { originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId: lot.lotId, boxCount: 2 }] },
      ctx(),
    );
    await recordVerdict(
      { versionId: sub.version.id, verdict: 'changes_requested', comment: 'no' },
      ctx(),
    );
    const cancelled = await cancelPlan(sub.plan.id, 'test plan', ctx());
    expect(cancelled.status).toBe('cancelled');

    // Nothing was reserved before approval, so nothing had to be given back —
    // and the boxes must still be free to plan again.
    const after = await db.select().from(boxes).where(inArray(boxes.id, lot.boxIds));
    expect(after.every((b) => b.status === 'in_stock')).toBe(true);
  });

  it('refuses an approved plan — that is the batch’s job', async () => {
    // Two doors into the same room would be two chances to leave the boxes
    // reserved against a plan that no longer exists.
    const lot = await makeLot(2);
    const sub = await submitPlan(
      { originWarehouseId: originId, destWarehouseId: destId, lines: [{ lotId: lot.lotId, boxCount: 2 }] },
      ctx(),
    );
    await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    await expect(cancelPlan(sub.plan.id, 'test', ctx())).rejects.toThrowError(
      new PlanError('plan_has_batch'),
    );
  });
});
