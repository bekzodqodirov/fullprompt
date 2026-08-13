import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clientNotices,
  clients,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import { finishUnload, ingestUnloadScans } from '@/modules/wms/scanning/unload';
import {
  NOTICE_ARRIVED,
  arrivedSummary,
  dueArrivalNotices,
} from '@/modules/wms/notices/arrival';

/**
 * Round 98: «mashinadan yuk tushganda yukingiz keldi deb har bir karobka uchun
 * habar jonatyabti».
 *
 * The client's arrival message is claimed once per (client, truck) and sent
 * later with the totals as they really are. These tests exercise the whole
 * road — receipt, plan, load, depart, unload — because the defect lived in the
 * seam between the per-scan transaction and the customer's inbox, and nothing
 * short of walking it can see that seam.
 */

const WH_O = 'N8STO';
const WH_C = 'N8STC'; // customs → landed boxes become ready_for_pickup
let originId: string;
let customsId: string;
let actorId: string;
let clientId: string;
const ctx = () => ({ actorId });

/** Uniform boxes: 5 kg and 0.027 m³ each, so a share is checkable by hand. */
async function makeLot(boxCount: number) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `n8test/${lotId}`,
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
          productNameZh: '手机壳',
          productNameRu: 'Чехлы',
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
  return { lotId, shortCodes: rows.map((b) => b.shortCode) };
}

function scan(batchId: string, code: string) {
  return {
    clientEventUuid: uuidv4(),
    batchId,
    code,
    method: 'qr' as const,
    scannedAt: new Date().toISOString(),
  };
}

/** Origin → customs and away, with `plan` of the lot's boxes on board. */
async function sendTruck(codes: string[], lotId: string, plan: number) {
  const sub = await submitPlan(
    { originWarehouseId: originId, destWarehouseId: customsId, lines: [{ lotId, boxCount: plan }] },
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
  for (const code of codes.slice(0, plan)) {
    await ingestLoadScans([{ ...scan(batch!.id, code), addedOnSpot: false }], ctx());
  }
  await departBatch(batch!.id, ctx());
  return batch!.id;
}

async function noticesFor(batchId: string) {
  return db
    .select()
    .from(clientNotices)
    .where(and(eq(clientNotices.refId, batchId), eq(clientNotices.clientId, clientId)));
}

beforeAll(async () => {
  async function ensureWarehouse(code: string, type: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({
        code,
        name: `N8 ${code}`,
        country: 'UZ',
        type,
        timezone: 'Asia/Tashkent',
        batchPrefix: code,
      })
      .returning();
    return wh!.id;
  }
  originId = await ensureWarehouse(WH_O, 'origin');
  customsId = await ensureWarehouse(WH_C, 'customs');
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  // A counter beside the clock: two clients minted in the same millisecond
  // would share a code and the test would assert about the wrong one (#598).
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `N8${String(Date.now()).slice(-6)}`, name: 'N8 client' })
    .returning();
  clientId = c!.id;
});

afterAll(async () => {
  if (clientId) await db.delete(clientNotices).where(eq(clientNotices.clientId, clientId));
  await pgClient.end();
});

describe('one arrival notice per client per truck', () => {
  it('four cartons scanned one at a time leave ONE claimed notice', async () => {
    const lot = await makeLot(4);
    const batchId = await sendTruck(lot.shortCodes, lot.lotId, 4);
    // One call per carton is exactly what the phone does — `ingestUnloadScans`
    // opens its own transaction per input, which is where the old code emitted
    // the client's message.
    for (const code of lot.shortCodes) {
      await ingestUnloadScans([scan(batchId, code)], ctx());
    }
    const rows = await noticesFor(batchId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe(NOTICE_ARRIVED);
    expect(rows[0]!.status).toBe('pending');
  });

  it('the notice waits for the truck, and finishUnload stops the waiting', async () => {
    const lot = await makeLot(2);
    const batchId = await sendTruck(lot.shortCodes, lot.lotId, 2);
    await ingestUnloadScans([scan(batchId, lot.shortCodes[0]!)], ctx());

    const claimed = (await noticesFor(batchId))[0]!;
    // Nothing goes out on the first carton — that is the whole point.
    let due = await dueArrivalNotices(200);
    expect(due.map((n) => n.id)).not.toContain(claimed.id);

    await ingestUnloadScans([scan(batchId, lot.shortCodes[1]!)], ctx());
    await finishUnload(batchId, ctx());

    due = await dueArrivalNotices(200);
    expect(due.map((n) => n.id)).toContain(claimed.id);
    // Still one row: closing the truck releases, it does not claim again.
    expect(await noticesFor(batchId)).toHaveLength(1);
  });

  it('the message carries the whole delivery, not the carton that claimed it', async () => {
    const lot = await makeLot(3);
    const batchId = await sendTruck(lot.shortCodes, lot.lotId, 3);
    for (const code of lot.shortCodes) await ingestUnloadScans([scan(batchId, code)], ctx());

    const summary = await arrivedSummary(clientId, batchId, customsId);
    expect(summary).not.toBeNull();
    expect(summary!.boxCount).toBe(3);
    expect(summary!.weightKg).toBeCloseTo(15, 3);
    expect(summary!.volumeM3).toBeCloseTo(0.081, 4);
    expect(summary!.lines).toHaveLength(1);
    // Russian where we have it: the Uzbek office reads the translation, not 手机壳.
    expect(summary!.lines[0]!.name).toBe('Чехлы');
    // The letter is the client's own running label, minted by the receipt —
    // the customer's reference on the carton, so the message must carry it.
    expect(summary!.lines[0]!.letter).toMatch(/^[A-Z]+$/);
  });

  it('a part-loaded lot is announced as the part that landed', async () => {
    const lot = await makeLot(4);
    // Two of four ride; the other two stay in China.
    const batchId = await sendTruck(lot.shortCodes, lot.lotId, 2);
    for (const code of lot.shortCodes.slice(0, 2)) {
      await ingestUnloadScans([scan(batchId, code)], ctx());
    }
    const summary = await arrivedSummary(clientId, batchId, customsId);
    expect(summary!.boxCount).toBe(2);
    // Half the lot's boxes = half its kilos and half its cubic metres. Naming
    // the LOT's totals would tell a customer twice what actually arrived.
    expect(summary!.weightKg).toBeCloseTo(10, 3);
    expect(summary!.volumeM3).toBeCloseTo(0.054, 4);
  });
});
