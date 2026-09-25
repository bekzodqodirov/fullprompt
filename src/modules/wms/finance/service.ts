import { and, desc, eq, gte, inArray, isNull, lte, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { latestTxDate } from './dates';
import { fxResidueAllowance, exceedsRowUsd, nativeAmount } from './money-bounds';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  batches,
  clients,
  clientTransactions,
  deals,
  moneyAccounts,
  partnerTransactions,
  partners,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import type { Db, Tx } from '../../platform/db/client';
import { LEDGER_TYPES, PRICE_KINDS } from './ledger-kinds';
import { fxWalkSql, lockOwnersTx, nativeSql, ownersSql, reconcileFxResidueTx } from './fx-residue';
import { rateFor } from '../costing/service';
import { batchRoute } from '../batches/internal';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { cargoAboard } from '../batches/lots';

/**
 * Client money ledger (Phase 2.1, owner's rules): there are NO tariffs — the
 * sales manager and the client agree a price per shipment, so the ledger only
 * records agreed charges (set by VED manager/accountant after customs) and
 * incoming payments (cash/card/transfer, any currency). Everything is frozen
 * to USD at entry time; balance = Σ charges − Σ payments.
 */

export class FinanceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/**
 * The one sign rule of the client ledger (0101): a charge and a refund RAISE
 * what the client owes us, a payment lowers it. Every balance restates this
 * through `signedUsdSql` — `CASE WHEN type = 'charge' … ELSE -…` read a refund
 * as a payment, i.e. money we handed back as money we received, and
 * `tests/unit/client-ledger-sign.test.ts` keeps that shape out of `src/`.
 */
export { LEDGER_TYPES, type LedgerType, signedUsd, settlesUsd } from './ledger-kinds';

/** +amount_usd for a charge or a refund, −amount_usd for a payment. */
export function signedUsdSql(table: { type: AnyColumn; amountUsd: AnyColumn } = clientTransactions): SQL {
  return sql`(CASE WHEN ${table.type} = 'payment' THEN -${table.amountUsd} ELSE ${table.amountUsd} END)`;
}

/**
 * Money RECEIVED net of money handed back: +payment, −refund, 0 for a charge.
 * «To'landi» on a screen that also shows a balance must be this, or the two
 * columns stop adding up to it.
 */
export function netPaidUsdSql(table: { type: AnyColumn; amountUsd: AnyColumn } = clientTransactions): SQL {
  return sql`(CASE WHEN ${table.type} = 'payment' THEN ${table.amountUsd} WHEN ${table.type} = 'refund' THEN -${table.amountUsd} ELSE 0 END)`;
}

/**
 * What a row takes off the balance, in SQL (0103): payment +, refund −, a kurs
 * farqi −(its signed dollars), a charge 0 — for the walks that settle charges
 * oldest-first. The JS twin is `settlesUsd` in ledger-kinds.ts.
 */
export function settlesUsdSql(table: { type: AnyColumn; amountUsd: AnyColumn } = clientTransactions): SQL {
  // −(the sign rule) for every non-price kind, exactly as the JS twin says:
  // derived from LEDGER_RULES, so a kind added there needs no second answer.
  const prices = sql.join(
    PRICE_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  return sql`(CASE WHEN ${table.type} IN (${prices}) THEN 0 ELSE -${signedUsdSql(table)} END)`;
}

/**
 * A client's money per currency — its OWN money (the kinds' native signs, a
 * kurs farqi moving nothing) and the dollars the balance adds — on the
 * caller's handle. The card's «O'z valyutasida» line (pool) and the refund
 * cap (inside its transaction, #714) read the same statement.
 */
export async function clientMoneyByCurrency(
  handle: Db | Tx,
  clientId: string,
): Promise<{ currency: string; native: number; usd: number }[]> {
  const rows = (await handle.execute(sql`
    SELECT t.currency, coalesce(sum(${nativeSql('client')}), 0) AS native,
           coalesce(sum(CASE WHEN t.type = 'payment' THEN -t.amount_usd ELSE t.amount_usd END), 0) AS usd
      FROM client_transactions t
     WHERE t.client_id = ${clientId}::uuid AND t.voided_at IS NULL
     GROUP BY t.currency
     ORDER BY t.currency
  `)) as unknown as { currency: string; native: string; usd: string }[];
  const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;
  return [...rows].map((row) => ({ currency: row.currency, native: cents(row.native), usd: cents(row.usd) }));
}

/** The card's per-currency line (pool). */
export function clientNativeBalances(clientId: string) {
  return clientMoneyByCurrency(db, clientId);
}

/**
 * May this refund be handed out (U04 + Q14, money-5)? When the client holds
 * an ADVANCE in the refund's own currency and owes nothing in any other, the
 * cap is that advance in its own money: 125,000,000 so'm paid in and handed
 * back in full after the rate moved is the whole advance, whatever its
 * dollars now read — and the kurs farqi reconciler, in the same
 * transaction, closes the so'm cycle. Otherwise the dollar rule stands
 * (`refundFitsAdvance`): a client who paid dollar charges in so'm must not
 * be handed back so'm that paid for dollars.
 */
export function refundFits(
  refund: { amount: number; currency: string; amountUsd: number },
  balances: { currency: string; native: number; usd: number }[],
): boolean {
  const own = balances.find((row) => row.currency === refund.currency)?.native ?? 0;
  const owesElsewhere = balances.some((row) => row.currency !== refund.currency && row.native > 0.004);
  if (own < -0.004 && !owesElsewhere) return refund.amount <= -own + 0.004;
  const usd = balances.reduce((sum, row) => sum + row.usd, 0);
  return refundFitsAdvance(refund.amountUsd, -Math.round(usd * 100) / 100);
}

/**
 * May a refund of `refundUsd` be handed out of an advance of `advanceUsd`?
 * (U04, the owner's A.) The FX residue it may carry over the advance: the
 * same so'm an advance was paid in, handed back after the rate moved, reads
 * more dollars than it came in as (measured: $300 → $301.88) — the owner's
 * «bir necha dollarlik farq baribir o'tkaziladi». The allowance is the
 * merge's own (2 % or $5, the looser — `fxResidueAllowance`), because a flat
 * $5 refused a 125-million-so'm advance handed back after a 1.2 % move. The
 * FX package replaces this with a native-currency rule.
 */
export function refundFitsAdvance(refundUsd: number, advanceUsd: number): boolean {
  return advanceUsd > 0.009 && refundUsd <= advanceUsd + fxResidueAllowance(advanceUsd) + 0.004;
}

export const transactionSchema = z
  .object({
    clientId: z.string().uuid(),
    type: z.enum(LEDGER_TYPES),
    // The column's bound in every currency; the dollar ceiling is below (U44).
    amount: nativeAmount(),
    currency: z.string().length(3).toUpperCase(),
    method: z.enum(['cash', 'card', 'transfer']).optional(),
    txDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    batchId: z.string().uuid().optional(),
    /** The job this charge is for, when it was raised from a deal card. */
    dealId: z.string().uuid().optional().or(z.literal('')),
    /**
     * Which cash box the money landed in (Phase 2.4). Optional: rows entered
     * before accounts existed have none, and the cash-flow report treats an
     * unassigned payment as money received but not yet placed.
     */
    accountId: z.string().uuid().optional().or(z.literal('')),
    note: z.string().trim().max(2000).optional().or(z.literal('')),
  })
  .refine((v) => v.type !== 'charge' || !v.method, { message: 'method_on_charge' });
export type TransactionInput = z.infer<typeof transactionSchema>;

export async function addTransaction(input: TransactionInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  if (input.txDate > latestTxDate()) throw new FinanceError('future_date');
  // A named deal must be THIS client's. The deal id steers the deferral
  // netting (#251) — a payment parked on another client's deal would quietly
  // re-open their handover gate — and a select's value is a forged post until
  // the server has checked it (the inline-picker rule, #507).
  if (input.dealId) {
    const deal = await db.query.deals.findFirst({ where: eq(deals.id, input.dealId) });
    if (!deal || deal.clientId !== input.clientId) throw new FinanceError('deal_mismatch');
  }
  // A price on an INTERNAL truck is refused here, not merely left off the
  // screen (#531): the pricing form posts a batch id, and a hand-built post
  // would otherwise bill a client for a leg the owner never bills (C1a,
  // 2026-09-24). A payment may still name any truck — money received is not
  // a price.
  let dealId = input.dealId || null;
  if (input.type === 'charge' && input.batchId) {
    const route = await batchRoute(input.batchId);
    if (!route) throw new FinanceError('batch_not_found');
    if (route.internal) throw new FinanceError('internal_batch');
    // A price on a truck names the client's cargo ON it (0104, U31 claim 1):
    // with none aboard it names nothing, and the no-cargo price is exactly
    // the one the screens then call «yuki ketmagan». Asked AFTER the internal
    // check, so an internal truck still says why it is refused.
    const aboard = await cargoAboard(input.batchId, input.clientId);
    if (!aboard.aboard) throw new FinanceError('client_not_aboard');
    // A price set on the truck is also the JOB's money when the client's
    // cargo aboard is one deal's and nothing else (owner's R3a, 2026-09-24:
    // «mashinada qo'yilgan narx bitimga ham yozilsin»). Derived here from the
    // cargo, never taken from the form: the pricing screen only ANNOUNCES it,
    // and a posted deal id would be a forged post until checked (#507).
    if (!dealId) dealId = aboard.dealId;
  }
  // A refund is money that LEFT a kassa for the client (R6a): it names the
  // box, never a truck (it is not a price) and never a partner (a partner-
  // routed payment is the settlement screen's). The database says the same
  // (client_transactions_refund_check); refused here in words first.
  if (input.type === 'refund') {
    if (!input.accountId) throw new FinanceError('account_required');
    if (input.batchId) throw new FinanceError('refund_on_batch');
  }
  // A named cash box must speak the row's currency. The till balances sum
  // NATIVE amounts per box, so 500 USD dropped into a som till reads as 500
  // som — ~$500 quietly vanishing from the Balans while the drawer count can
  // never reconcile. One slip of an 86-option dropdown; refused, not trusted.
  if (input.accountId) {
    const [account] = await db
      .select({ currency: moneyAccounts.currency })
      .from(moneyAccounts)
      .where(eq(moneyAccounts.id, input.accountId));
    if (account && account.currency !== input.currency) {
      throw new FinanceError('account_currency_mismatch');
    }
  }
  // The rate is frozen NOW — a later FX edit must not move settled money.
  // No rate for the currency yet → the accountant enters one first.
  const rate = await rateFor(input.currency, input.txDate);
  if (rate === null) throw new FinanceError('fx_missing');
  const amountUsd = Math.round(input.amount * rate * 100) / 100;
  if (exceedsRowUsd(amountUsd)) throw new FinanceError('amount_too_large');

  const values = {
    clientId: input.clientId,
    type: input.type,
    amount: String(input.amount),
    currency: input.currency,
    rateToUsd: String(rate),
    amountUsd: String(amountUsd),
    method: input.type === 'charge' ? null : (input.method ?? 'cash'),
    txDate: input.txDate,
    batchId: input.batchId ?? null,
    dealId,
    accountId: input.accountId || null,
    note: input.note || null,
    createdBy: ctx.actorId,
  };
  // ONE transaction for every kind (0103): the client's money lock first,
  // the write, then the kurs farqi reconciler (Q14) — a payment that brings
  // a currency back to zero writes its «kurs farqi» in the same commit, or
  // a crash in between would leave the client blocked at the warehouse.
  //
  // A refund hands back an ADVANCE (U04, owner's answer A, 2026-09-25). One
  // larger than the client's credit used to become a new debt in silence —
  // a settled client handed $300 for lost cartons then «owed» $300 on five
  // screens and the handover gate stopped his next cargo. So it is refused,
  // and the sentence names the right path. The check and the insert share
  // the transaction under the client's lock, or two presses at once would
  // each see the whole advance; the balance is read on the transaction's own
  // connection (#714), with the kinds' own signs (#1014).
  const row = await db.transaction(async (tx) => {
    await lockOwnersTx(tx, { clientIds: [input.clientId] });
    if (input.type === 'refund') {
      const held = await clientMoneyByCurrency(tx, input.clientId);
      if (!refundFits({ amount: input.amount, currency: input.currency, amountUsd }, held)) {
        throw new FinanceError('refund_exceeds_advance');
      }
    }
    const [inserted] = await tx.insert(clientTransactions).values(values).returning();
    await reconcileFxResidueTx(tx, { clientIds: [input.clientId] }, ctx);
    await writeAudit(tx, ctx, {
      entityType: 'client_transaction',
      entityId: inserted!.id,
      action: 'create',
      after: {
        clientId: input.clientId,
        type: input.type,
        amount: input.amount,
        currency: input.currency,
        amountUsd,
        // Named when set: a truck price can land on a deal nobody typed (R3a),
        // and the history is where somebody will ask why.
        ...(dealId ? { dealId } : {}),
      },
    });
    return inserted!;
  });
  return row;
}

/**
 * «🚚 Ko'chirish» — a price moved onto the truck(s) the cargo really rode
 * (0104): a card-only price onto its truck, a Q21 no-cargo price onto the
 * truck the cargo left on, a Q2 found-back share split off onto the next
 * truck. Amounts are in the row's OWN currency and must add up to it to the
 * cent; at most five parts, each on a different truck.
 */
export const moveChargeSchema = z.object({
  txId: z.string().uuid(),
  parts: z
    .array(z.object({ batchId: z.string().uuid(), amount: nativeAmount() }))
    .min(1)
    .max(5)
    .refine((parts) => new Set(parts.map((p) => p.batchId)).size === parts.length, { message: 'duplicate_truck' }),
});
export type MoveChargeInput = z.infer<typeof moveChargeSchema>;

/**
 * Void + re-entry in ONE transaction, the house rule for a money correction
 * (#528), in one press so the two halves cannot drift. The copies keep EVERY
 * clock of the original:
 *
 * - `tx_date` — the P&L month, the monthly plan and the ageing bucket stay
 *   where they were: moving an August price in September must not take $600
 *   out of a reported August or restart an 18-day debt at 0.
 * - `rate_to_usd` / `amount_usd` — copied, never re-read (Q18: a rate may
 *   since have been corrected, and a correction here must not look like FX).
 *   The last part takes `amount_usd − Σ others`, so the dollars add up to
 *   the original to the cent.
 * - `created_at` — the off-truck warning's «priced at» (`offTruckPrices`)
 *   stays honest, and the FX cycle order (`(currency, tx_date, created_at,
 *   id)`) does not move.
 *
 * The audit rows carry the press time and `created_by` names the mover.
 * Every part passes the price door's own checks (`internal_batch`,
 * `client_not_aboard`, the derived deal — R3a), so a move can never create
 * the no-cargo price the warnings exist to name. The claim re-judges the row
 * as it stands at the write: live, a charge, no partner, and not half of a
 * three-cornered settlement.
 *
 * STATED: the FX package's `reconcileFxResidueTx` is not wired here — it had
 * not landed when this was written; its F2 fence names `moveCharge`.
 */
export async function moveCharge(input: MoveChargeInput, ctx: AuditContext): Promise<{ ids: string[] }> {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  const actorId = ctx.actorId;
  const row = await db.query.clientTransactions.findFirst({ where: eq(clientTransactions.id, input.txId) });
  if (!row || row.voidedAt || row.type !== 'charge' || row.partnerId) throw new FinanceError('not_movable');

  const cents = (value: number) => Math.round(value * 100);
  if (input.parts.reduce((sum, part) => sum + cents(part.amount), 0) !== cents(Number(row.amount))) {
    throw new FinanceError('move_sum_mismatch');
  }
  if (input.parts.length === 1 && input.parts[0]!.batchId === row.batchId) throw new FinanceError('move_noop');

  // The price door's own checks, per part, on the pool BEFORE the transaction
  // (#714) — the same order `addTransaction` asks them in.
  const deals = new Map<string, string | null>();
  for (const part of input.parts) {
    const route = await batchRoute(part.batchId);
    if (!route) throw new FinanceError('batch_not_found');
    if (route.internal) throw new FinanceError('internal_batch');
    const aboard = await cargoAboard(part.batchId, row.clientId);
    if (!aboard.aboard) throw new FinanceError('client_not_aboard');
    deals.set(part.batchId, aboard.dealId ?? row.dealId ?? null);
  }
  const codeRows = await db
    .select({ id: batches.id, code: batches.code })
    .from(batches)
    .where(inArray(batches.id, [...new Set([...input.parts.map((p) => p.batchId), ...(row.batchId ? [row.batchId] : [])])]));
  const codeOf = new Map(codeRows.map((r) => [r.id, r.code]));
  const reason = `ko‘chirildi: ${row.batchId ? (codeOf.get(row.batchId) ?? '—') : 'karta'} → ${input.parts
    .map((part) => codeOf.get(part.batchId) ?? '—')
    .join(', ')}`;

  const rate = Number(row.rateToUsd);
  const totalUsd = cents(Number(row.amountUsd));
  const usdParts = input.parts.map((part) => cents(part.amount * rate));
  usdParts[usdParts.length - 1] = totalUsd - usdParts.slice(0, -1).reduce((a, b) => a + b, 0);

  const ids = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(clientTransactions)
      .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: reason })
      .where(
        and(
          eq(clientTransactions.id, row.id),
          isNull(clientTransactions.voidedAt),
          eq(clientTransactions.type, 'charge'),
          isNull(clientTransactions.partnerId),
          sql`NOT EXISTS (SELECT 1 FROM partner_transactions pt WHERE pt.client_tx_id = ${row.id}::uuid)`,
        ),
      )
      .returning({ id: clientTransactions.id });
    if (claimed.length === 0) throw new FinanceError('not_movable');
    const inserted = await tx
      .insert(clientTransactions)
      .values(
        input.parts.map((part, index) => ({
          clientId: row.clientId,
          type: 'charge',
          amount: part.amount.toFixed(2),
          currency: row.currency,
          rateToUsd: row.rateToUsd,
          amountUsd: (usdParts[index]! / 100).toFixed(2),
          method: null,
          txDate: row.txDate,
          batchId: part.batchId,
          dealId: deals.get(part.batchId) ?? null,
          accountId: null,
          note: row.note,
          createdBy: actorId,
          createdAt: row.createdAt,
        })),
      )
      .returning({ id: clientTransactions.id });
    await writeAudit(tx, ctx, {
      entityType: 'client_transaction',
      entityId: row.id,
      action: 'void',
      after: { reason, movedTo: inserted.map((r) => r.id) },
    });
    for (const [index, part] of inserted.entries()) {
      await writeAudit(tx, ctx, {
        entityType: 'client_transaction',
        entityId: part.id,
        action: 'create',
        after: {
          clientId: row.clientId,
          type: 'charge',
          amount: input.parts[index]!.amount,
          currency: row.currency,
          amountUsd: usdParts[index]! / 100,
          batchId: input.parts[index]!.batchId,
          movedFrom: row.id,
        },
      });
    }
    return inserted.map((r) => r.id);
  });
  return { ids };
}

/**
 * Put an unplaced payment into the cash box it actually landed in (audit A2).
 *
 * A payment saved before the kassa became required took its amount off the
 * Balans receivable and put it in no till, and nothing on any screen could
 * say where it went — the only UPDATE this table had was the void. The claim
 * is the WHERE: only a live payment with no box and no partner (a settlement's
 * money is placed in the firm's account, never a till) can be placed, once,
 * and only into a box speaking its currency — the ledger rule every door
 * already asks.
 */
export async function placePayment(id: string, accountId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  const row = await db.query.clientTransactions.findFirst({ where: eq(clientTransactions.id, id) });
  if (!row || row.type !== 'payment' || row.voidedAt) throw new FinanceError('not_found');
  if (row.partnerId) throw new FinanceError('settlement_placed');
  const [account] = await db
    .select({ currency: moneyAccounts.currency, active: moneyAccounts.active })
    .from(moneyAccounts)
    .where(eq(moneyAccounts.id, accountId));
  if (!account || !account.active) throw new FinanceError('not_found');
  if (account.currency !== row.currency) throw new FinanceError('account_currency_mismatch');
  const placed = await db
    .update(clientTransactions)
    .set({ accountId })
    .where(
      and(
        eq(clientTransactions.id, id),
        isNull(clientTransactions.accountId),
        isNull(clientTransactions.partnerId),
        isNull(clientTransactions.voidedAt),
      ),
    )
    .returning({ id: clientTransactions.id });
  if (placed.length === 0) throw new FinanceError('already_placed');
  await writeAudit(db, ctx, {
    entityType: 'client_transaction',
    entityId: id,
    action: 'update',
    before: { accountId: null },
    after: { accountId },
  });
}

/**
 * The client-ledger rows a person who may NOT move a till may still void —
 * `mayVoidLedgerRow` (finance/void-rule.ts) written as the void's WHERE: a
 * price, a settlement half (routed through a firm, no till of ours), and
 * their OWN payment while nobody has placed it into a kassa. An allow-list,
 * so a kind a later round adds is the kassa holders' until decided.
 */
export function nonHolderVoidableSql(actorId: string): SQL {
  return sql`(${clientTransactions.type} = 'charge'
    OR (${clientTransactions.type} = 'payment' AND ${clientTransactions.partnerId} IS NOT NULL)
    OR (${clientTransactions.type} = 'payment' AND ${clientTransactions.accountId} IS NULL
        AND ${clientTransactions.createdBy} = ${actorId}::uuid))`;
}

export async function voidTransaction(
  id: string,
  reason: string,
  ctx: AuditContext,
  /**
   * May this person move a kassa (`mayPickTill` — finance.expenses)? REQUIRED,
   * never optional: an optional door fails open (U33). Voiding a REFUND puts
   * the money back into the drawer on paper — the till reads more cash than
   * it holds and the client's ledger forgets the money was handed back — so
   * it asks the grant that created it (#1014), the pair #1018 closed for a
   * kassa-paid cost. Judged by the ROW's type, never the form's.
   */
  door: { mayMoveTill: boolean },
) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  const actorId = ctx.actorId;
  const row = await db.query.clientTransactions.findFirst({
    where: eq(clientTransactions.id, id),
  });
  if (!row) throw new FinanceError('not_found');
  if (row.voidedAt) throw new FinanceError('already_voided');
  // A kurs farqi row is the system's (Q14) or the accountant's own close
  // (Q24 b, its own undo door): it changes only when its cycle changes.
  if (row.type === 'fx_diff') throw new FinanceError('fx_system_row');
  if (row.type === 'refund' && !door.mayMoveTill) throw new FinanceError('forbidden');
  // A three-cornered settlement is ONE agreement with two halves (#415), and
  // `voidPartnerTx` has always taken the client half with it. This is the
  // mirror, which was missing: voiding the client half alone left our debt to
  // the firm forgiven with nothing standing behind it, and only that partner's
  // ledger — read row by row — could ever show it. Matched on the FK that
  // DEFINES the pair, not on the client row's own partner_id, because only
  // `recordSettlement` ever sets `client_tx_id`.
  //
  // The client row's UPDATE is a CLAIM (Q19 review, money finding 2): it
  // re-judges the row as it stands at the write. A non-holder may void only
  // what `nonHolderVoidableSql` lists — the same list `mayVoidLedgerRow`
  // draws the ✖ from — and «Kassaga joylash» can place an unplaced payment
  // between the read above and this write: under READ COMMITTED the UPDATE
  // waits for that transaction and re-evaluates the WHERE on the placed row,
  // so the claim finds nothing. `voided_at IS NULL` closes a double void,
  // which used to rewrite the first one's reason.
  //
  // The firm on the other half, read before the transaction so the money
  // locks are taken first and in order (clients before partners, 0103).
  const halves = await db
    .select({ partnerId: partnerTransactions.partnerId })
    .from(partnerTransactions)
    .where(and(eq(partnerTransactions.clientTxId, id), isNull(partnerTransactions.voidedAt)));
  const partnerIds = halves.map((half) => half.partnerId);
  await db.transaction(async (tx) => {
    await lockOwnersTx(tx, { clientIds: [row.clientId], partnerIds });
    const claimed = await tx
      .update(clientTransactions)
      .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: reason })
      .where(
        and(
          eq(clientTransactions.id, id),
          isNull(clientTransactions.voidedAt),
          door.mayMoveTill ? undefined : nonHolderVoidableSql(actorId),
        ),
      )
      .returning({ id: clientTransactions.id });
    if (claimed.length === 0) {
      // Re-read on the transaction's own connection (#714), to say why.
      const [now] = await tx
        .select({ voidedAt: clientTransactions.voidedAt })
        .from(clientTransactions)
        .where(eq(clientTransactions.id, id));
      throw new FinanceError(!now ? 'not_found' : now.voidedAt ? 'already_voided' : 'forbidden');
    }
    const paired = await tx
      .update(partnerTransactions)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
      .where(
        and(eq(partnerTransactions.clientTxId, id), isNull(partnerTransactions.voidedAt)),
      )
      .returning({ id: partnerTransactions.id, partnerId: partnerTransactions.partnerId });
    // A void can reopen a closed currency (the payment that zeroed it) — its
    // kurs farqi goes with it, in the same commit (Q14).
    await reconcileFxResidueTx(
      tx,
      { clientIds: [row.clientId], partnerIds: [...partnerIds, ...paired.map((half) => half.partnerId)] },
      ctx,
    );
    await writeAudit(tx, ctx, {
      entityType: 'client_transaction',
      entityId: id,
      action: 'void',
      after: { reason, partnerTxIds: paired.map((p) => p.id) },
    });
    for (const half of paired) {
      await writeAudit(tx, ctx, {
        entityType: 'partner_transaction',
        entityId: half.id,
        action: 'void',
        after: { reason, from: 'client_transaction', clientTxId: id },
      });
    }
  });
}

/** USD balance of one client: Σ charges − Σ payments (active rows only). */
/**
 * Live ledger rows dated after today — typed before `future_date` existed.
 * The balance screens count them and the ageing report (as of today) does
 * not, so the report says how many there are instead of silently differing.
 *
 * «Today» is Tashkent's and bound from here, NOT the database's
 * `CURRENT_DATE`: the server runs in UTC, so from midnight to 05:00 in the
 * office the report's own default `asOf` (Tashkent) and this count (UTC)
 * would be a day apart and a row dated today called «future» by the very
 * page that ages it (R5).
 */
export async function futureDatedEntries(
  today: string = tashkentDay(),
): Promise<{ count: number; usd: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      usd: sql<string>`coalesce(sum(${signedUsdSql()}), 0)`,
    })
    .from(clientTransactions)
    .where(and(isNull(clientTransactions.voidedAt), sql`${clientTransactions.txDate} > ${today}::date`));
  return { count: Number(row?.count ?? 0), usd: Math.round(Number(row?.usd ?? 0) * 100) / 100 };
}

export async function clientBalanceUsd(clientId: string): Promise<number> {
  const [row] = await db
    .select({
      balance: sql<string>`coalesce(sum(${signedUsdSql()}), 0)`,
    })
    .from(clientTransactions)
    .where(and(eq(clientTransactions.clientId, clientId), isNull(clientTransactions.voidedAt)));
  return Math.round(Number(row?.balance ?? 0) * 100) / 100;
}

/**
 * The part of a client's balance that has been deliberately put off.
 *
 * "I'll pay when it is all here" is a decision with an owner and an end
 * (docs/DEALS.md answer 4), and it is worth nothing unless the handover gate
 * honours it — otherwise the warehouse still refuses the cargo, the operator
 * still presses the override, and the reason goes back to being a Telegram
 * message nobody can find later.
 *
 * Only movements ON a deferred deal count, so an old unrelated debt keeps
 * blocking exactly as it should: the deferral was granted for one job, not for
 * the client. A charge posted from batch pricing carries a deal only when the
 * client's cargo on that truck is one deal's and nothing else (R3a) — then it
 * IS that job's price and the deferral covers it; otherwise it carries none.
 *
 * What is deferred is what is still OWED on that job — charges MINUS payments
 * against it. Summing the charges alone was a hole in the direction that
 * costs money: a client who deferred a $1000 job and then PAID it kept the
 * full $1000 deferred, and the gate subtracts this from the balance, so an
 * unrelated $500 that really was outstanding came out negative and the
 * warehouse handed over the cargo — no override pressed, nothing in the audit
 * trail saying anybody decided to.
 *
 * Clamped at zero PER DEAL, not over the sum: overpaying one job by $200 must
 * not hand out $200 of forgiveness on another.
 */
/**
 * What counts as a LIVE deferral, in one place.
 *
 * Written once because two things ask it now — the handover gate through
 * `deferredBalanceUsd`, and the upsale payout, which by law 4 must not be
 * stricter than the gate that already released the cargo. A deferral whose
 * date has passed is no longer a deferral and the hourly sweep may not have
 * run yet, so neither caller may honour it in the meantime (#251).
 *
 * «Today» is Tashkent's, bound from JS — the same day `activeDeferrals` and
 * `resolveExpiredDeferrals` compare against (R5). The three move together: a
 * deferral read as live here and as expired there would open the handover
 * gate on one screen and name the debtor on the next.
 */
export function liveDeferralWhere(today: string = tashkentDay()) {
  return and(
    sql`${deals.deferredAt} IS NOT NULL`,
    isNull(deals.deferralEndedAt),
    sql`(${deals.deferUntilAllArrived} OR ${deals.deferUntilDate} >= ${today}::date)`,
  );
}

/**
 * A row inside a CLOSED currency cycle owes nothing on any job (0103, money-1):
 * once a currency is back at zero natively, its kurs farqi row closes the
 * dollars — and a deferral that still counted the job's own rows of that
 * cycle would hold their residue a second time, so the gate computed a
 * NEGATIVE blocking debt and handed the cargo over with nothing owed on
 * record (#251's hole again). The walk is the one SQL home (`fxWalkSql`); a
 * USD row is in no cycle and counts as before, and the filter can only LOWER
 * a deferral, never widen the gate. Raw and unaliased so `signedUsdSql()`
 * and `liveDeferralWhere()` render against their own tables.
 */
function deferredPerDealSql(clientIds: string[]): SQL {
  return sql`
    WITH w AS (${fxWalkSql('client', ownersSql('client', clientIds), null)})
    SELECT client_transactions.client_id, client_transactions.deal_id,
           greatest(coalesce(sum(${signedUsdSql()}), 0), 0) AS owed
      FROM client_transactions JOIN deals ON deals.id = client_transactions.deal_id
     WHERE client_transactions.client_id IN (${sql.join(
       clientIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND client_transactions.voided_at IS NULL
       AND ${liveDeferralWhere()}
       AND NOT EXISTS (SELECT 1 FROM w WHERE w.id = client_transactions.id AND w.pos <= w.last_zero_pos)
     GROUP BY client_transactions.client_id, client_transactions.deal_id`;
}

export async function deferredBalanceUsd(clientId: string): Promise<number> {
  const rows = (await db.execute(deferredPerDealSql([clientId]))) as unknown as { owed: string }[];
  const total = [...rows].reduce((sum, row) => sum + Number(row.owed ?? 0), 0);
  return Math.round(total * 100) / 100;
}

/** Per-client totals for the balances screen — only clients with any activity. */
export async function clientBalances(ownerId?: string) {
  const rows = await db
    .select({
      clientId: clientTransactions.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      chargesUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'charge'), 0)`,
      paymentsUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'payment'), 0)`,
      refundsUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'refund'), 0)`,
      // The kurs farqi rows (0103, Q14), signed: a column of their own so the
      // screen's columns still add up to the balance beside them.
      fxUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'fx_diff'), 0)`,
      lastAt: sql<string>`max(${clientTransactions.createdAt})`,
    })
    .from(clientTransactions)
    .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
    .where(
      and(
        isNull(clientTransactions.voidedAt),
        // A seller reads their own book and nothing else. `undefined` is the
        // only way to ask for everything, so a caller that forgets to decide
        // gets the old behaviour visibly rather than by accident.
        ownerId ? eq(clients.salesManagerId, ownerId) : undefined,
      ),
    )
    .groupBy(clientTransactions.clientId, clients.clientCode, clients.name);
  return rows
    .map((r) => ({
      clientId: r.clientId,
      clientCode: r.clientCode,
      clientName: r.clientName,
      chargesUsd: Math.round(Number(r.chargesUsd) * 100) / 100,
      // NET of what was handed back (R6a), so the screen's two columns still
      // add up to the balance beside them.
      paymentsUsd: Math.round((Number(r.paymentsUsd) - Number(r.refundsUsd)) * 100) / 100,
      refundsUsd: Math.round(Number(r.refundsUsd) * 100) / 100,
      fxUsd: Math.round(Number(r.fxUsd) * 100) / 100,
      balanceUsd:
        Math.round((Number(r.chargesUsd) - Number(r.paymentsUsd) + Number(r.refundsUsd) + Number(r.fxUsd)) * 100) / 100,
      lastAt: r.lastAt,
    }))
    .sort((a, b) => b.balanceUsd - a.balanceUsd);
}

/** Full ledger of one client, newest first (void rows included, struck out in UI). */
export async function clientLedger(clientId: string) {
  return db
    .select({
      tx: clientTransactions,
      createdByName: users.fullName,
      batchCode: batches.code,
      /**
       * WHICH JOB this money answers. `deal_id` has been written by the
       * payment form since #531 and read by nobody but the deferral netting —
       * so the owner would pick a deal, save, and watch it become invisible
       * («bitim belgilanadgan joyda birga berish kerak», 2026-09-14). A LEFT
       * join: most money names no job, and that is not a defect.
       */
      dealCode: deals.code,
    })
    .from(clientTransactions)
    .innerJoin(users, eq(clientTransactions.createdBy, users.id))
    .leftJoin(batches, eq(clientTransactions.batchId, batches.id))
    .leftJoin(deals, eq(clientTransactions.dealId, deals.id))
    .where(eq(clientTransactions.clientId, clientId))
    .orderBy(desc(clientTransactions.createdAt))
    .limit(500);
}

/** Active charges already entered against one batch (pricing screen). */
export async function batchCharges(batchId: string) {
  return db
    .select({
      tx: clientTransactions,
      clientCode: clients.clientCode,
      clientName: clients.name,
    })
    .from(clientTransactions)
    .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
    .where(and(eq(clientTransactions.batchId, batchId), isNull(clientTransactions.voidedAt)))
    .orderBy(desc(clientTransactions.createdAt));
}

// ---------------------------------------------------------------------------
// The payments register (round 29) — «kimdan qancha pul olganimni qanday
// yozaman?» answered as a screen: every incoming payment in a period, with
// the client, the cash box it landed in and who recorded it. Writing stays
// where it always was (the client's ledger form); this is the READ the
// accountant was keeping in a notebook.
// ---------------------------------------------------------------------------

export interface PaymentRegisterRow {
  id: string;
  txDate: string;
  clientId: string;
  clientCode: string;
  clientName: string;
  amount: string;
  currency: string;
  amountUsd: string;
  method: string | null;
  accountName: string | null;
  /**
   * Named when the money went into a counterparty's account instead of a till
   * of ours (a three-cornered settlement). The row belongs in the register —
   * the client really did pay — but a blank cash box on it is not the same
   * fact as an unplaced payment, and the screen was printing both in red.
   */
  partnerName: string | null;
  note: string | null;
  enteredBy: string | null;
}

/**
 * «Payments with no till», whenever they were made (audit A2): the accountant's
 * home counter, the Balans line and the register's unplaced view read this one
 * predicate. Since cash boxes exist only — a payment older than the first box
 * is inside some box's counted opening balance and has nowhere to be placed.
 *
 * And not when it is CERTAINLY inside a count (audit U09): R4 (#1012) keeps a
 * row dated before a till's opening date out of that till, because the count
 * already holds it — so a payment dated before EVERY count of its currency is
 * money the drawers already show, and listing it as well put it on the Balans
 * twice until somebody «placed» it and the net fell by the whole amount. Only
 * tills of the payment's own currency can take it (`placePayment` refuses the
 * rest), so only they are asked; a till with no opening date counts every row
 * placed into it, so while one exists the payment stays on the line — and so
 * does a payment in a currency with no active till at all, or it would drop
 * out of the net silently. `${clientTransactions}.col`, the table, never the
 * column: inside the subquery a bare column would bind to money_accounts (#128).
 */
export function unplacedPaymentSql() {
  return and(
    isNull(clientTransactions.accountId),
    isNull(clientTransactions.partnerId),
    sql`${clientTransactions.txDate} >= (SELECT min(created_at)::date FROM money_accounts)`,
    sql`(NOT EXISTS (SELECT 1 FROM money_accounts ma
                      WHERE ma.active AND ma.currency = ${clientTransactions}.currency)
         OR EXISTS (SELECT 1 FROM money_accounts ma
                     WHERE ma.active AND ma.currency = ${clientTransactions}.currency
                       AND coalesce(ma.opening_date, '-infinity'::date) <= ${clientTransactions}.tx_date))`,
  );
}

/**
 * Client money over a period, said ONCE (audit U26, #513). Three screens
 * printed «this month's payments» three ways — the homes net of refunds and
 * with settlements, the cash flow only what reached a kassa, the register
 * every payment and no refund — and each disagreed with the one it links to.
 * One grouped query, split into the parts each of those screens prints, so
 * every figure on a home can be found again where it leads:
 *
 * - `toTill` — payments into a kassa of ours: the cash flow's «Mijoz to'lovlari»
 * - `viaPartner` — the client half of a three-cornered settlement: money that
 *   closed the client's debt in a firm's account, never a till (round 39)
 * - `refunded` — money handed back out of a kassa (R6a): the cash flow's own row
 * - `netCollected` — what the clients closed, net: toTill + viaPartner −
 *   refunded, i.e. `netPaidUsdSql`'s sum (the owner's answer A, 2026-09-25)
 *
 * The register's total is toTill + viaPartner (every payment, no refund).
 */
export async function clientMoneyInPeriod(from: string, to: string) {
  const [row] = await db
    .select({
      charged: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'charge'), 0)`,
      toTill: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'payment' AND ${clientTransactions.partnerId} IS NULL), 0)`,
      viaPartner: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'payment' AND ${clientTransactions.partnerId} IS NOT NULL), 0)`,
      refunded: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'refund'), 0)`,
    })
    .from(clientTransactions)
    .where(
      and(
        isNull(clientTransactions.voidedAt),
        gte(clientTransactions.txDate, from),
        lte(clientTransactions.txDate, to),
      ),
    );
  const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;
  const toTill = cents(row?.toTill);
  const viaPartner = cents(row?.viaPartner);
  const refunded = cents(row?.refunded);
  return {
    charged: cents(row?.charged),
    toTill,
    viaPartner,
    refunded,
    netCollected: cents(toTill + viaPartner - refunded),
  };
}

/**
 * The /finance total and the Balans's two client lines, said once (audit U15,
 * the client twin of `partnerTotals`, #996): debtors are the positive
 * balances, advances the negative ones — money we owe back in service. Each
 * row rounded to the cent first, the way both screens print it, so the
 * figure a Balans line links to can be checked there to the cent.
 */
export function clientTotals(rows: { balanceUsd: number }[]): { receivable: number; advances: number } {
  let receivable = 0;
  let advances = 0;
  for (const row of rows) {
    const value = Math.round(row.balanceUsd * 100) / 100;
    if (value > 0) receivable += value;
    else advances += -value;
  }
  return { receivable: Math.round(receivable * 100) / 100, advances: Math.round(advances * 100) / 100 };
}

export async function paymentsRegister(
  from: string,
  to: string,
  ownerId?: string,
  opts: { unplaced?: boolean } = {},
): Promise<{ rows: PaymentRegisterRow[]; totalUsd: number; count: number; truncated: boolean }> {
  // The unplaced view ignores the period: a payment left unplaced in March is
  // still work in September.
  const when = opts.unplaced
    ? unplacedPaymentSql()
    : and(gte(clientTransactions.txDate, from), lte(clientTransactions.txDate, to));
  const rows = await db
    .select({
      id: clientTransactions.id,
      txDate: clientTransactions.txDate,
      clientId: clientTransactions.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      amount: clientTransactions.amount,
      currency: clientTransactions.currency,
      amountUsd: clientTransactions.amountUsd,
      method: clientTransactions.method,
      accountName: moneyAccounts.name,
      partnerName: partners.name,
      note: clientTransactions.note,
      enteredBy: users.fullName,
    })
    .from(clientTransactions)
    .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
    .leftJoin(moneyAccounts, eq(clientTransactions.accountId, moneyAccounts.id))
    .leftJoin(partners, eq(clientTransactions.partnerId, partners.id))
    .leftJoin(users, eq(clientTransactions.createdBy, users.id))
    .where(
      and(
        eq(clientTransactions.type, 'payment'),
        isNull(clientTransactions.voidedAt),
        when,
        ownerId ? eq(clients.salesManagerId, ownerId) : undefined,
      ),
    )
    .orderBy(desc(clientTransactions.txDate), desc(clientTransactions.createdAt))
    .limit(2000);
  // The TOTAL is aggregated over the whole period, never over the fetched
  // slice: the rows are capped for the screen, and a «jami» computed from a
  // silently clipped list would understate the year the moment the register
  // outgrows the cap — while cash-flow, summing the same period uncapped,
  // says otherwise on the next tab. No silent caps: `truncated` tells the
  // screen and the XLSX to say «newest 2000 of N».
  const [agg] = await db
    .select({
      totalUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)`,
      n: sql<number>`count(*)`,
    })
    .from(clientTransactions)
    .where(
      and(
        eq(clientTransactions.type, 'payment'),
        isNull(clientTransactions.voidedAt),
        when,
        // The total has to be scoped with the rows or the screen contradicts
        // itself — «jami» over the company above a list of one seller's
        // payments. A subquery rather than a join, so the unscoped path stays
        // byte-identical to what it has always been.
        ownerId
          ? inArray(
              clientTransactions.clientId,
              db.select({ id: clients.id }).from(clients).where(eq(clients.salesManagerId, ownerId)),
            )
          : undefined,
      ),
    );
  const count = Number(agg?.n ?? rows.length);
  return {
    rows,
    totalUsd: Math.round(Number(agg?.totalUsd ?? 0) * 100) / 100,
    count,
    truncated: rows.length < count,
  };
}

/**
 * Balance and live-deferral totals for MANY clients, in one query each.
 *
 * The per-client pair above is right for a counter where one customer is
 * standing; a payout queue asks about every seller's every job at once, and
 * calling them per row is the shape rounds 45, 68 and 108 each found
 * saturating the one Node process (#432). Same two predicates, one home.
 */
export async function balancesForClients(
  clientIds: string[],
): Promise<Map<string, { balanceUsd: number; deferredUsd: number }>> {
  const out = new Map<string, { balanceUsd: number; deferredUsd: number }>();
  const ids = [...new Set(clientIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const balances = await db
    .select({
      clientId: clientTransactions.clientId,
      balance: sql<string>`coalesce(sum(${signedUsdSql()}), 0)`,
    })
    .from(clientTransactions)
    .where(and(inArray(clientTransactions.clientId, ids), isNull(clientTransactions.voidedAt)))
    .groupBy(clientTransactions.clientId);

  // The deferral's own rule, closed cycles out (`deferredPerDealSql`, 0103).
  const perDeal = (await db.execute(deferredPerDealSql(ids))) as unknown as { client_id: string; owed: string }[];
  const deferralTotals = new Map<string, number>();
  for (const row of perDeal) {
    deferralTotals.set(row.client_id, (deferralTotals.get(row.client_id) ?? 0) + Number(row.owed ?? 0));
  }
  const deferrals = [...deferralTotals.entries()].map(([clientId, total]) => ({ clientId, total }));

  const money = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;
  for (const id of ids) out.set(id, { balanceUsd: 0, deferredUsd: 0 });
  for (const r of balances) {
    const row = out.get(r.clientId);
    if (row) row.balanceUsd = money(r.balance);
  }
  for (const r of deferrals) {
    const row = r.clientId ? out.get(r.clientId) : undefined;
    if (row) row.deferredUsd = money(r.total);
  }
  return out;
}
