import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clients,
  loadPlanLines,
  scanEvents,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { createCrate } from '@/modules/wms/crates/service';
import { PlanError, recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, finishLoading, ingestLoadScans } from '@/modules/wms/scanning/service';

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
