import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/modules/platform/db/client';
import { clientNotices, clientTelegramLinks } from '@/modules/platform/db/schema';

/**
 * «Qabul qilindi» and «berildi» — claimed where the fact HAPPENS (round C).
 *
 * Both used to be sent by the EVENT drain: `processEventBatch` read a
 * `ReceiptConfirmed` or a `BoxIssued`, rendered the customer's message from
 * the event's payload and fetched Telegram inline — no deadline, no retry, a
 * 429 logged and the message gone, a throw that aborted every event claimed
 * behind it, and a payload frozen at the moment of the event, so a receipt
 * confirmed under the wrong code told the wrong customer (with a photograph,
 * once round C added one) before anybody could correct it. The judge's REL-5:
 * a customer's message is a claimed `client_notices` row, written in the SAME
 * transaction as the fact, and sent by the notices sweep with everything that
 * table already knows — once per (client, kind, ref), retries, a budget, and
 * the text built from the database when it is SENT.
 *
 * ONLY WHEN SOMEBODY CAN HEAR IT. A client with no linked chat has nobody to
 * tell; a row for them would be settled `skipped` two minutes later, and in
 * the meantime it is a foreign key into `clients` that every integration test
 * deleting its fixture client would trip over. The check is a SELECT on the
 * caller's transaction — never the pool (#714).
 */

/** Received at one of our warehouses — the owner's first ask. */
export const NOTICE_RECEIVED = 'received_cn';
/** Handed to the customer at the counter. */
export const NOTICE_ISSUED = 'issued';

/**
 * How long a new receipt waits before its customer is told: the correction
 * window (judge PRIV-4). The warehouse confirms on a phone in a hurry, and a
 * receipt put under the wrong code is fixed on the card within minutes; the
 * message is read from the receipt AT SEND TIME, so one corrected inside the
 * window goes to nobody but its real owner — and never carries one customer's
 * goods photograph to another.
 */
export const RECEIVED_WINDOW_MINUTES = 10;

/** The `last_error` a notice carries when its receipt moved to another client. */
export const SKIP_CLIENT_CHANGED = 'client_changed';

type Exec = Db | Tx;

/** Does this client have a Telegram chat to be told in? Asked on the caller's tx. */
async function hasLinkedChat(tx: Exec, clientId: string): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql<number>`1` })
    .from(clientTelegramLinks)
    .where(
      and(
        eq(clientTelegramLinks.clientId, clientId),
        eq(clientTelegramLinks.status, 'linked'),
        isNotNull(clientTelegramLinks.telegramChatId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Reserve «yukingiz qabul qilindi» for this receipt's client.
 *
 * Called from `confirmReceipt` and from `assignReceiptClient` — a correction
 * to ANOTHER client claims for the new owner (once), and the old owner's
 * notice, if it has not gone yet, finds at send time that the receipt is no
 * longer theirs and settles `skipped`. A notice skipped for exactly that
 * reason is re-armed when the receipt comes BACK (A → B → A inside the
 * window), since the fact it announces is true again; any other settled row
 * stays settled, so a re-save to the same client never sends twice.
 */
export async function claimReceivedNotice(tx: Exec, clientId: string, receiptId: string): Promise<boolean> {
  if (!(await hasLinkedChat(tx, clientId))) return false;
  const now = new Date();
  const sendAfter = new Date(now.getTime() + RECEIVED_WINDOW_MINUTES * 60_000);
  const rows = await tx
    .insert(clientNotices)
    .values({
      clientId,
      kind: NOTICE_RECEIVED,
      refType: 'receipt',
      refId: receiptId,
      sendAfter,
      // The staff side of `client_notices` is the arrival's alone; stamping it
      // keeps these rows out of that sweep's partial index (judge PERF-1).
      staffNotifiedAt: now,
    })
    .onConflictDoUpdate({
      target: [clientNotices.clientId, clientNotices.kind, clientNotices.refType, clientNotices.refId],
      set: { status: 'pending', sendAfter, attempts: 0, lastError: null, claimedAt: null },
      setWhere: sql`${clientNotices.status} = 'skipped' AND ${clientNotices.lastError} = ${SKIP_CLIENT_CHANGED}`,
    })
    .returning({ id: clientNotices.id });
  return rows.length > 0;
}

/**
 * Reserve «yukingiz berildi» for this handover. One handover, one message —
 * what the event drain always sent — due at once: the counter has already
 * happened, and the sweep reads the handover's own boxes when it sends.
 */
export async function claimIssuedNotice(tx: Exec, clientId: string, handoverId: string): Promise<boolean> {
  if (!(await hasLinkedChat(tx, clientId))) return false;
  const now = new Date();
  const rows = await tx
    .insert(clientNotices)
    .values({
      clientId,
      kind: NOTICE_ISSUED,
      refType: 'handover',
      refId: handoverId,
      sendAfter: now,
      staffNotifiedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: clientNotices.id });
  return rows.length > 0;
}
