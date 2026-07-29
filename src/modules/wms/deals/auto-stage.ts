import { eq, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { receipts } from '@/modules/platform/db/schema';
import { applyCargoTrigger, type CargoTrigger } from './service';

/**
 * The ear that lets cargo move the deal funnel (round 26, owner's item 6:
 * «yuk holati o'zgarishi bilan sdelka varonkasida etaplarga avtomatik
 * o'tadigan qilsa bo'ladimi?»).
 *
 * The event worker calls `runDealAutoStage` for EVERY domain event, the same
 * way it calls the phase-7 rules; everything else in this file is turning one
 * warehouse event into "which deals, which cargo state". The moving itself —
 * forward-only, open deals only, through `moveDeal` — lives in the service
 * beside the rest of the deal logic.
 */

/** Which cargo state a warehouse event announces; null = not a cargo event. */
const TRIGGER_BY_EVENT: Record<string, CargoTrigger> = {
  ReceiptConfirmed: 'received',
  BatchDeparted: 'departed',
  BatchUnloaded: 'arrived',
  ReadyForPickup: 'ready',
  BoxIssued: 'handed',
};

export function cargoTriggerForEvent(type: string): CargoTrigger | null {
  return TRIGGER_BY_EVENT[type] ?? null;
}

/**
 * The deals whose cargo a movement reference touches. Batch membership and
 * handover contents are both answered by `box_movements` — a JOIN through the
 * movement rows, never a subquery in a join predicate (#152) — and a box
 * reaches its deal the only way it ever does: lot → receipt → `deal_id`.
 */
async function dealsForMovementRef(
  refType: 'batch' | 'handover',
  cause: string,
  refId: string,
  clientId?: string,
): Promise<string[]> {
  const rows = await db.execute<{ deal_id: string }>(sql`
    SELECT DISTINCT r.deal_id
    FROM box_movements bm
    JOIN boxes b ON b.id = bm.box_id
    JOIN receipt_lots rl ON rl.id = b.lot_id
    JOIN receipts r ON r.id = rl.receipt_id
    WHERE bm.ref_type = ${refType} AND bm.ref_id = ${refId} AND bm.cause = ${cause}
      AND r.deal_id IS NOT NULL
      ${clientId ? sql`AND r.client_id = ${clientId}` : sql``}
  `);
  return rows.map((row) => row.deal_id);
}

async function dealsForEvent(
  trigger: CargoTrigger,
  event: { payload: Record<string, unknown>; entityId: string | null },
): Promise<string[]> {
  switch (trigger) {
    case 'received': {
      const receiptId = event.payload.receiptId;
      if (typeof receiptId !== 'string' || !receiptId) return [];
      const [row] = await db
        .select({ dealId: receipts.dealId })
        .from(receipts)
        .where(eq(receipts.id, receiptId));
      return row?.dealId ? [row.dealId] : [];
    }
    // Who was ON the truck is the departure manifest, whichever end of the
    // trip the event speaks from.
    case 'departed':
    case 'arrived': {
      const batchId = event.payload.batchId;
      if (typeof batchId !== 'string' || !batchId) return [];
      return dealsForMovementRef('batch', 'batch_departed', batchId);
    }
    // ReadyForPickup is emitted per CLIENT of a batch (spec 6.6), and the
    // batch id rides on the event's entity, not in the payload.
    case 'ready': {
      const clientId = event.payload.clientId;
      if (!event.entityId || typeof clientId !== 'string' || !clientId) return [];
      return dealsForMovementRef('batch', 'batch_departed', event.entityId, clientId);
    }
    case 'handed': {
      const handoverId = event.payload.handoverId;
      if (typeof handoverId !== 'string' || !handoverId) return [];
      return dealsForMovementRef('handover', 'issued', handoverId);
    }
  }
}

/**
 * Hear one domain event; move the deals its cargo belongs to. Returns how
 * many deals moved. Cheap for the overwhelming majority of events: a
 * non-cargo type returns before touching the database, and a funnel with no
 * triggers configured costs one indexed read on the stages table.
 */
export async function runDealAutoStage(event: {
  type: string;
  payload: Record<string, unknown>;
  entityType: string | null;
  entityId: string | null;
  actorId: string | null;
}): Promise<number> {
  const trigger = cargoTriggerForEvent(event.type);
  if (!trigger) return 0;
  const dealIds = await dealsForEvent(trigger, event);
  if (dealIds.length === 0) return 0;
  // The mover is whoever caused the cargo event — the scanner, the receiver —
  // or nobody, exactly as the deferral sweep records its own closures.
  return applyCargoTrigger(dealIds, trigger, {
    actorId: event.actorId ?? null,
    ip: null,
    userAgent: null,
  });
}
