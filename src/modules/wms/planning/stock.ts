import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, boxes, clients, crates, lotChecks, receiptLots, receipts, warehouses } from '../../platform/db/schema';
import { PLANNABLE_STATUSES } from '../boxes/shelf';
import { arrivalsForLots } from '../documents/arrivals';
import { qrlessJoinedSql } from '../labels/qrless-sql';
import {
  askableSql,
  lotCheckStateOrNullSql,
  withLotCheckJoins,
  type LotCheckState,
} from '../receipts/lot-check-sql';
import { lotChecksReady } from '../receipts/lot-check-ready';
import { lotSplitAt, roadCartonSql } from './road';
import { trucksOnRoadRows } from '../tracking/on-road';
import { incomingForWarehouses } from '../pickups/service';
import { formatEtaRange } from '../../platform/telegram/client-labels';

/**
 * Plannable stock at a warehouse — what the plan editor offers: LOOSE lots
 * (un-crated boxes free on the shelf) plus active crates as single units — a
 * crate is planned whole and counts as one place (owner's request).
 *
 * «Free on the shelf» is `PLANNABLE_STATUSES`, the list `availableByLot` and
 * the approval's reservation read too — so what the editor offers, what the
 * submit accepts and what the approval takes are one set. It was `in_stock`
 * here, and a truck unloaded at Andijan leaves its cargo `ready_for_pickup`:
 * the editor showed nothing to plan onto the internal trip to Tashkent.
 *
 * Out of its route handler so a test can ask the question the editor asks
 * (#166); the route keeps the door.
 */
export async function plannableStock(warehouseId: string) {
  // «Yuk ma'lumoti tekshirildi» (docs/YUK-TEKSHIRUV.md §6): the check's one
  // sentence over the two joins every reader makes, and whether THIS origin
  // is one where the ❓ is asked (a Chinese warehouse — his 4a). A server
  // whose migration has not landed (#472) plans exactly as before, with no
  // chips: a check never blocks a plan (§8).
  const checksOn = await lotChecksReady();
  const checkState = lotCheckStateOrNullSql(checksOn, {
    lot: sql`${receiptLots}`,
    receipt: sql`${receipts}`,
    check: sql`${lotChecks}`,
  });
  const [origin] = await db
    .select({ askable: sql<boolean>`${askableSql(sql`${warehouses}`)}` })
    .from(warehouses)
    .where(eq(warehouses.id, warehouseId));
  const askable = checksOn && Boolean(origin?.askable);

  const loose = db
    .select({
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      boxCount: receiptLots.boxCount,
      totalWeightKg: receiptLots.totalWeightKg,
      totalVolumeM3: receiptLots.totalVolumeM3,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      receivedAt: receipts.receivedAt,
      available: sql<number>`count(*)`,
      // Of those, the cartons no phone will scan (0112): the planner sees it
      // before the truck, not the loader after.
      qrless: sql<number>`count(*) FILTER (WHERE ${qrlessJoinedSql()})`,
      // An aggregate, so the GROUP BY stays as it was (one lot per group).
      check: sql<LotCheckState>`min(${checkState})`,
      receiptId: sql<string>`min(${receipts.id}::text)`,
      photoId: sql<string | null>`(
        SELECT a.id FROM attachments a
        WHERE a.entity_type = 'receipt_lot' AND a.entity_id = ${receiptLots.id} AND a.kind = 'photo'
        ORDER BY a.created_at LIMIT 1
      )`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .$dynamic();
  const rows = await withLotCheckJoins(loose, checksOn)
    .where(
      and(
        inArray(boxes.status, [...PLANNABLE_STATUSES]),
        eq(boxes.currentWarehouseId, warehouseId),
        isNull(boxes.crateId),
      ),
    )
    .groupBy(receiptLots.id, clients.clientCode, receipts.unclaimedMarking, receipts.receivedAt)
    // FIFO default (spec 6.3): oldest stock first.
    .orderBy(asc(receipts.receivedAt), asc(receiptLots.letter));

  const crated = db
    .select({
      crateId: crates.id,
      code: crates.code,
      kind: crates.kind,
      clientCode: clients.clientCode,
      boxCount: sql<number>`count(*)`,
      kg: sql<string>`sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount})`,
      m3: sql<string>`sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount})`,
      oldestReceivedAt: sql<string>`min(${receipts.receivedAt})`,
      lotIds: sql<string[]>`array_agg(distinct ${receiptLots.id})`,
      // A crate is ✅ only when EVERY lot inside is (a crate of an old lot and
      // a checked one vouches for nothing about the first).
      lotsChecked: sql<number>`count(DISTINCT ${receiptLots.id}) FILTER (WHERE ${checkState} = 'checked')`,
      lotsAsked: sql<number>`count(DISTINCT ${receiptLots.id}) FILTER (WHERE ${checkState} IN ('none', 'stale'))`,
    })
    .from(boxes)
    .innerJoin(crates, eq(boxes.crateId, crates.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(crates.clientId, clients.id))
    .$dynamic();
  const crateRows = await withLotCheckJoins(crated, checksOn)
    .where(
      and(
        inArray(boxes.status, [...PLANNABLE_STATUSES]),
        eq(boxes.currentWarehouseId, warehouseId),
        isNotNull(boxes.crateId),
        eq(crates.status, 'active'),
      ),
    )
    .groupBy(crates.id, clients.clientCode)
    .orderBy(asc(crates.code));

  // «Qaysi partiyada kelgan» (owner, 2026-08-29) — the agent sheet's rule
  // from its one home, computed once for the loose lots AND the crates'
  // member lots together; the planner keeping one arrival's cargo together
  // is exactly what the sheet groups by. Printed as the sheet's LABELS, so a
  // factory trip reads «ZR-… · factory · plate» here as it does there.
  const arrivals = await arrivalsForLots(
    [...new Set([...rows.map((r) => r.lotId), ...crateRows.flatMap((c) => c.lotIds)])],
    warehouseId,
  );
  const crateArrival = (lotIds: string[]) =>
    [...new Set(lotIds.flatMap((lotId) => arrivals.get(lotId)?.labels ?? []))].join(', ');

  return {
    /** The check is on this server (0123 landed) — the editor draws its filter only then. */
    checks: checksOn,
    /** The ❓ is asked here (a Chinese origin); ✅ shows wherever. */
    askable,
    lots: rows.map((r) => ({
      ...r,
      available: Number(r.available),
      qrless: Number(r.qrless),
      perBoxKg: Number(r.totalWeightKg) / r.boxCount,
      perBoxM3: Number(r.totalVolumeM3) / r.boxCount,
      daysInStock: Math.floor((Date.now() - new Date(r.receivedAt).getTime()) / 86_400_000),
      arrival: (arrivals.get(r.lotId)?.labels ?? []).join(', '),
    })),
    crates: crateRows.map((c) => ({
      crateId: c.crateId,
      code: c.code,
      kind: c.kind,
      clientCode: c.clientCode,
      boxCount: Number(c.boxCount),
      kg: Math.round(Number(c.kg) * 10) / 10,
      m3: Math.round(Number(c.m3) * 1000) / 1000,
      daysInStock: Math.floor((Date.now() - new Date(c.oldestReceivedAt).getTime()) / 86_400_000),
      arrival: crateArrival(c.lotIds),
      // Absent when the check is not on this server: the editor then draws no badge.
      ...(checksOn
        ? { lotsTotal: c.lotIds.length, lotsChecked: Number(c.lotsChecked), lotsAsked: Number(c.lotsAsked) }
        : {}),
    })),
  };
}

/** One inbound truck as the plan editor prints it under a road lot. */
export interface RoadTruck {
  code: string;
  /** «at the gate» (arrived, or the phone puts it there), «on the road», or no word. */
  state: 'gate' | 'road' | 'unknown';
  /** `formatEtaRange` — «29.10 – 31.10» — on a moving rung with a schedule; else null. */
  eta: string | null;
}

/** A factory trip heading to this warehouse — shown, never planned (his 2a). */
export interface RoadFactoryTrip {
  code: string;
  status: string;
  lines: { owner: string; goods: string; boxes: number }[];
}

/**
 * The editor's road half (docs/YOLDAGI-YUK.md §4): every lot with cartons on a
 * truck bound for `warehouseId`, in the shelf list's own row shape — names,
 * client or marking, photo, per-box kg/m³, the check — read from its receipt,
 * since none of it stands here; `available` is 0 here and the route merges
 * the shelf's figure in. `road.free` is the road less what approved plans at
 * this warehouse already owe (a pending plan reserves nothing). Plus the
 * factory trips heading here, read-only.
 */
export async function roadStock(warehouseId: string) {
  const checksOn = await lotChecksReady();
  const checkState = lotCheckStateOrNullSql(checksOn, {
    lot: sql`${receiptLots}`,
    receipt: sql`${receipts}`,
    check: sql`${lotChecks}`,
  });
  const w = sql`${warehouseId}::uuid`;
  const select = db
    .select({
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      boxCount: receiptLots.boxCount,
      totalWeightKg: receiptLots.totalWeightKg,
      totalVolumeM3: receiptLots.totalVolumeM3,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      receivedAt: receipts.receivedAt,
      road: sql<number>`count(*)`,
      qrless: sql<number>`count(*) FILTER (WHERE ${qrlessJoinedSql()})`,
      check: sql<LotCheckState>`min(${checkState})`,
      receiptId: sql<string>`min(${receipts.id}::text)`,
      trucks: sql<string[]>`array_agg(DISTINCT ${boxes.currentBatchId}::text)`,
      photoId: sql<string | null>`(
        SELECT a.id FROM attachments a
        WHERE a.entity_type = 'receipt_lot' AND a.entity_id = ${receiptLots.id} AND a.kind = 'photo'
        ORDER BY a.created_at LIMIT 1
      )`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .$dynamic();
  const rows = await withLotCheckJoins(select, checksOn)
    .where(roadCartonSql('boxes', w))
    .groupBy(receiptLots.id, clients.clientCode, receipts.unclaimedMarking, receipts.receivedAt)
    .orderBy(asc(receipts.receivedAt), asc(receiptLots.letter));

  const split = await lotSplitAt(
    db,
    warehouseId,
    rows.map((r) => r.lotId),
  );
  const truckIds = [...new Set(rows.flatMap((r) => r.trucks ?? []))].filter(Boolean);
  const [onRoad, codes] = await Promise.all([
    trucksOnRoadRows(truckIds),
    truckIds.length
      ? db
          .select({ id: batches.id, code: batches.code })
          .from(batches)
          .where(inArray(batches.id, truckIds))
      : Promise.resolve([] as { id: string; code: string }[]),
  ]);
  const codeOf = new Map(codes.map((b) => [b.id, b.code]));
  const truckView = (id: string): RoadTruck => {
    const row = onRoad.get(id);
    if (!row) return { code: codeOf.get(id) ?? '—', state: 'unknown', eta: null };
    if (row.status === 'arrived' || row.atGate) return { code: row.code, state: 'gate', eta: null };
    return {
      code: row.code,
      state: 'road',
      eta: row.eta ? formatEtaRange(row.eta.fromIso, row.eta.toIso) : null,
    };
  };

  const trips = await incomingForWarehouses([warehouseId]);
  const factoryTrips: RoadFactoryTrip[] = trips
    .filter((t) => t.status === 'on_road' || t.status === 'arrived')
    .map((t) => ({
      code: t.code,
      status: t.status,
      lines: t.stops.flatMap((stop) =>
        stop.owners.flatMap((owner) =>
          owner.lines.map((line) => ({
            owner: owner.clientCode ?? owner.marking ?? '—',
            goods: line.goods,
            boxes: line.driverBoxes ?? line.factoryBoxes,
          })),
        ),
      ),
    }));

  return {
    lots: rows.map((r) => ({
      lotId: r.lotId,
      letter: r.letter,
      productNameZh: r.productNameZh,
      productNameRu: r.productNameRu,
      boxCount: r.boxCount,
      totalWeightKg: r.totalWeightKg,
      totalVolumeM3: r.totalVolumeM3,
      clientCode: r.clientCode,
      marking: r.marking,
      receivedAt: r.receivedAt,
      receiptId: r.receiptId,
      photoId: r.photoId,
      check: r.check,
      available: 0,
      qrless: Number(r.qrless),
      perBoxKg: Number(r.totalWeightKg) / r.boxCount,
      perBoxM3: Number(r.totalVolumeM3) / r.boxCount,
      daysInStock: null as number | null,
      arrival: '',
      road: {
        free: split.get(r.lotId)?.roadFree ?? 0,
        trucks: (r.trucks ?? []).filter(Boolean).map(truckView).sort((a, b) => a.code.localeCompare(b.code)),
      },
    })),
    factoryTrips,
  };
}

type ShelfLot = Awaited<ReturnType<typeof plannableStock>>['lots'][number];
type RoadLot = Awaited<ReturnType<typeof roadStock>>['lots'][number];

/**
 * ONE list for the editor (objection editor#1): a shelf lot that also has road
 * cartons carries `road`; a lot only on the road joins with `available: 0`.
 * Σ, the gauge, the check filter and the prune then walk one array.
 */
export function withRoad(shelf: readonly ShelfLot[], road: readonly RoadLot[]) {
  const byLot = new Map(road.map((r) => [r.lotId, r]));
  const merged: (ShelfLot | RoadLot | (ShelfLot & { road: RoadLot['road'] }))[] = shelf.map((lot) => {
    const extra = byLot.get(lot.lotId);
    return extra ? { ...lot, road: extra.road } : lot;
  });
  const onShelf = new Set(shelf.map((l) => l.lotId));
  for (const lot of road) if (!onShelf.has(lot.lotId)) merged.push(lot);
  return merged;
}
