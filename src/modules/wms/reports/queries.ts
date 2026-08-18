import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  clients,
  costAllocations,
  costEntries,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';

/**
 * Read models for the M6 dashboard + §13 reports. Every query takes an
 * optional warehouseIds filter so warehouse-scoped staff see only their own
 * warehouses; undefined = all (reports.all_warehouses holders).
 */

const IN_WAREHOUSE = ['in_stock', 'planned', 'loading', 'ready_for_pickup'] as const;

export async function warehouseFill(warehouseIds?: string[]) {
  const rows = await db
    .select({
      code: warehouses.code,
      capacityM3: warehouses.capacityM3,
      occupied: sql<string>`coalesce((
        SELECT sum(rl.total_volume_m3 / rl.box_count)
        FROM ${boxes} b JOIN ${receiptLots} rl ON b.lot_id = rl.id
        WHERE b.current_warehouse_id = "warehouses"."id"
          AND b.status IN ('in_stock', 'planned', 'loading', 'ready_for_pickup')
      ), 0)`,
    })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.active, true),
        isNotNull(warehouses.capacityM3),
        warehouseIds?.length ? inArray(warehouses.id, warehouseIds) : undefined,
      ),
    )
    .orderBy(asc(warehouses.code));
  return rows.map((r) => {
    const capacityM3 = Number(r.capacityM3);
    const occupiedM3 = Math.round(Number(r.occupied) * 10) / 10;
    return {
      code: r.code,
      capacityM3,
      occupiedM3,
      pct: capacityM3 > 0 ? Math.round((occupiedM3 / capacityM3) * 100) : 0,
    };
  });
}

/** Stock totals per warehouse (boxes physically there, incl. reserved/ready). */
export async function stockByWarehouse(warehouseIds?: string[]) {
  const rows = await db
    .select({
      code: warehouses.code,
      boxCount: sql<number>`count(*)`,
      kg: sql<string>`sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount})`,
      m3: sql<string>`sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount})`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .where(
      and(
        inArray(boxes.status, [...IN_WAREHOUSE]),
        warehouseIds?.length ? inArray(boxes.currentWarehouseId, warehouseIds) : undefined,
      ),
    )
    .groupBy(warehouses.code)
    .orderBy(asc(warehouses.code));
  return rows.map((r) => ({
    code: r.code,
    boxCount: Number(r.boxCount),
    kg: Math.round(Number(r.kg) * 10) / 10,
    m3: Math.round(Number(r.m3) * 100) / 100,
  }));
}

/** Receipts confirmed in the last 24 hours, per warehouse. */
export async function recentReceipts(warehouseIds?: string[]) {
  const rows = await db
    .select({ code: warehouses.code, n: sql<number>`count(*)` })
    .from(receipts)
    .innerJoin(warehouses, eq(receipts.warehouseId, warehouses.id))
    .where(
      and(
        eq(receipts.status, 'confirmed'),
        sql`${receipts.receivedAt} > now() - interval '24 hours'`,
        warehouseIds?.length ? inArray(receipts.warehouseId, warehouseIds) : undefined,
      ),
    )
    .groupBy(warehouses.code)
    .orderBy(asc(warehouses.code));
  return rows.map((r) => ({ code: r.code, n: Number(r.n) }));
}

export async function inTransitBatches(warehouseIds?: string[]) {
  const dest = aliasedTable(warehouses, 'dest');
  const rows = await db
    .select({
      id: batches.id,
      code: batches.code,
      originCode: warehouses.code,
      destCode: dest.code,
      departedAt: batches.departedAt,
      /**
       * What DEPARTED on this truck — never the live pointer. Landing NULLs
       * `current_batch_id` box by box, so the old count drained 180 → 0 while
       * the truck stood half-unloaded at the gate, and stayed 0 for as long
       * as the batch was `arrived` but not closed. #440's trap, recorded on
       * the batch card and in the arrival notices, reached its last consumer.
       */
      boxCount: sql<number>`(
        SELECT count(DISTINCT bm.box_id) FROM box_movements bm
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches.id}
          AND bm.cause = 'batch_departed')`,
    })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(
      and(
        inArray(batches.status, ['in_transit', 'arrived']),
        warehouseIds?.length
          ? sql`(${inArray(batches.originWarehouseId, warehouseIds)} OR ${inArray(batches.destWarehouseId, warehouseIds)})`
          : undefined,
      ),
    )
    .orderBy(desc(batches.departedAt));
  return rows.map((r) => ({ ...r, boxCount: Number(r.boxCount) }));
}

export async function unclaimedSummary(warehouseIds?: string[]) {
  const [row] = await db
    .select({
      receipts: sql<number>`count(DISTINCT ${receipts.id})`,
      boxes: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'in_stock')`,
    })
    .from(receipts)
    .innerJoin(receiptLots, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(boxes, eq(boxes.lotId, receiptLots.id))
    .where(
      and(
        isNull(receipts.clientId),
        eq(receipts.status, 'confirmed'),
        warehouseIds?.length ? inArray(receipts.warehouseId, warehouseIds) : undefined,
      ),
    );
  return { receipts: Number(row?.receipts ?? 0), boxes: Number(row?.boxes ?? 0) };
}

/** Boxes sitting in stock longer than `staleDays`, per warehouse (+ worst age). */
export async function agingSummary(staleDays: number, warehouseIds?: string[]) {
  const rows = await db
    .select({
      code: warehouses.code,
      n: sql<number>`count(*)`,
      worstDays: sql<number>`max(EXTRACT(day FROM now() - ${receipts.receivedAt}))`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .where(
      and(
        eq(boxes.status, 'in_stock'),
        sql`${receipts.receivedAt} < now() - make_interval(days => ${staleDays})`,
        warehouseIds?.length ? inArray(boxes.currentWarehouseId, warehouseIds) : undefined,
      ),
    )
    .groupBy(warehouses.code)
    .orderBy(asc(warehouses.code));
  return rows.map((r) => ({ code: r.code, n: Number(r.n), worstDays: Number(r.worstDays) }));
}

/** Open flags: missing_in_transit / undocumented_transfer boxes. */
export async function discrepancySummary(warehouseIds?: string[]) {
  const [row] = await db
    .select({
      missing: sql<number>`count(*) FILTER (WHERE ${boxes.flags} @> '["missing_in_transit"]'::jsonb)`,
      undocumented: sql<number>`count(*) FILTER (WHERE ${boxes.flags} @> '["undocumented_transfer"]'::jsonb)`,
    })
    .from(boxes)
    .where(
      warehouseIds?.length
        ? sql`(${inArray(boxes.currentWarehouseId, warehouseIds)} OR ${boxes.currentWarehouseId} IS NULL)`
        : undefined,
    );
  return { missing: Number(row?.missing ?? 0), undocumented: Number(row?.undocumented ?? 0) };
}

// ---------------------------------------------------------------------------
// Report 1 (owner priority): landed cost by client
// ---------------------------------------------------------------------------

export async function landedCostByClient() {
  const rows = await db
    .select({
      clientId: clients.id,
      clientCode: clients.clientCode,
      clientName: clients.name,
      boxCount: sql<number>`count(DISTINCT ${costAllocations.boxId})`,
      totalUsd: sql<string>`sum(${costAllocations.amountUsd})`,
    })
    .from(costAllocations)
    .innerJoin(clients, eq(costAllocations.clientId, clients.id))
    .groupBy(clients.id, clients.clientCode, clients.name)
    .orderBy(desc(sql`sum(${costAllocations.amountUsd})`));
  return rows.map((r) => ({
    ...r,
    boxCount: Number(r.boxCount),
    totalUsd: Math.round(Number(r.totalUsd) * 100) / 100,
  }));
}

/** Per-lot landed cost breakdown for one client (letter, product, boxes, kg, USD). */
export async function landedCostByLot(clientId: string) {
  const rows = await db
    .select({
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      boxCount: sql<number>`count(DISTINCT ${costAllocations.boxId})`,
      kg: sql<string>`max(${receiptLots.totalWeightKg})`,
      lotBoxes: sql<number>`max(${receiptLots.boxCount})`,
      totalUsd: sql<string>`sum(${costAllocations.amountUsd})`,
    })
    .from(costAllocations)
    .innerJoin(boxes, eq(costAllocations.boxId, boxes.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(eq(costAllocations.clientId, clientId))
    .groupBy(receiptLots.id)
    .orderBy(asc(receiptLots.letter));
  return rows.map((r) => {
    const coveredBoxes = Number(r.boxCount);
    const perLotKg = (Number(r.kg) / Number(r.lotBoxes)) * coveredBoxes;
    const totalUsd = Math.round(Number(r.totalUsd) * 100) / 100;
    return {
      lotId: r.lotId,
      letter: r.letter,
      productNameZh: r.productNameZh,
      productNameRu: r.productNameRu,
      boxCount: coveredBoxes,
      kg: Math.round(perLotKg * 10) / 10,
      totalUsd,
      usdPerBox: coveredBoxes > 0 ? Math.round((totalUsd / coveredBoxes) * 100) / 100 : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Report 2: stock with aging
// ---------------------------------------------------------------------------

export async function stockAging(warehouseIds?: string[]) {
  const rows = await db
    .select({
      whCode: warehouses.code,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      receivedAt: receipts.receivedAt,
      boxCount: sql<number>`count(*)`,
      kg: sql<string>`sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount})`,
      m3: sql<string>`sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount})`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(
      and(
        inArray(boxes.status, [...IN_WAREHOUSE]),
        warehouseIds?.length ? inArray(boxes.currentWarehouseId, warehouseIds) : undefined,
      ),
    )
    .groupBy(
      warehouses.code,
      clients.clientCode,
      receipts.unclaimedMarking,
      receipts.receivedAt,
      receiptLots.id,
    )
    .orderBy(asc(receipts.receivedAt));
  return rows.map((r) => {
    const kg = Number(r.kg);
    const m3 = Number(r.m3);
    return {
      whCode: r.whCode,
      code: `${r.clientCode ?? r.marking ?? '?'}-${r.letter ?? ''}`,
      product: `${r.productNameZh}${r.productNameRu ? ` (${r.productNameRu})` : ''}`,
      boxCount: Number(r.boxCount),
      kg: Math.round(kg * 10) / 10,
      m3: Math.round(m3 * 100) / 100,
      density: m3 > 0 ? Math.round(kg / m3) : null,
      days: Math.floor((Date.now() - new Date(r.receivedAt).getTime()) / 86_400_000),
    };
  });
}

// ---------------------------------------------------------------------------
// Report 3: batch register with deviations + unit costs
// ---------------------------------------------------------------------------

export async function batchRegister(warehouseIds?: string[]) {
  const dest = aliasedTable(warehouses, 'dest');
  const rows = await db
    .select({
      id: batches.id,
      code: batches.code,
      status: batches.status,
      originCode: warehouses.code,
      destCode: dest.code,
      createdAt: batches.createdAt,
      departedAt: batches.departedAt,
      loaded: sql<number>`(
        SELECT count(DISTINCT bm.box_id) FROM box_movements bm
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches.id} AND bm.cause = 'batch_departed'
      )`,
      short: sql<number>`(
        SELECT count(DISTINCT bm.box_id) FROM box_movements bm
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches.id} AND bm.cause = 'short_loaded'
      )`,
      added: sql<number>`(
        SELECT count(*) FROM scan_events se
        WHERE se.batch_id = ${batches.id} AND se.added_on_spot = true AND se.type = 'load'
      )`,
      kg: sql<string>`coalesce((
        SELECT sum(rl.total_weight_kg / rl.box_count)
        FROM box_movements bm JOIN ${boxes} b ON b.id = bm.box_id JOIN ${receiptLots} rl ON rl.id = b.lot_id
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches.id} AND bm.cause = 'batch_departed'
      ), 0)`,
      m3: sql<string>`coalesce((
        SELECT sum(rl.total_volume_m3 / rl.box_count)
        FROM box_movements bm JOIN ${boxes} b ON b.id = bm.box_id JOIN ${receiptLots} rl ON rl.id = b.lot_id
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches.id} AND bm.cause = 'batch_departed'
      ), 0)`,
      costUsd: sql<string>`coalesce((
        SELECT sum(ce.amount_usd) FROM ${costEntries} ce
        WHERE ce.batch_id = ${batches.id} AND ce.voided_at IS NULL
      ), 0)`,
    })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(
      // A cancelled batch is not a trip that happened, and this is an
      // aggregate: leaving it in means every register and its XLSX carries
      // rows of zero for ever. The board DIMS a retired record (it is that
      // record's own list); a report FILTERS it.
      and(
        ne(batches.status, 'cancelled'),
        warehouseIds?.length
          ? sql`(${inArray(batches.originWarehouseId, warehouseIds)} OR ${inArray(batches.destWarehouseId, warehouseIds)})`
          : undefined,
      ),
    )
    .orderBy(desc(batches.createdAt))
    .limit(300);
  return rows.map((r) => {
    const kg = Number(r.kg);
    const m3 = Number(r.m3);
    const costUsd = Math.round(Number(r.costUsd) * 100) / 100;
    return {
      id: r.id,
      code: r.code,
      status: r.status,
      route: `${r.originCode} → ${r.destCode}`,
      createdAt: r.createdAt,
      departedAt: r.departedAt,
      loaded: Number(r.loaded),
      short: Number(r.short),
      added: Number(r.added),
      kg: Math.round(kg * 10) / 10,
      m3: Math.round(m3 * 100) / 100,
      costUsd,
      usdPerKg: kg > 0 && costUsd > 0 ? Math.round((costUsd / kg) * 1000) / 1000 : null,
      usdPerM3: m3 > 0 && costUsd > 0 ? Math.round((costUsd / m3) * 100) / 100 : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Reports 4-8: receipts journal, unclaimed, client history, staff activity,
// label reprint log (§13) — same scoping convention as above.
// ---------------------------------------------------------------------------

export async function receiptsJournal(days: number, warehouseIds?: string[]) {
  const rows = await db
    .select({
      id: receipts.id,
      number: receipts.number,
      receivedAt: receipts.receivedAt,
      status: receipts.status,
      whCode: warehouses.code,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      operator: sql<string | null>`(SELECT u.full_name FROM users u WHERE u.id = ${receipts.createdBy})`,
      lots: sql<number>`(SELECT count(*) FROM receipt_lots rl WHERE rl.receipt_id = ${receipts.id})`,
      boxCount: sql<number>`(SELECT coalesce(sum(rl.box_count), 0) FROM receipt_lots rl WHERE rl.receipt_id = ${receipts.id})`,
      kg: sql<string>`(SELECT coalesce(sum(rl.total_weight_kg), 0) FROM receipt_lots rl WHERE rl.receipt_id = ${receipts.id})`,
      m3: sql<string>`(SELECT coalesce(sum(rl.total_volume_m3), 0) FROM receipt_lots rl WHERE rl.receipt_id = ${receipts.id})`,
    })
    .from(receipts)
    .innerJoin(warehouses, eq(receipts.warehouseId, warehouses.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(
      and(
        sql`${receipts.receivedAt} > now() - make_interval(days => ${days})`,
        warehouseIds?.length ? inArray(receipts.warehouseId, warehouseIds) : undefined,
      ),
    )
    .orderBy(desc(receipts.receivedAt))
    .limit(500);
  return rows.map((r) => ({
    ...r,
    lots: Number(r.lots),
    boxCount: Number(r.boxCount),
    kg: Math.round(Number(r.kg) * 10) / 10,
    m3: Math.round(Number(r.m3) * 100) / 100,
  }));
}

export async function unclaimedReport(warehouseIds?: string[]) {
  const rows = await db
    .select({
      id: receipts.id,
      number: receipts.number,
      marking: receipts.unclaimedMarking,
      whCode: warehouses.code,
      receivedAt: receipts.receivedAt,
      boxesInStock: sql<number>`(
        SELECT count(*) FROM ${boxes} b JOIN receipt_lots rl ON b.lot_id = rl.id
        WHERE rl.receipt_id = ${receipts.id} AND b.status = 'in_stock'
      )`,
      kg: sql<string>`(SELECT coalesce(sum(rl.total_weight_kg), 0) FROM receipt_lots rl WHERE rl.receipt_id = ${receipts.id})`,
    })
    .from(receipts)
    .innerJoin(warehouses, eq(receipts.warehouseId, warehouses.id))
    .where(
      and(
        isNull(receipts.clientId),
        eq(receipts.status, 'confirmed'),
        warehouseIds?.length ? inArray(receipts.warehouseId, warehouseIds) : undefined,
      ),
    )
    .orderBy(asc(receipts.receivedAt));
  return rows
    .map((r) => ({
      ...r,
      boxesInStock: Number(r.boxesInStock),
      kg: Math.round(Number(r.kg) * 10) / 10,
      days: Math.floor((Date.now() - new Date(r.receivedAt).getTime()) / 86_400_000),
    }))
    .filter((r) => r.boxesInStock > 0);
}

/** Client cargo history: every lot's journey summary (§13.6). */
export async function clientHistory(clientId: string) {
  const rows = await db
    .select({
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      boxCount: receiptLots.boxCount,
      receivedAt: receipts.receivedAt,
      whCode: warehouses.code,
      inStock: sql<number>`count(*) FILTER (WHERE ${boxes.status} IN ('in_stock', 'planned', 'loading'))`,
      inTransit: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'in_transit')`,
      ready: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'ready_for_pickup')`,
      issued: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'issued')`,
      lostVoid: sql<number>`count(*) FILTER (WHERE ${boxes.status} IN ('lost', 'void'))`,
      batchCodes: sql<string | null>`(
        SELECT string_agg(DISTINCT bt.code, ', ')
        FROM box_movements bm
        JOIN ${boxes} b2 ON b2.id = bm.box_id
        JOIN ${batches} bt ON bt.id = bm.ref_id
        WHERE b2.lot_id = ${receiptLots.id} AND bm.ref_type = 'batch' AND bm.cause = 'batch_departed'
      )`,
    })
    .from(receiptLots)
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(receipts.warehouseId, warehouses.id))
    .innerJoin(boxes, eq(boxes.lotId, receiptLots.id))
    .where(eq(receipts.clientId, clientId))
    .groupBy(receiptLots.id, receipts.receivedAt, warehouses.code)
    .orderBy(desc(receipts.receivedAt));
  return rows.map((r) => ({
    ...r,
    inStock: Number(r.inStock),
    inTransit: Number(r.inTransit),
    ready: Number(r.ready),
    issued: Number(r.issued),
    lostVoid: Number(r.lostVoid),
  }));
}

/** Staff activity per user per day (§13.8): receipts, edits, prints, scans. */
export async function staffActivity(days: number) {
  const rows = await db.execute(sql`
    WITH audit AS (
      SELECT a.actor_id,
             date_trunc('day', a.created_at)::date AS day,
             count(*) FILTER (WHERE a.entity_type = 'receipt' AND a.action = 'create') AS receipts,
             count(*) FILTER (WHERE a.action = 'update') AS edits,
             count(*) FILTER (WHERE a.action = 'label_print') AS prints,
             count(*) FILTER (WHERE a.action = 'export') AS exports
      FROM audit_log a
      WHERE a.created_at > now() - make_interval(days => ${days}) AND a.actor_id IS NOT NULL
      GROUP BY a.actor_id, day
    ), scans AS (
      SELECT s.scanned_by AS actor_id,
             date_trunc('day', s.created_at)::date AS day,
             count(*) AS scans
      FROM scan_events s
      WHERE s.created_at > now() - make_interval(days => ${days})
      GROUP BY s.scanned_by, day
    )
    SELECT coalesce(a.actor_id, s.actor_id) AS actor_id,
           coalesce(a.day, s.day) AS day,
           u.full_name,
           coalesce(a.receipts, 0) AS receipts,
           coalesce(a.edits, 0) AS edits,
           coalesce(a.prints, 0) AS prints,
           coalesce(a.exports, 0) AS exports,
           coalesce(s.scans, 0) AS scans
    FROM audit a
    FULL OUTER JOIN scans s ON s.actor_id = a.actor_id AND s.day = a.day
    JOIN users u ON u.id = coalesce(a.actor_id, s.actor_id)
    ORDER BY day DESC, u.full_name ASC
  `);
  return (rows as unknown as {
    day: string;
    full_name: string;
    receipts: string;
    edits: string;
    prints: string;
    exports: string;
    scans: string;
  }[]).map((r) => ({
    day: String(r.day).slice(0, 10),
    name: r.full_name,
    receipts: Number(r.receipts),
    edits: Number(r.edits),
    prints: Number(r.prints),
    exports: Number(r.exports),
    scans: Number(r.scans),
  }));
}

/** Label reprint log (§13.9): every label_print audit entry. */
export async function labelPrintLog(days: number) {
  const rows = await db.execute(sql`
    SELECT a.created_at, u.full_name, a.entity_id,
           a.after->>'count' AS count,
           r.number AS receipt_number
    FROM audit_log a
    JOIN users u ON u.id = a.actor_id
    LEFT JOIN receipts r ON r.id = a.entity_id
    WHERE a.action = 'label_print' AND a.created_at > now() - make_interval(days => ${days})
    ORDER BY a.created_at DESC
    LIMIT 300
  `);
  return (rows as unknown as {
    created_at: string;
    full_name: string;
    entity_id: string;
    count: string | null;
    receipt_number: string | null;
  }[]).map((r) => ({
    at: new Date(r.created_at),
    name: r.full_name,
    receiptId: r.entity_id,
    receiptNumber: r.receipt_number,
    count: r.count ? Number(r.count) : null,
  }));
}

/** Batches departed > N days ago with zero cost entries (spec 6.9 warning). */
export async function costMissingBatches(warnDays: number, warehouseIds?: string[]) {
  const dest = aliasedTable(warehouses, 'dest');
  const rows = await db
    .select({
      id: batches.id,
      code: batches.code,
      originCode: warehouses.code,
      destCode: dest.code,
      departedAt: batches.departedAt,
    })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(
      and(
        inArray(batches.status, ['in_transit', 'arrived', 'unloaded', 'closed']),
        sql`${batches.departedAt} < now() - make_interval(days => ${warnDays})`,
        sql`NOT EXISTS (SELECT 1 FROM ${costEntries} ce WHERE ce.batch_id = ${batches.id} AND ce.voided_at IS NULL)`,
        warehouseIds?.length ? inArray(batches.originWarehouseId, warehouseIds) : undefined,
      ),
    )
    .orderBy(asc(batches.departedAt))
    .limit(20);
  return rows;
}
