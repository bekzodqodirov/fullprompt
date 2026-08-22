import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import type { Db, Tx } from '@/modules/platform/db/client';
import {
  boxes,
  clientNotices,
  receiptLots,
  receipts,
} from '@/modules/platform/db/schema';

/**
 * «Yukingiz yetib keldi» — once per customer per truck, and true when it goes.
 *
 * The owner, watching his own customers' phones: «mashinadan yuk tushganda
 * yukingiz keldi deb har bir karobka uchun habar jonatyabti». He is right, and
 * the cause is structural rather than a slip: `ingestUnloadScans` walks the
 * phone's scan queue one input per TRANSACTION, and the client's notice was
 * emitted inside that transaction. One carton scanned is one message; the
 * «accept everything remaining» button feeds one input per short code through
 * the same door, so one press on a two-hundred-box truck was two hundred.
 *
 * Three things had to be true at once, and they are why this is a table and
 * not an `if`:
 *
 *  - ONCE. The unique index on (client, kind, ref) is claimed with
 *    `ON CONFLICT DO NOTHING` inside the movement's own transaction — round
 *    83's claim-before-work rule — so two scanners on the same truck at the
 *    same second cannot both win it.
 *  - TRUE. A message sent on the first box would say «1 karobka» about a
 *    delivery of thirty. The claim only reserves the right to speak; the
 *    totals are computed when it is SENT, minutes later, by which time the
 *    truck has been scanned.
 *  - DURABLE. Waiting in memory would mean a deploy in that window loses the
 *    customer's message altogether — worse than the noise it replaces. The
 *    claim is a row, and the worker retries it.
 *
 * Deliberately NOT hung on `finishUnload`: that button is not always pressed,
 * and a customer's message must not depend on a human habit.
 */

/** The one kind this module writes. A second would be a second constant. */
export const NOTICE_ARRIVED = 'arrived_uz';

/**
 * How long the first landed box waits for the rest of its truck.
 *
 * Long enough that a warehouse unloading by hand finishes inside it, short
 * enough that a customer standing in the yard is not told later than the
 * person who telephoned. `finishUnload` pulls it forward, so a truck that is
 * properly closed notifies at once and this is only the ceiling.
 */
export const ARRIVAL_WINDOW_MINUTES = 20;

type Exec = Db | Tx;

/**
 * Reserve the right to tell this client their cargo landed off this truck.
 *
 * Returns true only for the FIRST caller — every later box on the same truck
 * finds the row already there. Runs inside the caller's transaction on
 * purpose: a claim that survives a rolled-back unload would silence the real
 * one that follows.
 */
export async function claimArrivalNotice(
  tx: Exec,
  clientId: string,
  batchId: string,
  windowMinutes = ARRIVAL_WINDOW_MINUTES,
): Promise<boolean> {
  const rows = await tx
    .insert(clientNotices)
    .values({
      clientId,
      kind: NOTICE_ARRIVED,
      refType: 'batch',
      refId: batchId,
      sendAfter: new Date(Date.now() + windowMinutes * 60_000),
    })
    .onConflictDoNothing()
    .returning({ id: clientNotices.id });
  return rows.length > 0;
}

/**
 * The truck is closed, so there is nothing left to wait for.
 *
 * Called by `finishUnload`. Only moves pending rows, and only backwards in
 * time — a notice that has already gone must not be resurrected, and one
 * already due must not be pushed out.
 */
export async function releaseArrivalNotices(tx: Exec, batchId: string): Promise<void> {
  await tx
    .update(clientNotices)
    .set({ sendAfter: new Date() })
    .where(
      and(
        eq(clientNotices.kind, NOTICE_ARRIVED),
        eq(clientNotices.refType, 'batch'),
        eq(clientNotices.refId, batchId),
        eq(clientNotices.status, 'pending'),
      ),
    );
}

export interface ArrivedLine {
  /** The lot's letter on the label — the customer's own reference. */
  letter: string | null;
  /** Russian where we have it, Chinese otherwise: the office reads Uzbek. */
  name: string;
  boxCount: number;
  weightKg: number;
  volumeM3: number;
}

export interface ArrivedSummary {
  lines: ArrivedLine[];
  boxCount: number;
  weightKg: number;
  volumeM3: number;
  warehouseCode: string;
}

/**
 * What THIS client actually has off THIS truck, right now.
 *
 * Read at send time, never at claim time — that is the whole reason the
 * notice waits. Counted over the boxes that genuinely landed at the
 * destination, so a carton short-loaded in China or still on the truck is not
 * announced as delivered.
 *
 * Weight and volume are a SHARE of the lot, exactly as the batch card
 * computes them (#440): a box carries no weight of its own, the lot does, so
 * eight boxes of a twenty-box lot are eight twentieths of its kilos. Anything
 * else would report a partial delivery at the full lot's weight.
 */
export async function arrivedSummary(
  clientId: string,
  batchId: string,
  warehouseId: string,
): Promise<ArrivedSummary | null> {
  const rows = await db
    .select({
      letter: receiptLots.letter,
      nameRu: receiptLots.productNameRu,
      nameZh: receiptLots.productNameZh,
      lotBoxes: receiptLots.boxCount,
      lotKg: receiptLots.totalWeightKg,
      lotM3: receiptLots.totalVolumeM3,
      landed: sql<number>`count(${boxes.id})`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(
      and(
        eq(receipts.clientId, clientId),
        eq(boxes.currentWarehouseId, warehouseId),
        /*
         * The truck it came off — asked through `box_movements`, NEVER
         * through the live pointer.
         *
         * Landing NULLs `boxes.current_batch_id` (unload.ts sets it while it
         * writes the new status), so by the time this notice is sent every
         * box that arrived has forgotten its truck. #440 recorded this exact
         * trap on the batch card, where it made an arrived truck show «Σ 0»
         * precisely when the owner looked. The departure movement is the
         * durable record of who rode which lorry.
         */
        sql`EXISTS (
          SELECT 1 FROM box_movements bm
          WHERE bm.box_id = ${boxes.id}
            AND bm.ref_type = 'batch' AND bm.ref_id = ${batchId}
            AND bm.cause = 'batch_departed'
        )`,
        inArray(boxes.status, ['ready_for_pickup', 'in_stock']),
        isNull(receipts.voidedAt),
      ),
    )
    .groupBy(
      receiptLots.id,
      receiptLots.letter,
      receiptLots.productNameRu,
      receiptLots.productNameZh,
      receiptLots.boxCount,
      receiptLots.totalWeightKg,
      receiptLots.totalVolumeM3,
    )
    .orderBy(receiptLots.letter);

  if (rows.length === 0) return null;

  const lines: ArrivedLine[] = rows.map((row) => {
    const landed = Number(row.landed);
    const ofLot = Number(row.lotBoxes) || 0;
    const share = ofLot > 0 ? landed / ofLot : 0;
    return {
      letter: row.letter,
      name: row.nameRu?.trim() || row.nameZh,
      boxCount: landed,
      weightKg: Number(row.lotKg ?? 0) * share,
      volumeM3: Number(row.lotM3 ?? 0) * share,
    };
  });

  return {
    lines,
    boxCount: lines.reduce((sum, line) => sum + line.boxCount, 0),
    weightKg: lines.reduce((sum, line) => sum + line.weightKg, 0),
    volumeM3: lines.reduce((sum, line) => sum + line.volumeM3, 0),
    warehouseCode: '',
  };
}

/** Notices whose window has passed. Ordered oldest first; bounded. */
export async function dueArrivalNotices(limit = 50, now = new Date()) {
  return db
    .select()
    .from(clientNotices)
    .where(
      and(
        eq(clientNotices.status, 'pending'),
        eq(clientNotices.kind, NOTICE_ARRIVED),
        lte(clientNotices.sendAfter, now),
      ),
    )
    .orderBy(clientNotices.sendAfter)
    .limit(limit);
}

/**
 * How many times a notice may be attempted before we stop trying. A chat
 * that is simply unreachable must not sit in the queue for ever, and the
 * sweep runs every two minutes — five attempts is ten minutes of patience.
 */
export const MAX_NOTICE_ATTEMPTS = 5;

/**
 * Is this Telegram Bot-API refusal about THIS message (give up), or about
 * this MOMENT (try again)?
 *
 * The bot API answers with HTTP status codes rather than the gramjs strings
 * `isPermanentSendError` reads, so this is its own predicate — but the rule
 * is the same one rounds 48-49 settled: 429 (rate limited) and 5xx are the
 * world being busy, and retrying is right; 403 (the customer blocked the
 * bot) and 400 (no such chat) are facts about the recipient that will not
 * change, and knocking again is noise.
 */
export function isPermanentNoticeFailure(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

/**
 * Settle a notice.
 *
 * `skipped` is a real outcome and not a failure: a truck whose boxes were all
 * voided or moved on before the window closed has nothing to announce, and
 * retrying that for ever would be a queue that never empties.
 *
 * `pending` is settling too — it is what a TRANSIENT failure earns. The
 * status column is also the retry queue (`dueArrivalNotices` selects
 * `pending` and nothing else), so writing 'failed' after one 429 is the same
 * as telling the customer nothing, for ever. That is the defect this
 * argument exists to prevent: the burst where every truck lands at once is
 * exactly when Telegram throttles.
 */
export async function settleArrivalNotice(
  id: string,
  outcome: 'sent' | 'failed' | 'skipped' | 'pending',
  error?: string,
): Promise<void> {
  await db
    .update(clientNotices)
    .set({
      status: outcome,
      sentAt: outcome === 'sent' ? new Date() : null,
      attempts: sql`${clientNotices.attempts} + 1`,
      lastError: error?.slice(0, 500) ?? null,
    })
    .where(eq(clientNotices.id, id));
}
