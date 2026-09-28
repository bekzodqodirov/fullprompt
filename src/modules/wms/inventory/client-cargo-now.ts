import { cache } from 'react';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../platform/db/client';
import { batches, boxes, receiptLots, receipts, warehouses } from '../../platform/db/schema';
import { CLIENT_ACTIVE_STATUSES } from '../boxes/active';
import { stageBatchOf, type StageBatch } from '../client-cabinet/stages';

/**
 * «Mijozning yuki hozir qayerda» — the one read behind the client card's
 * «Yuklar» tab, the one-line summary on «Umumiy» and «Pul», and the staff
 * bot's answer to a client code.
 *
 * It is the bot's grouped query lifted out of `bot/lookup.ts` (item 6 of
 * round VED-4, measured 2.1 ms on the clone's fullest client), with the
 * receipt's columns beside the lot's — a lot belongs to exactly one receipt,
 * so grouping by both changes no row count and the bot's answer does not
 * move. One row per (lot, status, the warehouse a carton stands in, the truck
 * its live pointer names).
 *
 * What is deliberately NOT here, and why:
 * - the photograph — two subqueries per group on the bot's SEQUENTIAL poller
 *   would be paid by every customer waiting on it (`receipts/first-photo.ts`
 *   reads it for the tab alone);
 * - money of any kind — the tab has none (the owner's rule for it), and the
 *   summary line sits under a money block that asks its own door;
 * - the landing truck — the live pointer is NULLed when a carton lands (#440),
 *   so «which truck brought it» is `documents/arrivals.ts`'s question, asked
 *   by the tab for the rows that stand somewhere.
 *
 * `missing` counts, inside a row, the cartons the unload declared missing on
 * the road: `finishUnload` leaves them `in_transit` on the unloaded truck,
 * flagged, and `truckStage` puts an unloaded truck in Uzbekistan — so without
 * this count the office would read «O'zbekistonda» about cargo the system has
 * written down as lost (the tab's judge, finding 1).
 */
export interface ClientCargoRow {
  clientId: string;
  lotId: string;
  letter: string | null;
  productZh: string;
  productRu: string | null;
  lotBoxes: number;
  lotKg: string | null;
  lotM3: string | null;
  receiptId: string;
  receiptNumber: string | null;
  receivedAt: Date;
  /** Where the goods were RECEIVED — never moves (`receipts/read-door.ts`). */
  receiptWarehouseId: string;
  /** The marking written on an unclaimed carton, kept after it was claimed. */
  marking: string | null;
  status: string;
  /** Where the carton stands; null while it rides a truck. */
  warehouseId: string | null;
  whCode: string | null;
  whName: string | null;
  whCountry: string | null;
  whType: string | null;
  /** The LIVE pointer — right only for planned, loading and in_transit cartons. */
  batchId: string | null;
  n: number;
  /** Of `n`: cartons still `in_transit` that an unload declared missing. */
  missing: number;
}

export async function clientCargoRows(clientIds: string[]): Promise<ClientCargoRow[]> {
  if (clientIds.length === 0) return [];
  const rows = await db
    .select({
      clientId: sql<string>`${receipts.clientId}`,
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productZh: receiptLots.productNameZh,
      productRu: receiptLots.productNameRu,
      lotBoxes: receiptLots.boxCount,
      lotKg: receiptLots.totalWeightKg,
      lotM3: receiptLots.totalVolumeM3,
      receiptId: receipts.id,
      receiptNumber: receipts.number,
      receivedAt: receipts.receivedAt,
      receiptWarehouseId: receipts.warehouseId,
      marking: receipts.unclaimedMarking,
      status: boxes.status,
      warehouseId: boxes.currentWarehouseId,
      whCode: warehouses.code,
      whName: warehouses.name,
      whCountry: warehouses.country,
      whType: warehouses.type,
      batchId: boxes.currentBatchId,
      n: sql<number>`count(*)`,
      missing: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'in_transit'
        AND ${boxes.flags} @> '["missing_in_transit"]'::jsonb)`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .where(and(inArray(receipts.clientId, clientIds), inArray(boxes.status, [...CLIENT_ACTIVE_STATUSES])))
    .groupBy(
      receipts.clientId,
      receiptLots.id,
      receiptLots.letter,
      receiptLots.productNameZh,
      receiptLots.productNameRu,
      receiptLots.boxCount,
      receiptLots.totalWeightKg,
      receiptLots.totalVolumeM3,
      receipts.id,
      receipts.number,
      receipts.receivedAt,
      receipts.warehouseId,
      receipts.unclaimedMarking,
      boxes.status,
      boxes.currentWarehouseId,
      warehouses.code,
      warehouses.name,
      warehouses.country,
      warehouses.type,
      boxes.currentBatchId,
    );
  return rows.map((r) => ({ ...r, n: Number(r.n), missing: Number(r.missing) }));
}

/** A truck a client's cargo is on (or being loaded onto), as the tab needs to know it. */
export interface CargoTruck {
  id: string;
  code: string;
  status: string;
  originWarehouseId: string;
  destWarehouseId: string;
  originCode: string;
  destCode: string;
  /** The customer's ladder reads this — `truckStage` via `cargoStage`. */
  stage: StageBatch;
}

/** The trucks the rows' live pointers name — ONE statement for all of them (#432). */
export async function cargoTrucks(batchIds: string[]): Promise<Map<string, CargoTruck>> {
  const out = new Map<string, CargoTruck>();
  const ids = [...new Set(batchIds)];
  if (ids.length === 0) return out;
  const origin = alias(warehouses, 'cn_origin');
  const dest = alias(warehouses, 'cn_dest');
  const rows = await db
    .select({
      id: batches.id,
      code: batches.code,
      status: batches.status,
      originWarehouseId: batches.originWarehouseId,
      destWarehouseId: batches.destWarehouseId,
      trackingCheckpoint: batches.trackingCheckpoint,
      customsClearedAt: batches.customsClearedAt,
      originCode: origin.code,
      originCountry: origin.country,
      destCode: dest.code,
      destCountry: dest.country,
    })
    .from(batches)
    .innerJoin(origin, eq(batches.originWarehouseId, origin.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(inArray(batches.id, ids));
  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      code: r.code,
      status: r.status,
      originWarehouseId: r.originWarehouseId,
      destWarehouseId: r.destWarehouseId,
      originCode: r.originCode,
      destCode: r.destCode,
      stage: stageBatchOf(r),
    });
  }
  return out;
}

export interface CargoNowData {
  rows: ClientCargoRow[];
  trucks: Map<string, CargoTruck>;
}

/** The rows and the trucks they name — two statements for any number of clients. */
export async function clientCargoNow(clientIds: string[]): Promise<CargoNowData> {
  const rows = await clientCargoRows(clientIds);
  const trucks = await cargoTrucks(rows.flatMap((r) => (r.batchId ? [r.batchId] : [])));
  return { rows, trucks };
}

/**
 * One client's cargo, once per request: the card's shell draws the tab's
 * badge from it and the tab (or the «Umumiy» summary line) draws the rows,
 * and `cache()` makes that one read. Keyed by the id — a primitive — because
 * React keys an object argument by identity and a fresh `[id]` would miss
 * every time (docs/CARD-TABS.md). It memoises a failure too, which is why the
 * shell's badge catches its own.
 */
export const clientCargoNowOnce = cache((clientId: string) => clientCargoNow([clientId]));
