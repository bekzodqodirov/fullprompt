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
import { warehouseScopeEither } from '../../platform/rbac/scope';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { batchMemberFilter } from '../scanning/unload';
import { landedStatusFor } from '../warehouses/landed';
import { claimArrivalNotice } from '../notices/arrival';
import { isUuidShaped } from '../../platform/audit/fields';
import { PRESENT_STATUSES } from './present';
import { qrlessBoxSql, qrlessJoinedSql } from '../labels/qrless-sql';
import { lastScanIsCountSql } from '../scanning/count-rules';
import { crateMeasure } from './crate-grouping';

export class InventoryError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}


/**
 * What the stock screen and its export call «on the shelf»: everything
 * physically in a warehouse, reservations and mid-loading boxes included
 * (owner's report: "13 boxes at TAS1 but the stock page shows nothing").
 */
export const SHELF_STATUSES = ['in_stock', 'planned', 'loading', 'ready_for_pickup'] as const;

export interface StockWarehouseOption {
  id: string;
  code: string;
  active: boolean;
}

/**
 * The stock screen's warehouse picker (owner: «skladni ostatkka ko'radigan
 * payit inactive bo'lib turgan skladlar ham skladlar spiskasida turib
 * qolyabti»).
 *
 * A deactivated warehouse leaves the list — EXCEPT while boxes still stand in
 * it. Deactivating is a switch on /admin/warehouses and moves no cargo, so a
 * warehouse closed with stock inside would otherwise make that stock
 * unreachable by the one filter that finds it; it stays, marked, until it is
 * empty. The warehouse the address bar names stays too, or a saved view that
 * points at it would filter the table while the picker claimed «all».
 */
export async function stockWarehouseOptions(selected?: string): Promise<StockWarehouseOption[]> {
  const keepSelected = selected && isUuidShaped(selected) ? selected : null;
  return db
    .select({ id: warehouses.id, code: warehouses.code, active: warehouses.active })
    .from(warehouses)
    .where(or(listedWarehouseSql(), keepSelected ? eq(warehouses.id, keepSelected) : undefined))
    .orderBy(asc(warehouses.code));
}

/**
 * The picker rule above as a fragment over `warehouses`, so every warehouse
 * picker offers the same list (#513) — this one and the reports' «Ombor»
 * select (`reports/report-scope.ts`): active, or a deactivated one that still
 * has cargo standing in it.
 */
export function listedWarehouseSql() {
  // `${warehouses}.id` is #128's spelling: qualified in every place drizzle
  // can render it, so it can never bind to the box's own id.
  return sql`(${warehouses}.active = true OR EXISTS (SELECT 1 FROM ${boxes} b
               WHERE b.current_warehouse_id = ${warehouses}.id
                 AND b.status IN (${sql.join(
                   SHELF_STATUSES.map((status) => sql`${status}`),
                   sql`, `,
                 )})))`;
}

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
      lotId: boxes.lotId,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      crateCode: crates.code,
      // The two kinds of carton a stocktake cannot judge by a scan (0112):
      // one with no sticker of ours, and one the office counted onto or off a
      // truck without a per-carton witness. Neither is ever written off here.
      qrless: sql<boolean>`${qrlessJoinedSql()}`,
      countMoved: sql<boolean>`${lastScanIsCountSql(sql`${boxes}`)}`,
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
  // `resolveMissing`'s rule, which this path shipped without: cargo landing
  // at a customs/distribution warehouse must land `ready_for_pickup`, or it
  // sits in `in_stock` at a warehouse that issues to clients and never shows
  // up as ready for one.
  const landedStatus = landedStatusFor(warehouse.type);

  const movedIds: string[] = [];
  const lostIds: string[] = [];
  const result = await db.transaction(async (tx) => {
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
            status: landedStatus,
            currentWarehouseId: input.warehouseId,
            currentBatchId: null,
          })
          .where(eq(boxes.id, box.id));
        await tx.insert(boxMovements).values({
          boxId: box.id,
          fromWarehouseId: box.currentWarehouseId,
          toWarehouseId: input.warehouseId,
          fromStatus: box.status,
          toStatus: landedStatus,
          cause: 'inventory_found',
          refType: 'manual',
          actorId,
        });
        movedCodes.push(box.shortCode);
        movedIds.push(box.id);
      }
    }

    const lostCodes: string[] = [];
    const qrlessKept: string[] = [];
    const countKept: string[] = [];
    if (input.lostBoxIds.length) {
      /*
       * «Not scanned» is no evidence against a carton that could never be
       * scanned (0112, decision 33): a QR-siz one carries no sticker of ours,
       * and one whose last load or unload was an office COUNT had no witness
       * per carton to begin with. The screen shows both apart with no tick —
       * and this refuses them even when their ids ARE posted, naming what it
       * kept rather than silently dropping the tick.
       */
      const posted = and(
        inArray(boxes.id, input.lostBoxIds),
        eq(boxes.currentWarehouseId, input.warehouseId),
        inArray(boxes.status, [...PRESENT_STATUSES]),
      );
      const kept = await tx
        .select({
          shortCode: boxes.shortCode,
          qrless: sql<boolean>`${qrlessBoxSql()}`,
        })
        .from(boxes)
        .where(and(posted, sql`(${qrlessBoxSql()} OR ${lastScanIsCountSql(sql`${boxes}`)})`));
      for (const row of kept) (row.qrless ? qrlessKept : countKept).push(row.shortCode);
      const lost = await tx
        .select()
        .from(boxes)
        .where(
          and(
            posted,
            sql`NOT ${qrlessBoxSql()}`,
            sql`NOT ${lastScanIsCountSql(sql`${boxes}`)}`,
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
        lostIds.push(box.id);
      }
    }

    const summary = {
      warehouseCode: warehouse.code,
      scanned: input.scannedCount,
      moved: movedCodes,
      lost: lostCodes,
      skipped: skippedCodes,
      qrlessKept,
      countKept,
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
  // A carton counted HERE that the record had on a truck out of here never
  // left: it stops riding that truck, whose costs re-split over the cargo
  // that did (U17) — after the commit, never failing the stocktake.
  await recomputeFoundBack(movedIds, input.warehouseId, 'inventory');
  // The cartons ticked lost can be a deal's last outstanding ones (U38's
  // shape): the deal is fully handed from now and the funnel must hear it.
  if (lostIds.length) {
    try {
      const { advanceDealsAfterWriteOff } = await import('../deals/auto-stage');
      await advanceDealsAfterWriteOff(lostIds, ctx);
    } catch (error) {
      console.error('[inventory] deal stage after the stocktake failed', error);
    }
  }
  return result;
}

/** `acceptFoundBox`'s and the stocktake's shared post-commit tail. */
async function recomputeFoundBack(boxIds: string[], warehouseId: string, why: string): Promise<void> {
  if (boxIds.length === 0) return;
  try {
    const { recomputeRiderChange, trucksFoundBackAt } = await import('../costing/service');
    await recomputeRiderChange(await trucksFoundBackAt(boxIds, warehouseId), why);
  } catch (err) {
    console.error('[inventory] found-back re-split failed', why, err);
  }
}

export interface FoundBoxSummary {
  shortCode: string;
  clientCode: string | null;
  marking: string | null;
  letter: string | null;
  product: string;
  /** Where the record said it was — a warehouse code or a truck code. */
  fromWhCode: string | null;
  fromBatchCode: string | null;
  landedStatus: string;
}

/**
 * Accept ONE box found standing in this warehouse while the record says it is
 * somewhere else (owner, 2026-08-25: «yukni yukladim deb skan qilib qo'ydim
 * lekin … usha korbkani tushirib qoldirdi … skan qilib skladga qabul qilib
 * olsam»). The full stocktake's found-here rule for a single code, without
 * counting the building: reality wins, the correcting movement says so, and
 * the truck's planner is told their manifest shrank.
 *
 * What it deliberately does NOT touch: a box still `loading` (that truck is
 * being loaded RIGHT NOW — the loading screen's own «tushirish» is the door,
 * pre-departure state must have one writer), an `issued` box (the client
 * signed for it — un-issuing is a handover decision, not a scan), and the
 * terminal `void`/`lost` (a recorded loss is not erased by a scan; reviving a
 * lost box is a manager's decision with the loss's own history in front of
 * them — stated cut).
 */
export async function acceptFoundBox(
  input: { warehouseId: string; code: string },
  ctx: AuditContext,
): Promise<FoundBoxSummary> {
  if (!ctx.actorId) throw new InventoryError('unauthenticated');
  const actorId = ctx.actorId;
  const warehouse = await db.query.warehouses.findFirst({
    where: eq(warehouses.id, input.warehouseId),
  });
  if (!warehouse) throw new InventoryError('warehouse_not_found');
  const landedStatus = landedStatusFor(warehouse.type);

  let foundBoxId: string | null = null;
  const summary = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(boxes)
      .where(sql`upper(${boxes.shortCode}) = ${input.code.trim().toUpperCase()}`)
      .for('update');
    const box = rows[0];
    if (!box) throw new InventoryError('unknown_code');
    if (['void', 'lost', 'issued'].includes(box.status)) {
      throw new InventoryError(`box_${box.status}`);
    }
    if (box.status === 'loading') throw new InventoryError('still_loading');
    if (box.currentWarehouseId === input.warehouseId) throw new InventoryError('already_here');
    /*
     * A box riding a truck bound for THIS warehouse belongs to the unload
     * screen, not to this one. Both doors would move it, but only the unload
     * writes the records the business reads: `unload_scan` movements (the
     * logist's «qabul qilindi» count, the agent sheet's arrival), the client's
     * arrival notice and the seller's message. Accepting it here would be a
     * quieter, lower-gated way to unload a truck badly — and once the
     * accept-everything shortcut became a manager act, the tempting one.
     */
    if (box.status === 'in_transit' && box.currentBatchId) {
      const riding = await tx.query.batches.findFirst({
        where: eq(batches.id, box.currentBatchId),
      });
      if (
        riding &&
        riding.destWarehouseId === input.warehouseId &&
        ['in_transit', 'arrived'].includes(riding.status)
      ) {
        throw new InventoryError('use_unload_screen');
      }
    }

    const [label] = await tx
      .select({
        letter: receiptLots.letter,
        product: receiptLots.productNameZh,
        clientCode: clients.clientCode,
        marking: receipts.unclaimedMarking,
      })
      .from(receiptLots)
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .leftJoin(clients, eq(receipts.clientId, clients.id))
      .where(eq(receiptLots.id, box.lotId));
    const fromWh = box.currentWarehouseId
      ? await tx.query.warehouses.findFirst({ where: eq(warehouses.id, box.currentWarehouseId) })
      : null;
    const fromBatch = box.currentBatchId
      ? await tx.query.batches.findFirst({ where: eq(batches.id, box.currentBatchId) })
      : null;

    await tx
      .update(boxes)
      .set({
        status: landedStatus,
        currentWarehouseId: input.warehouseId,
        currentBatchId: null,
        flags: [],
      })
      .where(eq(boxes.id, box.id));
    await tx.insert(boxMovements).values({
      boxId: box.id,
      fromWarehouseId: box.currentWarehouseId,
      toWarehouseId: input.warehouseId,
      fromStatus: box.status,
      toStatus: landedStatus,
      // The stocktake's own cause, so every report treats a single found box
      // and a counted one identically.
      cause: 'inventory_found',
      refType: 'manual',
      actorId,
    });
    foundBoxId = box.id;
    await writeAudit(tx, { ...ctx, warehouseId: input.warehouseId }, {
      entityType: 'box',
      entityId: box.id,
      action: 'status_change',
      after: {
        foundHere: true,
        shortCode: box.shortCode,
        from: fromBatch?.code ?? fromWh?.code ?? null,
      },
    });
    // Cargo that reached a warehouse the client collects from HAS arrived,
    // whichever door recorded it — the customer and their seller hear it once
    // per truck through the same claim the unload uses.
    if (landedStatus === 'ready_for_pickup' && fromBatch && label) {
      const [owner] = await tx
        .select({ clientId: receipts.clientId })
        .from(receiptLots)
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .where(eq(receiptLots.id, box.lotId));
      if (owner?.clientId) {
        await claimArrivalNotice(tx, owner.clientId, fromBatch.id, { actorId });
      }
    }
    return {
      shortCode: box.shortCode,
      clientCode: label?.clientCode ?? null,
      marking: label?.marking ?? null,
      letter: label?.letter ?? null,
      product: label?.product ?? '',
      fromWhCode: fromWh?.code ?? null,
      fromBatchCode: fromBatch?.code ?? null,
      landedStatus,
    } satisfies FoundBoxSummary;
  });

  // Found back where its truck started (the owner's «yukladim deb skan qildim
  // … tushirib qoldirdi»): it never rode that truck, so the truck's costs
  // re-split over the cargo that did (U17). The bulk-accepted variant — the
  // pointer already cleared at the destination — is found by its departure.
  if (foundBoxId) await recomputeFoundBack([foundBoxId], input.warehouseId, 'accept_found');

  // A box pulled OFF an in-transit truck changes what the destination will
  // receive — the people who plan the trucks hear it, after the transaction
  // (a Telegram row must never be able to roll a stock fix back).
  if (summary.fromBatchCode) {
    const userIds = await usersWithPermission('plans.manage');
    if (userIds.length > 0) {
      await notifyStaffTelegram({
        userIds,
        type: 'BoxFoundHere',
        exceptUserId: actorId,
        text:
          `↩️ ${summary.shortCode} (${summary.clientCode ?? summary.marking ?? '?'}) ` +
          `${summary.fromBatchCode} reysida deb yozilgan edi — ${warehouse.code} skladida topilib, qabul qilindi.`,
      }).catch(() => {});
    }
  }
  return summary;
}

export interface BinCandidateRow {
  boxId: string;
  shortCode: string;
  clientCode: string | null;
  marking: string | null;
  letter: string | null;
  product: string;
}

/**
 * «What is this code, and may I bin it here?» — the bin scan's first tap
 * (owner, 2026-08-25: «1 karobka musorga ketdi shikastlangan … scan qilib
 * musorga tashlaydi, izoh yozib»).
 *
 * Reads and refuses, writes nothing. The refusals are the fence: the code is
 * resolved GLOBALLY (an operator holds the carton, not a warehouse list) and
 * then judged against the warehouse the screen is standing in, so a Yiwu
 * scanner typing a Tashkent code is told «this box is not here» rather than
 * writing off cargo in another country — the defect the review found in the
 * first version of this door, where the gate was checked at the posted
 * warehouse and the code resolved everywhere.
 */
export async function binCandidate(input: {
  warehouseId: string;
  code: string;
}): Promise<BinCandidateRow> {
  const [row] = await db
    .select({
      boxId: boxes.id,
      shortCode: boxes.shortCode,
      status: boxes.status,
      warehouseId: boxes.currentWarehouseId,
      letter: receiptLots.letter,
      product: receiptLots.productNameZh,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(sql`upper(${boxes.shortCode}) = ${input.code.trim().toUpperCase()}`);

  if (!row) throw new InventoryError('unknown_code');
  if (['void', 'lost'].includes(row.status)) throw new InventoryError(`box_${row.status}`);
  if (row.status === 'issued') throw new InventoryError('box_issued');
  // On a truck, or standing somewhere else: not this person's carton to bin.
  // Named separately from the shelf rule so the screen can point at the door
  // that IS right — the unload screen, or the found-box accept.
  if (row.warehouseId !== input.warehouseId) throw new InventoryError('box_elsewhere');
  if (!['in_stock', 'planned', 'ready_for_pickup'].includes(row.status)) {
    throw new InventoryError('box_not_here');
  }
  return {
    boxId: row.boxId,
    shortCode: row.shortCode,
    clientCode: row.clientCode,
    marking: row.marking,
    letter: row.letter,
    product: row.product,
  };
}

/** One crate as a PLACE on the truck card (round 109) — `CrateRows`' row. */
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

/**
 * The raw crate aggregate → the row a screen draws, in the order it should be
 * read: **the over-capacity ones first** (owner, round 109: «agar
 * ogohlantirish … spiskani tepasida tursa boladi, bolmasam shar etmas») —
 * the rest keep their code order, because he said plainly that beyond the
 * warning the order does not matter.
 */
function mapCrateRows(rows: CrateAggregate[]): CrateStockRow[] {
  const mapped = rows.map((row) => {
    // The measure-and-⚠ rule has one home, shared with the stock rows.
    const measure = crateMeasure(row, Number(row.kg), Number(row.m3));
    return {
      id: row.id,
      code: row.code,
      clientCode: row.clientCode,
      whCode: row.whCode,
      boxCount: Number(row.boxCount),
      kg: measure.kg,
      m3: measure.m3,
      statedM3: measure.statedM3,
      statedKg: measure.statedKg,
      over: measure.over,
    };
  });
  return [...mapped].sort((a, b) => Number(b.over) - Number(a.over) || a.code.localeCompare(b.code));
}

/** What the two crate queries select — one shape, one mapper. */
interface CrateAggregate {
  id: string;
  code: string;
  clientCode: string;
  whCode: string;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  weightKg: string | null;
  boxCount: string;
  kg: string | null;
  m3: string | null;
}

/**
 * The crates riding THIS truck, as places (owner, round 109: «mashina
 * spiskasida ham tahta yashikni mestasi kubi kg si korinsin»).
 *
 * Membership is `batchMemberFilter`, never the live pointer (#440) — a truck
 * that has been unloaded no longer has a box pointing at it, and the crate
 * would vanish from the document exactly when somebody looks up what came.
 * The contents are the boxes that RODE this batch: round 31's short-loaded
 * member stayed at the origin and must not be counted onto the truck it
 * missed.
 */
export async function batchCrates(batchId: string): Promise<CrateStockRow[]> {
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
    .from(boxes)
    .innerJoin(crates, eq(boxes.crateId, crates.id))
    .innerJoin(clients, eq(crates.clientId, clients.id))
    .innerJoin(warehouses, eq(crates.warehouseId, warehouses.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(batchMemberFilter(batchId))
    .groupBy(crates.id, clients.clientCode, warehouses.code)
    .orderBy(asc(crates.code));
  return mapCrateRows(rows);
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
