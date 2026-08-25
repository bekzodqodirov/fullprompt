import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { batches, clientNotices, clients, warehouses } from '@/modules/platform/db/schema';
import { emitEvent } from '@/modules/platform/events/service';
import { arrivedSummary, NOTICE_ARRIVED } from './arrival';

/**
 * The seller's «yuk keldi» — once per customer per truck (owner, 2026-08-25:
 * «har bir karobka … 10 ta karobka kelsa 10 ta sms, 1 dona "10 ta keldi"
 * emas»).
 *
 * `ReadyForPickup` used to be emitted inside the unload scanner's own
 * transaction, once per scan. Round 98 moved the CUSTOMER's copy onto the
 * `client_notices` claim and left the event where it was, «for the staff side,
 * which is what it was written for» — so the person who reads it every day got
 * one Telegram per carton.
 *
 * THREE things this module refuses to do, each one a defect the design review
 * found in the obvious version:
 *
 *  - it does NOT live inside the Telegram sender. That path has five terminal
 *    exits before it ever sends (no bot token, client gone, batch gone,
 *    nothing landed, no linked chat) and every one settles the row out of the
 *    pending queue for ever. The event is not a message: it is also the deal's
 *    `ready` cargo trigger and an automation trigger, and neither needs
 *    Telegram. So the staff sweep reads `staff_notified_at IS NULL` whatever
 *    the row's `status` says.
 *  - it does NOT claim and then emit as two statements. One transaction:
 *    `UPDATE … WHERE staff_notified_at IS NULL RETURNING` and the event
 *    commit together, or neither does. Two statements is at-most-once with a
 *    restart in the middle and no queue row anywhere to show for it.
 *  - it does NOT carry the totals from claim time. `arrivedSummary` is read
 *    now, minutes after the first carton, exactly as the customer's copy is.
 */
export interface StaffNoticeResult {
  noticeId: string;
  emitted: boolean;
  reason?: 'already_notified' | 'batch_gone' | 'client_gone' | 'nothing_landed';
}

/** Notices whose window has passed and whose STAFF side is still unsaid. */
export async function staffPendingNotices(limit = 50, now = new Date()) {
  return db
    .select({ id: clientNotices.id })
    .from(clientNotices)
    .where(
      and(
        eq(clientNotices.kind, NOTICE_ARRIVED),
        isNull(clientNotices.staffNotifiedAt),
        lte(clientNotices.sendAfter, now),
      ),
    )
    .orderBy(clientNotices.sendAfter)
    .limit(limit);
}

/**
 * Tell the staff side about one notice, exactly once.
 *
 * Extracted from the worker so a test can call it with no bot token and no
 * network — the only assertion that proves a seller learns cargo arrived used
 * to live on the per-scan emit, and rewriting it around a live `fetch` would
 * have made it untestable in this container.
 */
export async function emitArrivalStaffEvent(noticeId: string): Promise<StaffNoticeResult> {
  return db.transaction(async (tx) => {
    // The claim IS the fence. Anything that reads the row before this UPDATE
    // lands finds it unclaimed; anything after finds it stamped.
    const claimed = await tx
      .update(clientNotices)
      .set({ staffNotifiedAt: new Date() })
      .where(and(eq(clientNotices.id, noticeId), isNull(clientNotices.staffNotifiedAt)))
      .returning();
    const notice = claimed[0];
    if (!notice) return { noticeId, emitted: false, reason: 'already_notified' as const };

    const batch = await tx.query.batches.findFirst({ where: eq(batches.id, notice.refId) });
    if (!batch) return { noticeId, emitted: false, reason: 'batch_gone' as const };
    const client = await tx.query.clients.findFirst({ where: eq(clients.id, notice.clientId) });
    if (!client) return { noticeId, emitted: false, reason: 'client_gone' as const };

    const summary = await arrivedSummary(notice.clientId, notice.refId, batch.destWarehouseId, tx);
    // Everything this client had on the truck was voided, returned or handed
    // over before the window closed: there is nothing true to tell anybody.
    if (!summary) return { noticeId, emitted: false, reason: 'nothing_landed' as const };
    const wh = await tx.query.warehouses.findFirst({
      where: eq(warehouses.id, batch.destWarehouseId),
    });

    await emitEvent(tx, {
      type: 'ReadyForPickup',
      payload: {
        clientId: notice.clientId,
        warehouseId: batch.destWarehouseId,
        warehouseCode: wh?.code ?? '',
        batchCode: batch.code,
        boxCount: summary.boxCount,
        // The client's own copy is the notice this row IS — never this event
        // (`renderClientCabinetText` returns null for it).
        staffOnly: true,
      },
      entityType: 'batch',
      entityId: notice.refId,
      // Whoever was scanning when the truck landed. Without it an automation
      // rule assigning «to whoever did it» finds nobody and silently stops.
      actorId: notice.claimedBy,
    });
    return { noticeId, emitted: true };
  });
}

/**
 * A truck part-unloaded in the evening and finished the next morning is TWO
 * waves of cargo and one claim row: the second wave finds the unique index
 * taken and, without this, neither the customer nor the seller is ever told
 * about it.
 *
 * Called from the scan's own transaction beside `claimArrivalNotice`, and only
 * when that claim was refused — a row already SENT (or told to the staff)
 * whose truck has since landed more of this client's cargo re-arms: the staff
 * fence is cleared, and a settled Telegram row goes back to pending with a
 * fresh window. A row still waiting is left exactly as it is; it has not
 * spoken yet and will count the new cartons by itself.
 */
export async function rearmArrivalNotice(
  tx: Parameters<typeof emitEvent>[0],
  clientId: string,
  batchId: string,
  windowMinutes: number,
): Promise<boolean> {
  const rows = await tx
    .update(clientNotices)
    .set({
      staffNotifiedAt: null,
      status: 'pending',
      sendAfter: new Date(Date.now() + windowMinutes * 60_000),
      attempts: 0,
      lastError: null,
    })
    .where(
      and(
        eq(clientNotices.clientId, clientId),
        eq(clientNotices.kind, NOTICE_ARRIVED),
        eq(clientNotices.refType, 'batch'),
        eq(clientNotices.refId, batchId),
        // Only a notice that has already SPOKEN re-arms. One still pending
        // will read the new totals when its own window closes.
        sql`(${clientNotices.status} <> 'pending' OR ${clientNotices.staffNotifiedAt} IS NOT NULL)`,
      ),
    )
    .returning({ id: clientNotices.id });
  return rows.length > 0;
}
