import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  boxes,
  boxMovements,
  clients,
  crates,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
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
