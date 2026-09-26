import { eq, sql, type SQL } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import { clientTransactions, receipts } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { latestTxDate } from './dates';
import { exceedsRowUsd, fxResidueAllowance, nativeAmount } from './money-bounds';
import { lockOwnersTx, reconcileFxResidueTx } from './fx-residue';
import { rateFor } from '../costing/service';
import { RIDE_CAUSES, rideMovementSql } from '../batches/riders';
import { internalLegSql } from '../batches/internal';
import { usersWithPermission } from '../../platform/notifications/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';

export { followCompensationDealTx, receiptHasCompensation } from './compensation-follow';

/**
 * «Kompensatsiya» — what we pay a client back for LOST cargo (owner's Q15,
 * «15 a yoqolgan yuk a», 2026-09-25). He accepted the reading that
 * compensation UP TO our own price is paid by LOWERING the price, and the
 * part ABOVE it is a ledger kind of its own that lowers the client's balance
 * and that client's and that job's revenue; the cash then leaves by a
 * refund. One door does both halves in one press, so neither can be skipped:
 * the prices standing for that cargo are re-posted lower (void + copy,
 * keeping truck, deal and date — «Partiya foydasi» and the deal's profit
 * follow), and the rest is written as a compensation.
 *
 * It needs a carton recorded «yo'qolgan» (Q6: «sistema real hayotda
 * bo'layotgan narsalarni aniqlasin»). Damaged-but-delivered cargo is NOT
 * covered (Q29 unanswered — the ⭐ default A, lost cargo only): the switch is
 * `LOST_ONLY` below, one line.
 */

export class CompensationError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/**
 * Q29 (pending, default A): a compensation is written only against a prixod
 * with at least one carton marked «yo'qolgan». B would widen this to a
 * prixod with a handed-over carton and a mandatory reason; the one place
 * that decides it is `lostCountSql`.
 */
export const LOST_ONLY = true;

const cents = (value: number) => Math.round(value * 100) / 100;

type Exec = Pick<Db, 'execute'> | Pick<Tx, 'execute'>;

/**
 * The lost-cargo predicate, ONE home for the form's list and the door's check
 * (#513): per prixod, how many of its non-void cartons are lost and how many
 * there are. A carton lost on the road (`lost_in_transit`) is `lost` too.
 */
function lostCountSql(receiptIds: SQL): SQL {
  return sql`
    SELECT rl.receipt_id,
           (count(b.id) FILTER (WHERE b.status = 'lost'))::int AS lost,
           (count(b.id) FILTER (WHERE b.status <> 'void'))::int AS total
      FROM receipt_lots rl
      JOIN boxes b ON b.lot_id = rl.id
     WHERE rl.receipt_id IN (${receiptIds})
     GROUP BY rl.receipt_id`;
}

async function lostCountOn(handle: Exec, receiptId: string): Promise<{ lost: number; total: number }> {
  const rows = (await handle.execute(lostCountSql(sql`${receiptId}::uuid`))) as unknown as {
    lost: number;
    total: number;
  }[];
  const [row] = [...rows];
  return { lost: Number(row?.lost ?? 0), total: Number(row?.total ?? 0) };
}

export interface LostCargoReceipt {
  receiptId: string;
  number: string | null;
  dealId: string | null;
  dealCode: string | null;
  goods: string;
  lost: number;
  total: number;
}

/**
 * The form's list: this client's live prixods with a lost carton, newest
 * first. One grouped query, capped at 100 with the truth said (`truncated`).
 */
export async function lostCargoForClient(
  clientId: string,
): Promise<{ rows: LostCargoReceipt[]; truncated: boolean }> {
  const rows = (await db.execute(sql`
    SELECT r.id AS receipt_id, r.number, r.deal_id, d.code AS deal_code,
           string_agg(DISTINCT coalesce(nullif(rl.product_name_ru, ''), rl.product_name_zh), ', ') AS goods,
           (count(b.id) FILTER (WHERE b.status = 'lost'))::int AS lost,
           (count(b.id) FILTER (WHERE b.status <> 'void'))::int AS total,
           max(r.received_at) AS received_at
      FROM receipts r
      JOIN receipt_lots rl ON rl.receipt_id = r.id
      JOIN boxes b ON b.lot_id = rl.id
      LEFT JOIN deals d ON d.id = r.deal_id
     WHERE r.client_id = ${clientId}::uuid AND r.voided_at IS NULL
     GROUP BY r.id, d.code
    HAVING count(b.id) FILTER (WHERE b.status = 'lost') > 0
     ORDER BY max(r.received_at) DESC NULLS LAST, r.id
     LIMIT 101`)) as unknown as {
    receipt_id: string;
    number: string | null;
    deal_id: string | null;
    deal_code: string | null;
    goods: string | null;
    lost: number;
    total: number;
  }[];
  const list = [...rows];
  return {
    rows: list.slice(0, 100).map((row) => ({
      receiptId: row.receipt_id,
      number: row.number,
      dealId: row.deal_id,
      dealCode: row.deal_code,
      goods: row.goods ?? '',
      lost: Number(row.lost),
      total: Number(row.total),
    })),
    truncated: list.length > 100,
  };
}

export interface LostCargoCharge {
  id: string;
  receiptId: string;
  batchCode: string | null;
  dealCode: string | null;
  amount: number;
  currency: string;
  amountUsd: number;
  rateToUsd: string;
  txDate: string;
}

/**
 * The PRICES standing for a prixod's cargo — the within-price half he asked
 * for, made reachable. A live charge of the client that is either on a truck
 * a carton of the prixod RODE (the money rider rule, `rideMovementSql`;
 * never an internal leg, which is never billed) or typed on the prixod's
 * deal with no truck. Not a charge routed through a firm or half of a
 * three-cornered settlement (the void+copy claim refuses those). At most 20
 * per prixod, newest first. On the caller's handle: the form's list on the
 * pool, the door's re-check on its own transaction under the locks.
 */
export async function lostCargoChargesOn(
  handle: Exec,
  clientId: string,
  receiptIds: string[],
): Promise<LostCargoCharge[]> {
  const ids = [...new Set(receiptIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await handle.execute(sql`
    WITH r AS (
      SELECT id, deal_id FROM receipts WHERE id IN (${list}) AND client_id = ${clientId}::uuid
    ),
    rode AS (
      SELECT DISTINCT r.id AS receipt_id, bm.ref_id AS batch_id
        FROM r
        JOIN receipt_lots rl ON rl.receipt_id = r.id
        JOIN boxes b ON b.lot_id = rl.id AND b.status <> 'void'
        JOIN box_movements bm ON bm.box_id = b.id
       WHERE bm.ref_type = 'batch' AND bm.cause IN ${RIDE_CAUSES} AND ${rideMovementSql('bm')}
    ),
    cand AS (
      SELECT r.id AS receipt_id, ct.id, ct.batch_id, ct.deal_id, ct.amount, ct.currency, ct.amount_usd,
             ct.rate_to_usd, ct.tx_date, ct.created_at,
             row_number() OVER (PARTITION BY r.id ORDER BY ct.tx_date DESC, ct.created_at DESC) AS n
        FROM r
        JOIN client_transactions ct
          ON ct.client_id = ${clientId}::uuid AND ct.type = 'charge' AND ct.voided_at IS NULL
         AND ct.partner_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM partner_transactions pt WHERE pt.client_tx_id = ct.id)
       WHERE (ct.batch_id IS NULL AND r.deal_id IS NOT NULL AND ct.deal_id = r.deal_id)
          OR EXISTS (SELECT 1 FROM rode WHERE rode.receipt_id = r.id AND rode.batch_id = ct.batch_id)
    )
    SELECT c.receipt_id, c.id, c.amount, c.currency, c.amount_usd, c.rate_to_usd, c.tx_date::text AS tx_date,
           cb.code AS batch_code, d.code AS deal_code
      FROM cand c
      LEFT JOIN batches cb ON cb.id = c.batch_id
      LEFT JOIN warehouses co ON co.id = cb.origin_warehouse_id
      LEFT JOIN warehouses cd ON cd.id = cb.dest_warehouse_id
      LEFT JOIN deals d ON d.id = c.deal_id
     WHERE c.n <= 20 AND (c.batch_id IS NULL OR NOT ${internalLegSql('co', 'cd')})
     ORDER BY c.receipt_id, c.tx_date DESC, c.created_at DESC`)) as unknown as {
    receipt_id: string;
    id: string;
    amount: string;
    currency: string;
    amount_usd: string;
    rate_to_usd: string;
    tx_date: string;
    batch_code: string | null;
    deal_code: string | null;
  }[];
  return [...rows].map((row) => ({
    id: row.id,
    receiptId: row.receipt_id,
    batchCode: row.batch_code,
    dealCode: row.deal_code,
    amount: Number(row.amount),
    currency: row.currency,
    amountUsd: Number(row.amount_usd),
    rateToUsd: row.rate_to_usd,
    txDate: row.tx_date,
  }));
}

export const compensationSchema = z
  .object({
    clientId: z.string().uuid(),
    receiptId: z.string().uuid(),
    /** The part ABOVE our own price; absent when only prices are lowered. */
    amount: nativeAmount().optional(),
    currency: z.string().length(3).toUpperCase(),
    txDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().min(3).max(2000),
    /** Prices of this cargo to lower, each to its new amount (0 = remove). */
    reprices: z
      .array(z.object({ chargeId: z.string().uuid(), newAmount: z.number().min(0).max(999_999_999_999.99) }))
      .max(20)
      .default([]),
  })
  .refine((v) => new Set(v.reprices.map((r) => r.chargeId)).size === v.reprices.length, {
    message: 'duplicate_charge',
  });
export type CompensationInput = z.input<typeof compensationSchema>;

/**
 * The lost-cargo door. `door` is REQUIRED — an optional door fails open
 * (U33, #790): money given to a client is the kassa holders' act
 * (`mayPickTill`), the same predicate as the refund it funds.
 *
 * ONE transaction: the prixod locked FIRST (a client change, a re-file or a
 * void either finishes before this reads it or waits for it — the pair rules
 * of `followCompensationDealTx`), then the client's money lock, then every
 * check re-read under both — the lost carton, the prices of that cargo — so
 * a stale screen can lower nothing it no longer shows. The deal is DERIVED
 * from the locked prixod, never taken from the form, and follows it later.
 */
export async function addCompensation(
  raw: CompensationInput,
  ctx: AuditContext,
  door: { mayPayClient: boolean },
): Promise<{ compensationId: string | null; dealId: string | null; repriced: number; batchIds: string[] }> {
  if (!ctx.actorId) throw new CompensationError('unauthenticated');
  const actorId = ctx.actorId;
  if (!door.mayPayClient) throw new CompensationError('forbidden');
  const parsed = compensationSchema.safeParse(raw);
  if (!parsed.success) {
    // Name the field (review): the reason is the one a person can fix from
    // the words; a figure the action already read is named by its own code.
    const field = parsed.error.issues[0]?.path[0];
    throw new CompensationError(
      field === 'note' ? 'validation' : field === 'amount' ? 'bad_amount' : field === 'reprices' ? 'bad_price' : 'bad_input',
    );
  }
  const input = parsed.data;
  if (input.txDate > latestTxDate()) throw new CompensationError('future_date');
  if (!input.amount && input.reprices.length === 0) throw new CompensationError('nothing_to_do');
  // Pool reads BEFORE the transaction (#714): only the rate. Everything else
  // is read on the transaction, under the locks, so it cannot move under the write.
  const rate = input.amount ? await rateFor(input.currency, input.txDate) : null;
  if (input.amount && rate === null) throw new CompensationError('fx_missing');
  const amountUsd = input.amount ? cents(input.amount * rate!) : 0;
  if (amountUsd && exceedsRowUsd(amountUsd)) throw new CompensationError('amount_too_large');

  return db.transaction(async (tx) => {
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, input.receiptId)).for('update');
    if (!receipt || receipt.clientId !== input.clientId || receipt.voidedAt) {
      throw new CompensationError('receipt_mismatch');
    }
    await lockOwnersTx(tx, { clientIds: [input.clientId] });
    const { lost } = await lostCountOn(tx, input.receiptId);
    if (LOST_ONLY && lost === 0) throw new CompensationError('no_lost_cargo');

    const allowed = new Map(
      (await lostCargoChargesOn(tx, input.clientId, [input.receiptId])).map((charge) => [charge.id, charge]),
    );
    const batchIds = new Set<string>();
    for (const change of input.reprices) {
      const charge = allowed.get(change.chargeId);
      if (!charge) throw new CompensationError('charge_not_for_cargo');
      if (!(change.newAmount < charge.amount - 0.004)) throw new CompensationError('price_not_lower');
      const reason = `narx tushirildi — yo‘qolgan yuk ${receipt.number ?? ''}: ${input.note}`.slice(0, 2000);
      // void + re-post, the house rule for a money correction (#528): the
      // claim IS the WHERE — live, a charge, no firm, not half of a
      // settlement — re-judged at the write.
      const claimed = (await tx.execute(sql`
        UPDATE client_transactions
           SET voided_at = now(), voided_by = ${actorId}::uuid, void_reason = ${reason}
         WHERE id = ${change.chargeId}::uuid AND voided_at IS NULL AND type = 'charge' AND partner_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM partner_transactions pt WHERE pt.client_tx_id = ${change.chargeId}::uuid)
         RETURNING id, client_id, batch_id, deal_id, tx_date::text AS tx_date, currency, rate_to_usd, created_at::text AS created_at`)) as unknown as {
        id: string;
        client_id: string;
        batch_id: string | null;
        deal_id: string | null;
        tx_date: string;
        currency: string;
        rate_to_usd: string;
        created_at: string;
      }[];
      const [old] = [...claimed];
      if (!old) throw new CompensationError('charge_taken');
      if (old.batch_id) batchIds.add(old.batch_id);
      let repostedId: string | null = null;
      if (change.newAmount > 0) {
        // The copy keeps EVERY clock of the original (moveCharge's rule): the
        // truck, the job, the day (the P&L month and the ageing) and the
        // frozen rate — copied, never re-read (Q18). `created_at` too, so the
        // kurs farqi cycle order does not move.
        repostedId = uuidv4();
        await tx.insert(clientTransactions).values({
          id: repostedId,
          clientId: old.client_id,
          type: 'charge',
          amount: change.newAmount.toFixed(2),
          currency: old.currency,
          rateToUsd: old.rate_to_usd,
          amountUsd: cents(change.newAmount * Number(old.rate_to_usd)).toFixed(2),
          method: null,
          txDate: old.tx_date,
          batchId: old.batch_id,
          dealId: old.deal_id,
          accountId: null,
          note: reason,
          createdBy: actorId,
          createdAt: new Date(old.created_at),
        });
      }
      await writeAudit(tx, ctx, {
        entityType: 'client_transaction',
        entityId: old.id,
        action: 'void',
        after: { reason, repricedTo: repostedId, from: 'compensation', receiptId: input.receiptId },
      });
      if (repostedId) {
        await writeAudit(tx, ctx, {
          entityType: 'client_transaction',
          entityId: repostedId,
          action: 'create',
          after: {
            clientId: old.client_id,
            type: 'charge',
            amount: change.newAmount,
            currency: old.currency,
            repricedFrom: old.id,
            ...(old.batch_id ? { batchId: old.batch_id } : {}),
          },
        });
      }
    }

    let compensationId: string | null = null;
    if (amountUsd > 0 && input.amount) {
      compensationId = uuidv4();
      await tx.insert(clientTransactions).values({
        id: compensationId,
        clientId: input.clientId,
        type: 'compensation',
        receiptId: input.receiptId,
        // Derived under the lock, never the form's; FOLLOWS the prixod.
        dealId: receipt.dealId,
        method: null,
        accountId: null,
        partnerId: null,
        batchId: null,
        note: input.note,
        amount: String(input.amount),
        currency: input.currency,
        rateToUsd: String(rate),
        amountUsd: amountUsd.toFixed(2),
        txDate: input.txDate,
        createdBy: actorId,
      });
    }
    // A lowered price or a compensation can bring a currency back to zero —
    // its kurs farqi is written in the same commit (0103, fence F2).
    await reconcileFxResidueTx(tx, { clientIds: [input.clientId] }, ctx);
    if (compensationId) {
      await writeAudit(tx, ctx, {
        entityType: 'client_transaction',
        entityId: compensationId,
        action: 'create',
        after: {
          type: 'compensation',
          clientId: input.clientId,
          receiptId: input.receiptId,
          amount: input.amount,
          currency: input.currency,
          amountUsd,
          lostBoxes: lost,
          repriced: input.reprices.map((change) => change.chargeId),
          reason: input.note,
          ...(receipt.dealId ? { dealId: receipt.dealId } : {}),
        },
      });
    }
    return { compensationId, dealId: receipt.dealId, repriced: input.reprices.length, batchIds: [...batchIds] };
  });
}

/**
 * The cover a compensation's VOID must keep (owner's Q15 (1): «money we
 * handed a client must never silently become his debt»). Four sums over the
 * client's live rows, EXCLUDING this compensation, on the void's own
 * transaction under the client's money lock.
 */
export interface CompensationCover {
  refundsSinceUsd: number;
  paymentsUsd: number;
  chargesUsd: number;
  otherCompensationsUsd: number;
}

export async function compensationCoverTx(tx: Tx, clientId: string, compensationId: string): Promise<CompensationCover> {
  const rows = (await tx.execute(sql`
    SELECT
      coalesce(sum(t.amount_usd) FILTER (WHERE t.type = 'payment'), 0) AS payments,
      coalesce(sum(t.amount_usd) FILTER (WHERE t.type = 'charge'), 0) AS charges,
      coalesce(sum(t.amount_usd) FILTER (WHERE t.type = 'compensation' AND t.id <> ${compensationId}::uuid), 0) AS others,
      -- A refund older than every compensation cannot have been funded by one.
      coalesce(sum(t.amount_usd) FILTER (
        WHERE t.type = 'refund'
          AND t.created_at >= (SELECT min(c.created_at) FROM client_transactions c
                                WHERE c.client_id = ${clientId}::uuid AND c.type = 'compensation'
                                  AND c.voided_at IS NULL)), 0) AS refunds_since
      FROM client_transactions t
     WHERE t.client_id = ${clientId}::uuid AND t.voided_at IS NULL`)) as unknown as {
    payments: string;
    charges: string;
    others: string;
    refunds_since: string;
  }[];
  const [row] = [...rows];
  return {
    refundsSinceUsd: cents(Number(row?.refunds_since ?? 0)),
    paymentsUsd: cents(Number(row?.payments ?? 0)),
    chargesUsd: cents(Number(row?.charges ?? 0)),
    otherCompensationsUsd: cents(Number(row?.others ?? 0)),
  };
}

/**
 * May this compensation be voided? The cash handed back since compensations
 * began must stay covered by the compensations that remain plus what the
 * client paid beyond his charges — the refund cap's own idea (U04), asked of
 * the void, with its own FX allowance (2 % or $5, `fxResidueAllowance`).
 * A compensation that only offset a debt voids freely (nothing was handed
 * out), so a typo is always correctable: write the right one first, then
 * void this.
 */
export function compensationVoidFits(s: CompensationCover): boolean {
  return (
    s.refundsSinceUsd - Math.max(0, s.paymentsUsd - s.chargesUsd) <=
    s.otherCompensationsUsd + fxResidueAllowance(s.refundsSinceUsd) + 0.004
  );
}

/**
 * «A carton was found on a compensated prixod» — told at once, never only a
 * passive mark (Q6): the accountant(s) and the client's seller, in ONE call
 * to the union (markBoxLost's precedent: the logist is routinely somebody's
 * seller, and two calls would send one person the sentence twice). On the
 * pool, AFTER the restore committed: a notice failure never rolls a found box
 * back. Returns how many were queued.
 */
export async function compensatedCargoFound(boxId: string, actorId: string | null): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT r.id AS receipt_id, r.number, c.client_code, c.sales_manager_id, b.short_code,
           count(ct.id)::int AS n, coalesce(sum(ct.amount_usd), 0) AS usd
      FROM boxes b
      JOIN receipt_lots rl ON rl.id = b.lot_id
      JOIN receipts r ON r.id = rl.receipt_id
      JOIN clients c ON c.id = r.client_id
      JOIN client_transactions ct ON ct.receipt_id = r.id AND ct.type = 'compensation' AND ct.voided_at IS NULL
     WHERE b.id = ${boxId}::uuid
     GROUP BY r.id, c.id, b.id`)) as unknown as {
    receipt_id: string;
    number: string | null;
    client_code: string;
    sales_manager_id: string | null;
    short_code: string;
    n: number;
    usd: string;
  }[];
  const [row] = [...rows];
  if (!row || Number(row.n) === 0) return 0;
  const userIds = [
    ...(await usersWithPermission('finance.expenses')),
    ...(row.sales_manager_id ? [row.sales_manager_id] : []),
  ];
  if (userIds.length === 0) return 0;
  return notifyStaffTelegram({
    userIds,
    type: 'CompensatedCargoFound',
    exceptUserId: actorId,
    text:
      `🤝 ${row.client_code} — kompensatsiya yozilgan karobka topildi: ${row.number ?? ''} (${row.short_code}). ` +
      `Kompensatsiya: $${cents(Number(row.usd)).toFixed(2)}. Mijoz yukni ham, pulni ham olmasin — buxgalter tekshiradi.`,
  });
}

/**
 * The receipts among these whose compensation stands and ONE OF THESE VERY
 * cartons came back from «yo'qolgan» after it was written — the issue
 * screen's ⚠ (no amount: the warehouse reads cargo, not money). A warning,
 * never a gate: the cargo is the client's. Asked of the listed box and not of
 * the receipt: on a partial loss the seven cartons that arrived are handed
 * over like any other, and a ⚠ «a box has been found» beside them would be
 * false every day. Same clause as the ledger row's `foundSince`.
 */
export async function compensatedReceiptsAmong(boxIds: string[]): Promise<{ receiptNumber: string }[]> {
  const ids = [...new Set(boxIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT DISTINCT r.number
      FROM boxes b
      JOIN receipt_lots rl ON rl.id = b.lot_id
      JOIN receipts r ON r.id = rl.receipt_id
     WHERE b.id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND EXISTS (SELECT 1 FROM client_transactions ct
                     JOIN box_movements bm ON bm.box_id = b.id
                    WHERE ct.receipt_id = r.id AND ct.type = 'compensation' AND ct.voided_at IS NULL
                      AND bm.from_status = 'lost' AND bm.to_status NOT IN ('lost', 'void')
                      AND bm.created_at > ct.created_at)
     ORDER BY r.number`)) as unknown as { number: string | null }[];
  return [...rows].map((row) => ({ receiptNumber: row.number ?? '' }));
}
