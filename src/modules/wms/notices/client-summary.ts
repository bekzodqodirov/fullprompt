import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  handovers,
  receiptLots,
  receipts,
  warehouses,
} from '@/modules/platform/db/schema';
import { cargoOverview } from '../client-cabinet/service';
import {
  cargoStage,
  milestoneCounts,
  stageIndex,
  type CargoStage,
  type Milestone,
} from '../client-cabinet/stages';
import { SKIP_CLIENT_CHANGED } from './client-claims';
import { pushLotName, type IssuedSummary, type PushLot, type ReceivedSummary } from './client-text';

/**
 * What a push SAYS, read from the database at the moment it is sent — never
 * from the event or the claim that reserved it.
 *
 * Minutes (or, for the unclaimed cargo a customer is given later, weeks)
 * separate the fact from the message, and in between a receipt can be voided,
 * moved to another code, or its cargo can leave China. The event drain used
 * to send the payload as it was frozen, so all three reached a customer as
 * news. Every reader here answers either the message's facts or a `skip` with
 * the reason, which the sweep writes onto the row.
 */

export type Skip = { skip: string };

// --- C1 ---

/**
 * Where a receipt's cargo stands NOW: every live box through the cabinet's
 * own `cargoStage` (the rule the Mini App draws with, so the push and the app
 * cannot disagree), and the rung holding the most boxes wins — ties to the
 * EARLIER rung, like `cargoOverview`'s own ordering. Null when nothing live
 * is left (every box voided or lost).
 */
async function receiptStage(receiptId: string): Promise<CargoStage | null> {
  const origin = alias(warehouses, 'rs_origin');
  const dest = alias(warehouses, 'rs_dest');
  const rows = await db
    .select({
      status: boxes.status,
      country: warehouses.country,
      type: warehouses.type,
      batchStatus: batches.status,
      checkpoint: batches.trackingCheckpoint,
      cleared: batches.customsClearedAt,
      originCountry: origin.country,
      destCountry: dest.country,
      hasBatch: sql<boolean>`${batches.id} IS NOT NULL`,
      n: sql<number>`count(*)`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .leftJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    // The live pointer is the right question for exactly the boxes on a truck
    // right now (`cargoOverview`'s own reasoning); landed boxes have none.
    .leftJoin(batches, eq(boxes.currentBatchId, batches.id))
    .leftJoin(origin, eq(batches.originWarehouseId, origin.id))
    .leftJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(and(eq(receiptLots.receiptId, receiptId), notInArray(boxes.status, ['void', 'lost'])))
    .groupBy(
      boxes.status,
      warehouses.country,
      warehouses.type,
      batches.id,
      batches.status,
      batches.trackingCheckpoint,
      batches.customsClearedAt,
      origin.country,
      dest.country,
    );
  const counts = new Map<CargoStage, number>();
  for (const r of rows) {
    const cp = r.checkpoint as { key?: string } | null;
    const stage = cargoStage(
      r.status,
      { country: r.country, type: r.type },
      r.hasBatch
        ? {
            originCountry: r.originCountry,
            destCountry: r.destCountry,
            status: r.batchStatus ?? '',
            checkpointKey: cp?.key ?? null,
            customsCleared: r.cleared !== null,
          }
        : null,
    );
    counts.set(stage, (counts.get(stage) ?? 0) + Number(r.n));
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || stageIndex(a[0]) - stageIndex(b[0]));
  return ranked[0]?.[0] ?? null;
}

export interface ReceivedFacts {
  summary: ReceivedSummary;
  /** The receipt's lots by letter — the first is the one the button opens on. */
  lotIds: string[];
}

/**
 * «Yukingiz qabul qilindi», as true as it is at send time.
 *
 * Skips, each one a thing that happened inside the window: the receipt is
 * gone or voided, or it now belongs to somebody else (judge PRIV-4 — the
 * correction window is only a window if the send re-reads the owner).
 */
export async function receivedFacts(clientId: string, receiptId: string): Promise<ReceivedFacts | Skip> {
  const [receipt] = await db
    .select({
      number: receipts.number,
      clientId: receipts.clientId,
      status: receipts.status,
      voidedAt: receipts.voidedAt,
      receivedAt: receipts.receivedAt,
      confirmedAt: receipts.confirmedAt,
      warehouseName: warehouses.name,
      warehouseCode: warehouses.code,
    })
    .from(receipts)
    .innerJoin(warehouses, eq(receipts.warehouseId, warehouses.id))
    .where(eq(receipts.id, receiptId));
  if (!receipt) return { skip: 'receipt_gone' };
  if (receipt.voidedAt || receipt.status === 'voided') return { skip: 'voided' };
  if (receipt.clientId !== clientId) return { skip: SKIP_CLIENT_CHANGED };

  const lots = await db
    .select({
      id: receiptLots.id,
      letter: receiptLots.letter,
      nameRu: receiptLots.productNameRu,
      nameZh: receiptLots.productNameZh,
      boxCount: receiptLots.boxCount,
      kg: receiptLots.totalWeightKg,
      m3: receiptLots.totalVolumeM3,
    })
    .from(receiptLots)
    .where(eq(receiptLots.receiptId, receiptId))
    .orderBy(asc(receiptLots.letter), asc(receiptLots.seq));
  if (lots.length === 0) return { skip: 'no_lots' };

  const stage = await receiptStage(receiptId);
  // Every carton voided or lost before the window closed: nothing to announce.
  if (!stage) return { skip: 'nothing_live' };

  const lines: PushLot[] = lots.map((lot) => ({
    lotId: lot.id,
    letter: lot.letter,
    name: pushLotName(lot.nameRu, lot.nameZh),
    boxCount: Number(lot.boxCount),
    weightKg: Number(lot.kg ?? 0),
    volumeM3: Number(lot.m3 ?? 0),
  }));
  return {
    summary: {
      clientCode: '',
      receiptNumber: receipt.number,
      warehouseName: receipt.warehouseName || receipt.warehouseCode,
      receivedAt: receipt.confirmedAt ?? receipt.receivedAt,
      lines,
      stage,
    },
    lotIds: lines.map((line) => line.lotId),
  };
}

// --- C3 ---

/**
 * «Yukingiz berildi», from the handover's OWN boxes.
 *
 * The lots are the boxes this handover moved (`box_movements` with the
 * handover as ref — the durable record, never a live pointer), as shares of
 * each lot: three boxes of a twenty-box lot are three twentieths of its kilos,
 * the arrival's own rule. What is LEFT is read now, a minute or two after the
 * counter, which is what the customer standing in the yard wants to know; and
 * only when nothing is left here is the rest of their cargo asked about, so
 * «hammasi topshirildi» is never said about a customer with a truck still on
 * the road (judge CX-5).
 */
export async function issuedFacts(clientId: string, handoverId: string): Promise<IssuedSummary | Skip> {
  const [handover] = await db
    .select({
      clientId: handovers.clientId,
      warehouseId: handovers.warehouseId,
      personName: handovers.personName,
      createdAt: handovers.createdAt,
      warehouseName: warehouses.name,
      warehouseCode: warehouses.code,
    })
    .from(handovers)
    .innerJoin(warehouses, eq(handovers.warehouseId, warehouses.id))
    .where(eq(handovers.id, handoverId));
  if (!handover) return { skip: 'handover_gone' };
  if (handover.clientId !== clientId) return { skip: SKIP_CLIENT_CHANGED };

  const rows = await db
    .select({
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      nameRu: receiptLots.productNameRu,
      nameZh: receiptLots.productNameZh,
      lotBoxes: receiptLots.boxCount,
      lotKg: receiptLots.totalWeightKg,
      lotM3: receiptLots.totalVolumeM3,
      issued: sql<number>`count(DISTINCT ${boxes.id})`,
    })
    .from(boxMovements)
    .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(
      and(
        eq(boxMovements.refType, 'handover'),
        eq(boxMovements.refId, handoverId),
        eq(boxMovements.cause, 'issued'),
      ),
    )
    .groupBy(
      receiptLots.id,
      receiptLots.letter,
      receiptLots.productNameRu,
      receiptLots.productNameZh,
      receiptLots.boxCount,
      receiptLots.totalWeightKg,
      receiptLots.totalVolumeM3,
    )
    .orderBy(asc(receiptLots.letter));
  const lines: PushLot[] = rows.map((row) => {
    const issued = Number(row.issued);
    const share = Number(row.lotBoxes) > 0 ? issued / Number(row.lotBoxes) : 0;
    return {
      lotId: row.lotId,
      letter: row.letter,
      name: pushLotName(row.nameRu, row.nameZh),
      boxCount: issued,
      weightKg: Number(row.lotKg ?? 0) * share,
      volumeM3: Number(row.lotM3 ?? 0) * share,
    };
  });
  if (lines.length === 0) return { skip: 'nothing_issued' };

  const [left] = await db
    .select({ n: sql<number>`count(*)` })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(
      and(
        eq(receipts.clientId, clientId),
        isNull(receipts.voidedAt),
        eq(boxes.currentWarehouseId, handover.warehouseId),
        inArray(boxes.status, ['ready_for_pickup', 'in_stock']),
      ),
    );
  const leftHere = Number(left?.n ?? 0);

  let elsewhere: Record<Milestone, number> | null = null;
  if (leftHere === 0) {
    const cargo = await cargoOverview(clientId);
    elsewhere = milestoneCounts(cargo.flatMap((lot) => lot.groups));
  }

  return {
    clientCode: '',
    warehouseName: handover.warehouseName || handover.warehouseCode,
    issuedAt: handover.createdAt,
    lines,
    boxCount: lines.reduce((sum, line) => sum + line.boxCount, 0),
    personName: handover.personName,
    leftHere,
    elsewhere,
  };
}
