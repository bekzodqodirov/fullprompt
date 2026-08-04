import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxes,
  clients,
  events,
  handovers,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import { ingestUnloadScans } from '@/modules/wms/scanning/unload';
import { issueBoxes } from '@/modules/wms/issue/service';
import { buildHandoverAct } from '@/modules/wms/documents/handover-act';
import { nextBatchCode } from '@/modules/wms/codes';
import { PDFDocument } from 'pdf-lib';

/** M5: ready_for_pickup at customs unload, issue-to-client, quick batch. */

const WH_O = 'M5STO';
const WH_C = 'M5STC'; // customs type
let originId: string;
let customsId: string;
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
    storageKey: `m5test/${lotId}`,
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
          productNameZh: '出口货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 30,
          boxWidthCm: 30,
          boxHeightCm: 30,
          boxWeightKg: 5,
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

beforeAll(async () => {
  async function ensureWarehouse(code: string, type: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `M5 ${code}`, country: 'UZ', type, timezone: 'Asia/Tashkent', batchPrefix: code })
      .returning();
    return wh!.id;
  }
  originId = await ensureWarehouse(WH_O, 'origin');
  customsId = await ensureWarehouse(WH_C, 'customs');
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const suffix = String(Date.now()).slice(-6);
  const [c] = await db.insert(clients).values({ clientCode: `M5${suffix}`, name: 'M5 client' }).returning();
  clientId = c!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('UZ side', () => {
  it('customs unload → ready_for_pickup + ReadyForPickup event; partial issue → issued + handover', async () => {
    const lot = await makeLot(2);
    const sub = await submitPlan(
      { originWarehouseId: originId, destWarehouseId: customsId, lines: [{ lotId: lot.lotId, boxCount: 2 }] },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    expect(batch!.type).toBe('export');
    for (const code of lot.shortCodes) {
      await ingestLoadScans([{ ...scan(batch!.id, code), addedOnSpot: false }], ctx());
    }
    await departBatch(batch!.id, ctx());
    for (const code of lot.shortCodes) {
      const [ack] = await ingestUnloadScans([scan(batch!.id, code)], ctx());
      expect(ack!.result).toBe('ok');
    }
    const landed = await db.select().from(boxes).where(eq(boxes.lotId, lot.lotId));
    expect(landed.every((b) => b.status === 'ready_for_pickup')).toBe(true);

    const readyEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.type, 'ReadyForPickup'), eq(events.entityId, batch!.id)));
    expect(readyEvents.length).toBeGreaterThan(0);

    // Partial issue: 1 of 2
    const handoverId = uuidv4();
    const handover = await issueBoxes(
      {
        handoverId,
        clientId,
        warehouseId: customsId,
        boxIds: [lot.boxIds[0]!],
        personName: 'Oluvchi Aka',
        personPhone: '+998901112233',
        debtOk: true,
      },
      ctx(),
    );
    expect(handover.kind).toBe('issued_to_client');

    // Idempotent replay
    const again = await issueBoxes(
      {
        handoverId,
        clientId,
        warehouseId: customsId,
        boxIds: [lot.boxIds[0]!],
        personName: 'Oluvchi Aka',
        personPhone: '+998901112233',
        debtOk: true,
      },
      ctx(),
    );
    expect(again.id).toBe(handover.id);

    const after = await db.select().from(boxes).where(eq(boxes.lotId, lot.lotId));
    expect(after.find((b) => b.id === lot.boxIds[0])!.status).toBe('issued');
    expect(after.find((b) => b.id === lot.boxIds[1])!.status).toBe('ready_for_pickup');
    const saved = await db.query.handovers.findFirst({ where: eq(handovers.id, handoverId) });
    expect(saved?.debtOk).toBe(true);
    expect(saved?.clientId).toBe(clientId);
  });

  /**
   * The act was drawn on exactly one A4 page: every row past ~33 was silently
   * discarded, and both sides signed an incomplete list. 50 rows × 17pt
   * physically exceed one page's row space, so a correct renderer MUST emit a
   * second page — page count is the decisive observable (pdf-lib cannot
   * extract text back).
   */
  it('the handover act paginates instead of truncating at one page', async () => {
    const lot = await makeLot(50);
    const handoverId = uuidv4();
    await issueBoxes(
      {
        handoverId,
        clientId,
        warehouseId: originId,
        boxIds: lot.boxIds,
        personName: 'Katta Oluvchi',
        personPhone: '+998901112233',
        debtOk: true,
      },
      ctx(),
    );

    const pdf = await buildHandoverAct(handoverId);
    const parsed = await PDFDocument.load(pdf!);
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('quick batch loads loose boxes without the not-on-plan ceremony', async () => {
    const lot = await makeLot(1);
    const origin = (await db.query.warehouses.findFirst({ where: eq(warehouses.id, originId) }))!;
    const batch = await db.transaction(async (tx) => {
      const code = await nextBatchCode(tx, origin);
      const [row] = await tx
        .insert(batches)
        .values({
          code,
          originWarehouseId: originId,
          destWarehouseId: customsId,
          type: 'distribution',
          status: 'forming',
          createdBy: actorId,
        })
        .returning();
      return row!;
    });
    const [ack] = await ingestLoadScans(
      [{ ...scan(batch.id, lot.shortCodes[0]!), addedOnSpot: false }],
      ctx(),
    );
    expect(ack!.result).toBe('ok');
    const row = (await db.select().from(boxes).where(eq(boxes.id, lot.boxIds[0]!)))[0]!;
    expect(row.status).toBe('loading');
    expect(row.flags).toEqual([]);
  });
});
