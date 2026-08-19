import { aliasedTable, and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  crates,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { warehouseScope, warehouseScopeEither } from '../../platform/rbac/scope';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';

export class InventoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Boxes the system EXPECTS to be physically present at the warehouse. */
const PRESENT_STATUSES = ['in_stock', 'planned', 'ready_for_pickup'] as const;

/**
 * Expected-stock snapshot for the inventory screen: every box that should be
 * at the warehouse (with labels for the operator) + active crate codes so a
 * crate QR scan counts all its member boxes at once.
 */
export async function inventorySnapshot(warehouseId: string) {
  const rows = await db
    .select({
      boxId: boxes.id,
      shortCode: boxes.shortCode,
      status: boxes.status,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      crateCode: crates.code,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .leftJoin(crates, eq(boxes.crateId, crates.id))
    .where(
      and(
        eq(boxes.currentWarehouseId, warehouseId),
        inArray(boxes.status, [...PRESENT_STATUSES]),
      ),
    );

  const crateRows = await db
    .select({ id: crates.id, code: crates.code })
    .from(crates)
    .where(and(eq(crates.warehouseId, warehouseId), eq(crates.status, 'active')));
  // Only members that should be HERE: a crate whose boxes departed on a truck
  // must not offer its whole in-transit load to a crate scan at the origin —
  // one code entry would count cargo that is between two countries as
  // standing on this floor.
  const crateBoxes = crateRows.length
    ? await db
        .select({ crateId: boxes.crateId, shortCode: boxes.shortCode })
        .from(boxes)
        .where(
          and(
            inArray(boxes.crateId, crateRows.map((c) => c.id)),
            inArray(boxes.status, [...PRESENT_STATUSES]),
            eq(boxes.currentWarehouseId, warehouseId),
          ),
        )
    : [];
  const byCrate = new Map<string, string[]>();
  for (const row of crateBoxes) {
    if (!row.crateId) continue;
    byCrate.set(row.crateId, [...(byCrate.get(row.crateId) ?? []), row.shortCode]);
  }

  return {
    boxes: rows,
    // An active crate with nothing present (all members riding a batch) is
    // not countable stock at this warehouse.
    crates: crateRows
      .map((c) => ({ code: c.code, boxShortCodes: byCrate.get(c.id) ?? [] }))
      .filter((c) => c.boxShortCodes.length > 0),
  };
}

export const reconcileSchema = z.object({
  warehouseId: z.string().uuid(),
  /** Scanned codes recorded at ANOTHER warehouse — physically here, move them. */
  foundHereCodes: z.array(z.string().trim().min(4).max(20)).max(5000),
  /** Expected boxes never scanned that the manager marks lost. */
  lostBoxIds: z.array(z.string().uuid()).max(5000),
  scannedCount: z.number().int().min(0).max(100_000),
});
export type ReconcileInput = z.infer<typeof reconcileSchema>;

/**
 * Inventory reconciliation (owner's request, M6 #12): reality wins — boxes
 * scanned here but recorded elsewhere move here with a correcting movement;
 * unscanned boxes the WAREHOUSE MANAGER ticks become `lost` (owner's answer:
 * manager decides, the owner gets a Telegram). Runs parallel to normal
 * operations — no freeze.
 */
export async function reconcileInventory(
  input: ReconcileInput,
  opts: { canMarkLost: boolean },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new InventoryError('unauthenticated');
  const actorId = ctx.actorId;
  if (input.lostBoxIds.length > 0 && !opts.canMarkLost) throw new InventoryError('forbidden_lost');

  const warehouse = await db.query.warehouses.findFirst({
    where: eq(warehouses.id, input.warehouseId),
  });
  if (!warehouse) throw new InventoryError('warehouse_not_found');

  return db.transaction(async (tx) => {
    const movedCodes: string[] = [];
    const skippedCodes: string[] = [];
    if (input.foundHereCodes.length) {
      const found = await tx
        .select()
        .from(boxes)
        .where(inArray(boxes.shortCode, input.foundHereCodes))
        .for('update');
      for (const box of found) {
        // Only boxes that are supposed to be sitting in SOME warehouse move;
        // issued/void/lost stay for a manual decision (lost→found exists).
        const movable =
          (PRESENT_STATUSES as readonly string[]).includes(box.status) ||
          box.status === 'in_transit';
        if (!movable || box.currentWarehouseId === input.warehouseId) {
          if (box.currentWarehouseId !== input.warehouseId) skippedCodes.push(box.shortCode);
          continue;
        }
        await tx
          .update(boxes)
          .set({
            status: 'in_stock',
            currentWarehouseId: input.warehouseId,
            currentBatchId: null,
          })
          .where(eq(boxes.id, box.id));
        await tx.insert(boxMovements).values({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: input.warehouseId,
          fromStatus: box.status,
          toStatus: 'in_stock',
          cause: 'inventory_found',
          refType: 'manual',
          actorId,
        });
        movedCodes.push(box.shortCode);
      }
    }

    const lostCodes: string[] = [];
    if (input.lostBoxIds.length) {
      const lost = await tx
        .select()
        .from(boxes)
        .where(
          and(
            inArray(boxes.id, input.lostBoxIds),
            eq(boxes.currentWarehouseId, input.warehouseId),
            inArray(boxes.status, [...PRESENT_STATUSES]),
          ),
        )
        .for('update');
      for (const box of lost) {
        await tx
          .update(boxes)
          .set({ status: 'lost', statusReason: 'inventory', crateId: null })
          .where(eq(boxes.id, box.id));
        await tx.insert(boxMovements).values({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: box.currentWarehouseId,
          fromStatus: box.status,
          toStatus: 'lost',
          cause: 'inventory_missing',
          refType: 'manual',
          actorId,
        });
        lostCodes.push(box.shortCode);
      }
    }

    const summary = {
      warehouseCode: warehouse.code,
      scanned: input.scannedCount,
      moved: movedCodes,
      lost: lostCodes,
      skipped: skippedCodes,
    };
    await writeAudit(tx, { ...ctx, warehouseId: input.warehouseId }, {
      entityType: 'warehouse',
      entityId: input.warehouseId,
      action: 'update',
      after: { inventory: true, ...summary },
    });
    await emitEvent(tx, {
      type: 'InventoryCompleted',
      payload: { ...summary, warehouseId: input.warehouseId },
      entityType: 'warehouse',
      entityId: input.warehouseId,
      actorId,
    });
    return summary;
  });
}

/**
 * The trucks on the road, for the stock screen's «Yo'lda» strip (round 100,
 * owner's 5A: «mashinalar korinib tursa qaysi mashinada qanchayuk borligi va
 * … ochib korish imkoni»).
 *
 * Membership is the LIVE pointer, `in_transit` only, and that is deliberate:
 * while a truck is genuinely on the road `current_batch_id` is exact, and the
 * moment it lands the unload screen and the batch card take over — an
 * `arrived` batch counted here through the live pointer would shrink towards
 * «Σ 0» exactly as boxes are scanned off it (#440's trap, refused here rather
 * than repeated). Weight and volume are a SHARE of the lot, as everywhere.
 *
 * Scope is the batch's TWO ends (`warehouseScopeEither`) — a truck belongs to
 * its origin until it arrives, and both warehouses have a reason to see it.
 * The `wh` filter matches EITHER end for the same reason: on the origin's
 * screen it is «what left us», on the destination's «what is coming».
 *
 * Deliberately NOT part of the Σ line, the table, the sort, the views or the
 * XLSX — those agree with each other about what is ON THE SHELF, and a truck
 * is not.
 */
/**
 * The yashik layer of the stock screen (round 107, owner: «sklad ostatkada
 * yashiklar soni hajmi og'irligi tursa va uni tagida karobkalar soni,
 * karobkalarning umumiy hajmi kg-mi tursa»).
 *
 * One row per ACTIVE crate with members physically present: `boxes.crate_id`
 * + the stock page's own four statuses + `current_warehouse_id =
 * crates.warehouse_id` — round 31's short-loaded member keeps its crateId at
 * the ORIGIN while the crate itself follows the landed boxes, so the bare
 * pointer would count a carton standing in Yiwu into a Tashkent row. The
 * INNER JOIN makes an empty crate produce no row structurally.
 *
 * Unlike the on-road strip this is a RE-GROUPING of cargo the Σ and the
 * table already count — nothing here is additive. Scope and the `wh` filter
 * live INSIDE, so no caller can forget them (#514); `q` deliberately does
 * not reach it — the strip sits outside the sort, the views and the XLSX,
 * and outside the search for the same reason (stated divergence: a product
 * search narrows the table, never the yashik list).
 *
 * The overflow flag compares the values AS PRINTED (kg to the integer, m³ to
 * two decimals) — numeric arrives as a STRING and `'300' > '1000.000'` is
 * true lexicographically (#663's shape), and a raw-float compare can flag ⚠
 * between two numbers that print identically. Screen-only by the owner's
 * word («faqat ekranda») — no Telegram, no export.
 */
const CRATE_STRIP_CAP = 50;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CrateStockRow {
  id: string;
  code: string;
  clientCode: string;
  whCode: string;
  boxCount: number;
  kg: number;
  m3: number;
  /** l×w×h when all three were measured; the ⚠ can only fire against these. */
  statedM3: number | null;
  statedKg: number | null;
  over: boolean;
}

export async function crateStock(
  actor: Parameters<typeof warehouseScope>[0],
  wh?: string,
): Promise<{ rows: CrateStockRow[]; more: boolean }> {
  const rows = await db
    .select({
      id: crates.id,
      code: crates.code,
      clientCode: clients.clientCode,
      whCode: warehouses.code,
      lengthCm: crates.lengthCm,
      widthCm: crates.widthCm,
      heightCm: crates.heightCm,
      weightKg: crates.weightKg,
      boxCount: sql<string>`count(*)`,
      kg: sql<string>`sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount})`,
      m3: sql<string>`sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount})`,
    })
    .from(crates)
    .innerJoin(clients, eq(crates.clientId, clients.id))
    .innerJoin(warehouses, eq(crates.warehouseId, warehouses.id))
    .innerJoin(
      boxes,
      and(
        eq(boxes.crateId, crates.id),
        inArray(boxes.status, ['in_stock', 'planned', 'loading', 'ready_for_pickup']),
        eq(boxes.currentWarehouseId, crates.warehouseId),
      ),
    )
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(
      and(
        eq(crates.status, 'active'),
        warehouseScope(actor, crates.warehouseId),
        // A malformed wh would be a 22P02 error page; treated as absent, the
        // same answer the strip gives about a filter it does not understand.
        wh && UUID_SHAPE.test(wh) ? eq(crates.warehouseId, wh) : undefined,
      ),
    )
    .groupBy(crates.id, clients.clientCode, warehouses.code)
    .orderBy(asc(crates.code))
    // One extra row = the honest «50+» without a second count query.
    .limit(CRATE_STRIP_CAP + 1);

  const mapped = rows.slice(0, CRATE_STRIP_CAP).map((row) => {
    const kg = Math.round(Number(row.kg));
    const m3 = Math.round(Number(row.m3) * 100) / 100;
    const statedM3 =
      row.lengthCm && row.widthCm && row.heightCm
        ? Math.round(((row.lengthCm * row.widthCm * row.heightCm) / 1e6) * 100) / 100
        : null;
    const statedKg = row.weightKg === null ? null : Math.round(Number(row.weightKg));
    return {
      id: row.id,
      code: row.code,
      clientCode: row.clientCode,
      whCode: row.whCode,
      boxCount: Number(row.boxCount),
      kg,
      m3,
      statedM3,
      statedKg,
      over: (statedM3 !== null && m3 > statedM3) || (statedKg !== null && kg > statedKg),
    };
  });
  return { rows: mapped, more: rows.length > CRATE_STRIP_CAP };
}

export async function transitTrucks(
  actor: Parameters<typeof warehouseScopeEither>[0],
  wh?: string,
) {
  const dest = aliasedTable(warehouses, 'dest');
  const onBoard = (expr: ReturnType<typeof sql.raw>) => sql<string>`coalesce((
    SELECT ${expr} FROM boxes b JOIN receipt_lots l ON l.id = b.lot_id
    WHERE b.current_batch_id = ${batches.id} AND b.status = 'in_transit'
  ), 0)`;
  const rows = await db
    .select({
      id: batches.id,
      code: batches.code,
      originCode: warehouses.code,
      destCode: dest.code,
      departedAt: batches.departedAt,
      boxCount: onBoard(sql.raw('count(*)')),
      kg: onBoard(sql.raw('sum(l.total_weight_kg / l.box_count)')),
      m3: onBoard(sql.raw('sum(l.total_volume_m3 / l.box_count)')),
    })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(
      and(
        eq(batches.status, 'in_transit'),
        warehouseScopeEither(actor, batches.originWarehouseId, batches.destWarehouseId),
        wh
          ? or(eq(batches.originWarehouseId, wh), eq(batches.destWarehouseId, wh))
          : undefined,
      ),
    )
    .orderBy(desc(batches.departedAt))
    .limit(20);
  // Numeric aggregates arrive as strings (or the coalesced 0); the screen
  // wants numbers, and an empty truck is nothing to announce.
  return rows
    .map((row) => ({
      ...row,
      boxCount: Number(row.boxCount),
      kg: Math.round(Number(row.kg)),
      m3: Math.round(Number(row.m3) * 100) / 100,
    }))
    .filter((row) => row.boxCount > 0);
}
