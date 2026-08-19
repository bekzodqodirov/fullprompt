import { events } from '../db/schema';
import type { Db, Tx } from '../db/client';

/**
 * Domain event types (spec 4.7). The list grows per milestone; M0 only
 * defines the envelope — subscribers arrive with the notification engine (M1).
 */
export type DomainEventType =
  | 'ReceiptConfirmed'
  | 'BoxLabeled'
  | 'CrateFormed'
  | 'PlanApproved'
  | 'PlanChangesRequested'
  | 'BatchDeparted'
  | 'BoxScannedOnLoad'
  | 'BatchUnloaded'
  | 'BoxIssued'
  | 'UnknownCargoReceived'
  | 'CostEntryAdded'
  | 'CrateDissolved'
  | 'ReceiptMoved'
  | 'UnclaimedReturned'
  | 'BoxStatusChanged'
  | 'UndocumentedTransfer'
  | 'MissingInTransit'
  | 'ReadyForPickup'
  | 'InventoryCompleted'
  // Price control (docs/DEALS.md): fired while the cargo is still in the
  // Chinese warehouse, which is the only moment the client can still say
  // "then send it back".
  | 'UnquotedCargo'
  // Round 107: the deal exists, the receipt just was not linked to it — a
  // different job for the seller than pricing (attach, not quote).
  | 'UnlinkedCargo'
  | 'DealDeviation'
  | 'DealDeferralEnded'
  // Phase 6: issuing to a debtor goes through a recorded request/decision.
  | 'DebtApprovalRequested'
  | 'DebtApprovalDecided'
  // Phase 7: funnel movement becomes an event, so automation rules can hear
  // it. Emitted from EVERY stage write path, not just the board's move.
  | 'LeadStageChanged'
  | 'DealStageChanged';

/**
 * Persist a domain event in the same transaction as the mutation that caused
 * it. A pg-boss worker later fans events out to subscribers (notifications,
 * future modules) by polling `processed_at IS NULL`.
 */
export async function emitEvent(
  dbOrTx: Db | Tx,
  event: {
    type: DomainEventType;
    payload: Record<string, unknown>;
    entityType?: string;
    entityId?: string;
    actorId?: string | null;
  },
): Promise<void> {
  await dbOrTx.insert(events).values({
    type: event.type,
    payload: event.payload,
    entityType: event.entityType ?? null,
    entityId: event.entityId ?? null,
    actorId: event.actorId ?? null,
  });
}
