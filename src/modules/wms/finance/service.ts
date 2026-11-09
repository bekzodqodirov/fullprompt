import { cache } from 'react';
import { and, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
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
  receipts,
  partnerTransactions,
  partners,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import type { Db, Tx } from '../../platform/db/client';
import { LEDGER_TYPES, isClientPayout } from './ledger-kinds';
import { ledgerAlias, netPaidUsdSql, signedUsdSql } from './ledger-sql';
import { fxWalkSql, lockOwnersTx, nativeSql, ownersSql, reconcileFxResidueTx } from './fx-residue';
import { rateFor } from '../costing/service';
import { batchRoute, isInternalLeg } from '../batches/internal';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { cargoAboard } from '../batches/lots';
import {
  seenOf,
  truckDealDecision,
  truckDealParts,
  type DealCandidates,
  type TruckDealChoice,
  type TruckDealPart,
} from './truck-deal';
import { tripCoverageOn } from './unpriced';
import { chosenNoneSql, dealCardPricedSql, zeroedByCompensationSql } from './standing-price-sql';
import { deferredTotal } from '../debt/rules';

/**
 * Client money ledger (Phase 2.1, owner's rules): there are NO tariffs — the
 * sales manager and the client agree a price per shipment, so the ledger only
 * records agreed charges (set by VED manager/accountant after customs) and
 * incoming payments (cash/card/transfer, any currency). Everything is frozen
 * to USD at entry time; balance = Σ charges − Σ payments.
 */

export class FinanceError extends Error {
  /**
   * `detail` — what the refusal is about, when one press carries several
   * things: the price table's part (a deal id or 'none'), so its row can be
   * marked instead of one sentence for fifteen rows (judge P1-UX-8).
   */
  constructor(
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(code);
  }
}

/**
 * The one sign rule of the client ledger (0101): a charge and a refund RAISE
 * what the client owes us, a payment and a compensation (0105) lower it, a
 * kurs farqi row carries its own sign. Every balance restates this through
 * `signedUsdSql` — `CASE WHEN type = 'charge' … ELSE -…` read a refund as a
 * payment, and `CASE WHEN type = 'payment' THEN -… ELSE …` read a
 * compensation as a charge; `tests/unit/client-ledger-sign.test.ts` keeps
 * both shapes out of `src/`. Every SQL builder below is BUILT from
 * `LEDGER_RULES` (the lists are compile-time constants, never input), so a
 * kind added there needs no second answer here.
 */
export { LEDGER_TYPES, type LedgerType, signedUsd, settlesUsd } from './ledger-kinds';
export {
  creditUsdSql,
  debitUsdSql,
  ledgerAlias,
  netPaidUsdSql,
  revenueUsdSql,
  settlesUsdSql,
  signedUsdSql,
  type LedgerCols,
} from './ledger-sql';

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
           coalesce(sum(${signedUsdSql(ledgerAlias('t'))}), 0) AS usd
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
  // The rate can only have moved money held IN the refund's currency: a
  // dollar advance handed back in so'm converts at today's rate and drifts by
  // nothing, so 2 % of the WHOLE advance let a $10,000 USD advance hand back
  // $10,200 of so'm (review of the lead's fixes after the fx package took the
  // same-currency case). The drift base is the advance in the refund's own
  // money; with none, only the $5 floor.
  const ownAdvanceUsd = Math.max(0, -(balances.find((row) => row.currency === refund.currency)?.usd ?? 0));
  return refundFitsAdvance(refund.amountUsd, -Math.round(usd * 100) / 100, ownAdvanceUsd);
}

/**
 * May a refund of `refundUsd` be handed out of an advance of `advanceUsd`?
 * (U04, the owner's A.) The FX residue it may carry over the advance: the
 * same so'm an advance was paid in, handed back after the rate moved, reads
 * more dollars than it came in as (measured: $300 → $301.88) — the owner's
 * «bir necha dollarlik farq baribir o'tkaziladi». The allowance is the
 * merge's own (2 % or $5, the looser — `fxResidueAllowance`), because a flat
 * $5 refused a 125-million-so'm advance handed back after a 1.2 % move.
 * `refundFits` answers the same-currency case natively first and reaches this
 * only across currencies, where `driftBaseUsd` — the part of the advance held
 * in the refund's own currency — is all the rate can have moved.
 */
export function refundFitsAdvance(refundUsd: number, advanceUsd: number, driftBaseUsd = advanceUsd): boolean {
  return advanceUsd > 0.009 && refundUsd <= advanceUsd + fxResidueAllowance(driftBaseUsd) + 0.004;
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
    /**
     * The job this money is for. On a truck price it is the person's answer
     * to «qaysi bitimga» (his Q8 «c»), checked against the cargo aboard —
     * 'none' is that answer's «bitimsiz», read once at the top of
     * `addTransaction` so it never reaches a uuid column or query.
     */
    dealId: z.string().uuid().optional().or(z.literal('')).or(z.literal('none')),
    /**
     * The question the truck-price form was drawn with (`DealCandidates.key`),
     * echoed back: a prixod re-filed between the drawing and the press makes
     * the door refuse (`deals_changed`) rather than answer for somebody.
     */
    dealsSeen: z.string().max(4000).optional(),
    /**
     * The client's live prices on the truck as the form drew them
     * (`pricesSeenOf`), echoed back: the «Narx» tab's form posts it, so a
     * price written by a second tab or a colleague between the drawing and
     * the press is a refusal (`prices_changed`) and not a second bill nobody
     * was asked about. Absent (the ledger) = not checked.
     */
    pricesSeen: z.string().max(40_000).optional(),
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

/**
 * The client's live prices on a truck, as one comparable string — what the
 * «Narx» tab posts (`pricesSeen`) and what the write body re-reads under its
 * locks. `seenOf`'s one shape (sorted in JS on both sides), which the table's
 * `cardSeen` is built by in the browser too.
 */
export function pricesSeenOf(ids: string[]): string {
  return seenOf(ids);
}

/**
 * The truck a price is written on, locked and judged on the locked row (docs/
 * NARX-VA-RAQAM.md §3.1.2) — ONE helper for every truck-price writer: the
 * price body both doors share, and «🚚 Ko'chirish» per target truck (which
 * took no truck lock at all — the cancel race the price door had closed, judge
 * F6).
 *
 * FOR SHARE of the truck row: `cancelBatch` counts the truck's charges under
 * FOR NO KEY UPDATE, so the two serialise — the price commits first and the
 * cancel refuses, or the cancel commits first and the price is refused here.
 * The foreign key's own KEY SHARE does not wait for NO KEY UPDATE, so without
 * this both used to succeed: a live price on a truck whose cargo had gone back
 * to the shelf (docs/SARFLAR.md §8.5).
 *
 * …and the leg's KIND, judged on the LOCKED row: the pool's `batchRoute` was
 * the only internal-leg check, sound only while a destination could not
 * change before departure. Now it can (§2.4), and on the road a reroute moves
 * it too — so the destination is read off the row this lock holds, and a
 * change to a Chinese warehouse between the pool read and here is refused by
 * `isInternalLeg`'s own rule (judge P1-dest-change-race).
 *
 * The row is locked ALONE and the two countries are read in a second
 * statement. A lock that waits behind a destination writer
 * (`changeDestBeforeDeparture`, `rerouteBatch`) is re-checked under READ
 * COMMITTED against the NEW truck row only: a warehouse joined into the same
 * statement is the OLD destination's row, `d.id = b.dest_warehouse_id` fails,
 * and the truck vanished — `batch_not_found`, a generic «Xatolik» for a legal
 * price, and the wrong word for a change to China (review A3/D1/F2: measured,
 * and `FOR SHARE OF b, o, d` re-uses the old row the same way). The second
 * statement takes a fresh snapshot after the lock, so it reads the countries
 * of the destination the truck has now.
 */
export async function lockTruckForPriceTx(tx: Tx, batchId: string): Promise<void> {
  const rows = (await tx.execute(sql`
    SELECT status, origin_warehouse_id, dest_warehouse_id
      FROM batches
     WHERE id = ${batchId}::uuid
       FOR SHARE`)) as unknown as { status: string; origin_warehouse_id: string; dest_warehouse_id: string }[];
  const truck = [...rows][0];
  if (!truck) throw new FinanceError('batch_not_found');
  if (truck.status === 'cancelled') throw new FinanceError('batch_cancelled');
  const ends = (await tx.execute(sql`
    SELECT id, country FROM warehouses
     WHERE id IN (${truck.origin_warehouse_id}::uuid, ${truck.dest_warehouse_id}::uuid)`)) as unknown as {
    id: string;
    country: string | null;
  }[];
  const countryOf = (id: string) => [...ends].find((row) => row.id === id)?.country ?? null;
  if (isInternalLeg(countryOf(truck.origin_warehouse_id), countryOf(truck.dest_warehouse_id))) {
    throw new FinanceError('internal_batch');
  }
}

/**
 * What a truck price is asked to be: one price with its deal choice (the
 * ledger, the single «Narx» form, a script — `truckDealDecision`), or the
 * table's parts (`truckDealParts`).
 */
type TruckChargeAsk = { kind: 'one'; choice: TruckDealChoice } | { kind: 'parts'; parts: TruckDealPart[] };

/** A truck price, checked on the pool and ready for its transaction. */
export interface TruckChargePlan {
  clientId: string;
  batchId: string;
  currency: string;
  txDate: string;
  rate: number;
  note: string | null;
  accountId: string | null;
  ask: TruckChargeAsk;
  dealsSeen: string | undefined;
  pricesSeen: string | undefined;
  cardSeen: string | undefined;
  parts: { dealId: string | null; via: 'chosen' | 'derived' | 'none'; amount: number; amountUsd: number }[];
}

/** The ask, decided — by whichever rule it came through, refusing in its words. */
function decideTruckAsk(candidates: DealCandidates, plan: Pick<TruckChargePlan, 'ask' | 'dealsSeen'>, amount: number) {
  if (plan.ask.kind === 'one') {
    const decided = truckDealDecision(candidates, plan.ask.choice, plan.dealsSeen);
    if (!decided.ok) throw new FinanceError(decided.code);
    return [{ dealId: decided.dealId, via: decided.via, amount }];
  }
  const decided = truckDealParts(candidates, plan.ask.parts, plan.dealsSeen ?? '');
  if (!decided.ok) throw new FinanceError(decided.code, decided.at);
  return decided.parts;
}

/**
 * The POOL half of every truck price (#714 — before any transaction), shared
 * by `addTransaction`'s truck branch and the price table so the two doors
 * cannot drift (#513): the date, the route (`internal_batch` — the owner's
 * C1a, an internal leg is never billed), the cargo aboard (0104: a price
 * names cargo on the truck, or it is the «yuki ketmagan» price the screens
 * warn about), the deal decision, the rate read ONCE for the press and each
 * part's dollars with their ceiling.
 */
export async function prepareTruckCharges(input: {
  clientId: string;
  batchId: string;
  currency: string;
  txDate: string;
  note: string | null;
  accountId: string | null;
  ask: TruckChargeAsk;
  /** The table's single amount is per part; the one-price ask brings its own. */
  amount: number;
  dealsSeen: string | undefined;
  pricesSeen: string | undefined;
  /**
   * The posted deals that carried a price of their own on their CARD when the
   * table was drawn (sorted ids) — the «bitim kartasida narx bor» the rows
   * asked about, or did not (review A4). Absent = not checked: the ledger and
   * the single form draw no such question.
   */
  cardSeen: string | undefined;
}): Promise<TruckChargePlan> {
  if (input.txDate > latestTxDate()) throw new FinanceError('future_date');
  const route = await batchRoute(input.batchId);
  if (!route) throw new FinanceError('batch_not_found');
  if (route.internal) throw new FinanceError('internal_batch');
  // Asked AFTER the internal check, so an internal truck still says why it is
  // refused.
  const aboard = await cargoAboard(input.batchId, input.clientId);
  if (!aboard.aboard) throw new FinanceError('client_not_aboard');
  // A price set on the truck is also the JOB's money (owner's R3a,
  // 2026-09-24): derived from the cargo when its deal is one, and — his Q8
  // «c», 2026-10-27, «logist o'zi tanlaydi» — CHOSEN by the person when two or
  // more of the client's deals ride the truck, one deal per price or one row
  // per deal (2026-11-08, his 1a), refused without a choice at every door. A
  // posted deal is a forged post until the cargo says it rides this truck
  // (#507).
  const decided = decideTruckAsk(aboard.candidates, input, input.amount);
  // The rate is frozen NOW — a later FX edit must not move settled money.
  // ONE read for the press: every part of it is the same moment.
  const rate = await rateFor(input.currency, input.txDate);
  if (rate === null) throw new FinanceError('fx_missing');
  const parts = decided.map((part) => {
    const amountUsd = Math.round(part.amount * rate * 100) / 100;
    if (exceedsRowUsd(amountUsd)) throw new FinanceError('amount_too_large', part.dealId ?? 'none');
    return { ...part, amountUsd };
  });
  return {
    clientId: input.clientId,
    batchId: input.batchId,
    currency: input.currency,
    txDate: input.txDate,
    rate,
    note: input.note,
    accountId: input.accountId,
    ask: input.ask,
    dealsSeen: input.dealsSeen,
    pricesSeen: input.pricesSeen,
    cardSeen: input.cardSeen,
    parts,
  };
}

/**
 * The WRITE half of every truck price — and it owns its transaction (the
 * tx-pool fence, judge F1: a shared `tx` body re-reading the cargo would make
 * both callers' transactions reach a pooled function by name). In order:
 * the client's money lock (0103) → the truck, locked and judged
 * (`lockTruckForPriceTx`) → the cargo and the decision AGAIN on this
 * transaction's own reads, after the locks, by the same statement and the
 * same rule: a prixod re-filed onto another deal (or a carton unloaded)
 * between the pool read and here would land a price on a deal its cargo has
 * left, so any part's deal differing is `deals_changed`. Not a closed window
 * — `linkReceipt` shares no lock with this — but the answer written is the
 * one the cargo gives at the write. → the prices the page was drawn with,
 * under the client lock that serialises two presses (`prices_changed`: a
 * second tab, or the accountant and the admin at once, would otherwise each
 * write the same parts with nothing asked — judge P1-stale-prices) → the
 * posted deals' CARD prices as drawn (`cardSeen`, review A4) → the
 * inserts, all-or-nothing → ONE kurs farqi reconcile over them → an audit row
 * per charge, saying how its deal got there and, for the table, that it was
 * one press of N.
 */
export async function writeTruckCharges(plan: TruckChargePlan, ctx: AuditContext) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  const createdBy = ctx.actorId;
  return db.transaction(async (tx) => {
    await lockOwnersTx(tx, { clientIds: [plan.clientId] });
    await lockTruckForPriceTx(tx, plan.batchId);
    const now = await cargoAboard(plan.batchId, plan.clientId, tx);
    if (!now.aboard) throw new FinanceError('client_not_aboard');
    const again = decideTruckAsk(now.candidates, plan, plan.parts[0]?.amount ?? 0);
    if (again.length !== plan.parts.length || again.some((part, i) => part.dealId !== plan.parts[i]!.dealId)) {
      throw new FinanceError('deals_changed');
    }
    if (plan.pricesSeen !== undefined) {
      const live = (await tx.execute(sql`
        SELECT id FROM client_transactions
         WHERE batch_id = ${plan.batchId}::uuid AND client_id = ${plan.clientId}::uuid
           AND type = 'charge' AND voided_at IS NULL`)) as unknown as { id: string }[];
      if (pricesSeenOf([...live].map((row) => row.id)) !== plan.pricesSeen) throw new FinanceError('prices_changed');
    }
    // …and the deal prices OFF this truck the rows were drawn with. A row's
    // «bitim kartasida narx bor» and its pre-fill's `pricedCard` are facts
    // about the deal's card, which `pricesSeen` (this truck's charges) never
    // sees: a colleague writing the deal's price on the client ledger between
    // the drawing and the press would otherwise meet a stale pre-filled row
    // here and the job be billed twice, nothing asked (review A4). The card
    // price takes the same client lock, so the two serialise. Only the POSTED
    // deals: a blank row bills nothing whatever its card says.
    if (plan.cardSeen !== undefined) {
      const posted = [...new Set(plan.parts.map((part) => part.dealId).filter((id): id is string => id !== null))];
      const card =
        posted.length === 0
          ? []
          : ((await tx.execute(sql`
              SELECT d.id FROM deals d
               WHERE d.id IN (${sql.join(
                 posted.map((id) => sql`${id}::uuid`),
                 sql`, `,
               )})
                 AND ${dealCardPricedSql(sql`d.id`)}`)) as unknown as { id: string }[]);
      if (seenOf([...card].map((row) => row.id)) !== plan.cardSeen) throw new FinanceError('prices_changed');
    }
    const inserted = await tx
      .insert(clientTransactions)
      .values(
        plan.parts.map((part) => ({
          clientId: plan.clientId,
          type: 'charge',
          amount: String(part.amount),
          currency: plan.currency,
          rateToUsd: String(plan.rate),
          amountUsd: String(part.amountUsd),
          method: null,
          txDate: plan.txDate,
          batchId: plan.batchId,
          dealId: part.dealId,
          accountId: plan.accountId,
          note: plan.note,
          createdBy,
        })),
      )
      .returning();
    await reconcileFxResidueTx(tx, { clientIds: [plan.clientId] }, ctx);
    for (const [index, row] of inserted.entries()) {
      const part = plan.parts[index]!;
      await writeAudit(tx, ctx, {
        entityType: 'client_transaction',
        entityId: row.id,
        action: 'create',
        after: {
          clientId: plan.clientId,
          type: 'charge',
          amount: part.amount,
          currency: plan.currency,
          amountUsd: part.amountUsd,
          // Named when set: a truck price can land on a deal nobody typed
          // (R3a), and the history is where somebody will ask why — and since
          // Q8 «c» it also says whether the person CHOSE it, or chose
          // «bitimsiz» (the «already priced here» reading tells a chosen
          // part from a whole-cargo price by this word).
          ...(part.dealId ? { dealId: part.dealId } : {}),
          dealVia: part.via,
          ...(plan.ask.kind === 'parts' ? { parts: plan.parts.length } : {}),
        },
      });
    }
    return inserted;
  });
}

/**
 * The «Narx» tab's price table (docs/NARX-VA-RAQAM.md, his 1a-3a): one row per
 * deal of the client's on the truck (and «bitimsiz»), one «Saqlash». Blank
 * rows are dropped by the action before this; at least one part, at most 40.
 */
export const truckPricesSchema = z.object({
  clientId: z.string().uuid(),
  batchId: z.string().uuid(),
  currency: z.string().length(3).toUpperCase(),
  txDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dealsSeen: z.string().max(4000),
  pricesSeen: z.string().max(40_000),
  /** The posted deals card-priced when drawn (review A4); absent = not checked. */
  cardSeen: z.string().max(40_000).optional(),
  parts: z
    .array(z.object({ dealId: z.string().uuid().or(z.literal('none')), amount: nativeAmount() }))
    .min(1)
    .max(40),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});
export type TruckPricesInput = z.infer<typeof truckPricesSchema>;

export async function addTruckPrices(input: TruckPricesInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  // «bitimsiz» read ONCE, here, so 'none' never reaches a uuid column or query.
  const parts: TruckDealPart[] = input.parts.map((part) => ({
    choice: part.dealId === 'none' ? { kind: 'none' } : { kind: 'deal', dealId: part.dealId },
    amount: part.amount,
  }));
  const plan = await prepareTruckCharges({
    clientId: input.clientId,
    batchId: input.batchId,
    currency: input.currency,
    txDate: input.txDate,
    note: input.note || null,
    accountId: null,
    ask: { kind: 'parts', parts },
    amount: 0,
    dealsSeen: input.dealsSeen,
    pricesSeen: input.pricesSeen,
    cardSeen: input.cardSeen,
  });
  return writeTruckCharges(plan, ctx);
}

export async function addTransaction(input: TransactionInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new FinanceError('unauthenticated');
  if (input.txDate > latestTxDate()) throw new FinanceError('future_date');
  // The deal the form asked for, read ONCE (Q8 «c»): «bitimsiz» is the
  // person's answer that a truck price names no job, and as a string it must
  // never reach the uuid lookup below or the column — postgres refuses
  // 'none'::uuid with an error page, not a sentence (review). It means
  // something on a truck price only.
  const choice: TruckDealChoice =
    input.dealId === 'none'
      ? { kind: 'none' }
      : input.dealId
        ? { kind: 'deal', dealId: input.dealId }
        : { kind: 'derive' };
  if (choice.kind === 'none' && !(input.type === 'charge' && input.batchId)) {
    throw new FinanceError('deal_choice_invalid');
  }
  const postedDeal = choice.kind === 'deal' ? choice.dealId : null;
  // A named deal must be THIS client's. The deal id steers the deferral
  // netting (#251) — a payment parked on another client's deal would quietly
  // re-open their handover gate — and a select's value is a forged post until
  // the server has checked it (the inline-picker rule, #507).
  if (postedDeal) {
    const deal = await db.query.deals.findFirst({ where: eq(deals.id, postedDeal) });
    if (!deal || deal.clientId !== input.clientId) throw new FinanceError('deal_mismatch');
  }
  // How the deal got onto the row, for the history: typed by the person, or
  // (a truck price, below) implied by the cargo or the person's «bitimsiz».
  const dealVia: 'chosen' | null = postedDeal ? 'chosen' : null;
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
  // A PRICE ON A TRUCK is written by the one body both truck doors share —
  // this ledger/«Narx» door and the price table (#513, docs/NARX-VA-RAQAM.md
  // §3.1.3): the internal-leg refusal (C1a — refused here, not merely left
  // off the screen, #531: a hand-built post would bill a leg the owner never
  // bills), the cargo aboard, the deal decision, the rate, and a transaction
  // that locks the truck and decides again. A payment may still name any
  // truck — money received is not a price — and keeps the body below.
  if (input.type === 'charge' && input.batchId) {
    const plan = await prepareTruckCharges({
      clientId: input.clientId,
      batchId: input.batchId,
      currency: input.currency,
      txDate: input.txDate,
      note: input.note || null,
      accountId: input.accountId || null,
      ask: { kind: 'one', choice },
      amount: input.amount,
      dealsSeen: input.dealsSeen,
      pricesSeen: input.pricesSeen,
      // Neither the ledger nor the single «Narx» form draws a card question.
      cardSeen: undefined,
    });
    const [written] = await writeTruckCharges(plan, ctx);
    return written!;
  }
  const dealId = postedDeal;
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
        // Named when set — the same keys the truck body writes, so one
        // history reads either door.
        ...(dealId ? { dealId } : {}),
        ...(dealVia ? { dealVia } : {}),
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
 * The client's money lock goes before the claim and the kurs farqi reconciler
 * after the parts (0103, fence F2). The totals do not move, but the CYCLES can:
 * a split puts a new running sum between its parts, and an advance of exactly
 * one part's size closes natively there — a residue nobody typed, which must
 * be closed in this commit like every other writer's.
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
    // The price's own job wins, the truck's derived one only fills a blank —
    // addTransaction's order (R3a), which this door says it passes (review:
    // the derived deal used to win and re-filed a priced job onto another).
    deals.set(part.batchId, row.dealId ?? aboard.dealId ?? null);
  }
  // A chosen «bitimsiz» part (Q8 «c») stays one where it stays: the part kept
  // on the SAME truck with no deal is still the person's «bitimsiz», and its
  // copy says so (`dealVia: 'none'`) — without the word the «already priced
  // here» reading takes it for a whole-cargo price and every blank deal on
  // the truck goes quiet (review A2). A part landing on ANOTHER truck carries
  // no word: it may take that truck's derived deal, and deal-less there it
  // reads as the whole cargo's — the side that asks. The create audit is
  // written once, so reading it on the pool is reading it at the write.
  const [chosen] = (await db.execute(sql`
    SELECT ${chosenNoneSql(sql`${row.id}::uuid`)} AS chosen_none`)) as unknown as { chosen_none: boolean }[];
  const keepsNone = (batchId: string) =>
    Boolean(chosen?.chosen_none) && row.dealId === null && batchId === row.batchId && deals.get(batchId) === null;
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
    await lockOwnersTx(tx, { clientIds: [row.clientId] });
    // Every target truck locked and judged like any truck price
    // (`lockTruckForPriceTx`): this door took no truck lock at all, so a
    // cancel between its pool checks and here left a live moved price on a
    // truck whose cargo had gone back to the shelf (judge F6) — and a
    // destination changed to China in that window put one on an internal
    // leg. In id order, so two movers never lock the same trucks crosswise.
    // The cargo is asked again on this transaction too, as the price door
    // asks it; the part keeps its own deal (#1515).
    for (const batchId of [...new Set(input.parts.map((part) => part.batchId))].sort()) {
      await lockTruckForPriceTx(tx, batchId);
      if (!(await cargoAboard(batchId, row.clientId, tx)).aboard) throw new FinanceError('client_not_aboard');
    }
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
          // …and the money the parts were computed from is still the row's:
          // a /admin/fx save re-prices a charge IN PLACE (Q18), and a move
          // racing it would have copied the old rate and dollars into the
          // parts for ever (review). Stale → refused, pressed again.
          eq(clientTransactions.amount, row.amount),
          eq(clientTransactions.rateToUsd, row.rateToUsd),
          sql`${clientTransactions.amountUsd} IS NOT DISTINCT FROM ${row.amountUsd}::numeric`,
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
    await reconcileFxResidueTx(tx, { clientIds: [row.clientId] }, ctx);
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
          ...(keepsNone(input.parts[index]!.batchId) ? { dealVia: 'none' } : {}),
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
/**
 * Is the ledger row's counterparty somebody's staff account — the rule of
 * `staffPartnerSql` (partners/staff.ts: a login link OR the seeded 'staff'
 * type), asked of `${clientTransactions}` (#128). Shared by the void claim and
 * the ledger read that draws the ✖, so the two cannot disagree (#513).
 */
export function partnerIsStaffSql(): SQL {
  return sql`EXISTS (SELECT 1 FROM partners sp JOIN partner_types spt ON spt.id = sp.type_id
                      WHERE sp.id = ${clientTransactions}.partner_id
                        AND (sp.user_id IS NOT NULL OR spt.code = 'staff'))`;
}

export function nonHolderVoidableSql(actorId: string): SQL {
  return sql`(${clientTransactions.type} = 'charge'
    OR (${clientTransactions.type} = 'payment' AND ${clientTransactions.partnerId} IS NOT NULL
        AND NOT ${partnerIsStaffSql()})
    OR (${clientTransactions.type} = 'payment' AND ${clientTransactions.accountId} IS NULL
        AND ${clientTransactions.partnerId} IS NULL
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
   * kassa-paid cost. Judged by the ROW's type, never the form's. A
   * COMPENSATION (0105) is the other half of that one decision — money given
   * to the client, written by the kassa holders — and is voided by them too.
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
  if (isClientPayout(row.type) && !door.mayMoveTill) throw new FinanceError('forbidden');
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
    // Voiding a COMPENSATION must not turn cash we already handed the client
    // into a debt (owner's Q15 (1)): under the client's money lock — the
    // refund cap's own — the refunds since compensations began must stay
    // covered by what remains. Refused in words, with the three honest paths.
    if (row.type === 'compensation') {
      const { compensationCoverTx, compensationVoidFits } = await import('./compensation');
      if (!compensationVoidFits(await compensationCoverTx(tx, row.clientId, row.id))) {
        throw new FinanceError('compensation_paid_out');
      }
    }
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
 * the client. A charge posted from batch pricing carries a deal when the
 * client's cargo on that truck is one deal's and nothing else (R3a), or when
 * the person setting a two-deal truck's price chose it (Q8 «c») — then it IS
 * that job's price and the deferral covers it AT THE COUNTER, whatever cargo
 * the price was for (the select says so); otherwise it carries none. What it
 * never does is make another deal's cartons PAID: `paidCargo` lets a deferral
 * settle its own deal's cartons only.
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
 * `deferredBalanceUsd`, and the paid-cargo walk (finance/paid-cartons.ts, the
 * KPI and the upsale), through `deferredPerDealSql`: there a deferral
 * settles its own deal's prices. A deferral whose
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
 * What the truck-price question says about each deal it offers (Q8 «c») —
 * one read for the «Narx» tab and the client ledger, no money in it, so both
 * sights may see it:
 *
 * - `deferred` — a live «muddat», by the counter gate's own predicate
 *   (`liveDeferralWhere`), never `listDeals`' «deferred and not ended» (a
 *   passed date deferral still reads lit there). A price written to such a
 *   deal is excused at the handover for as long as the deferral lives,
 *   whatever cargo the price was for — the option says so.
 * - `cardPriced` — the deal carries a live price of its own with NO truck (a
 *   deal price from the ledger). The unpriced rule's deal clause already
 *   covers its cartons on this truck, so «narx yo'q» there would invite a
 *   second bill for the same job.
 * - `pricedTrucks` — the trucks the deal already has a price on, live or
 *   lowered to zero by the lost-cargo door (codes by id): the price table
 *   pre-fills a deal priced nowhere yet, so a deal
 *   whose cargo rides two trucks is pre-filled on the first only, and a row
 *   typed on the second asks «YW-009 da ham narx bor» (judge F5).
 */
export interface TruckDealHead {
  code: string;
  title: string | null;
  deferred: boolean;
  cardPriced: boolean;
  pricedTrucks: { batchId: string; code: string }[];
}

export async function truckDealHeads(dealIds: string[]): Promise<Map<string, TruckDealHead>> {
  if (dealIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: deals.id,
      code: deals.code,
      title: deals.title,
      deferred: sql<boolean>`coalesce((${liveDeferralWhere()}), false)`,
      // `${deals}.id`, not `${deals.id}`: a single-table select renders its
      // columns unqualified, which inside this subquery would bind to the
      // ledger row's own id (#128).
      // A price the lost-cargo door lowered to zero still covers its cartons
      // in the unpriced rule (`u_charge`, the same clause) — so it is still
      // the deal's own price here (review).
      cardPriced: sql<boolean>`${dealCardPricedSql(sql`${deals}.id`)}`,
      // The trucks the deal has a price on, by truck code — one line per
      // truck, oldest code first: live, or lowered to zero by the lost-cargo
      // door (it covers like the price it was, review A1 — so a second truck
      // of the deal is not pre-filled over a part the compensation gave
      // back). From the deal's own prices (the deal_id index, 0045), never a
      // walk over every truck.
      pricedTrucks: sql<{ batchId: string; code: string }[] | string | null>`(
        SELECT json_agg(json_build_object('batchId', x.id, 'code', x.code) ORDER BY x.code)
          FROM (SELECT DISTINCT pb.id, pb.code
                  FROM client_transactions pt
                  JOIN batches pb ON pb.id = pt.batch_id
                 WHERE pt.deal_id = ${deals}.id AND pt.type = 'charge'
                   AND (pt.voided_at IS NULL OR ${zeroedByCompensationSql(sql`pt.id`)})) x
      )`,
    })
    .from(deals)
    .where(inArray(deals.id, dealIds));
  return new Map(
    rows.map((row) => [
      row.id,
      {
        code: row.code,
        title: row.title,
        deferred: Boolean(row.deferred),
        cardPriced: Boolean(row.cardPriced),
        pricedTrucks: (typeof row.pricedTrucks === 'string' ? JSON.parse(row.pricedTrucks) : (row.pricedTrucks ?? [])) as {
          batchId: string;
          code: string;
        }[],
      },
    ]),
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
 *
 * Exported for the paid-cargo walk (0117, finance/paid-cartons.ts — the KPI
 * and, since his 3a, the upsale): there a
 * deferral settles ITS OWN deal's charges, and this is the one home of what
 * a live deferral is worth. A SQL builder, run on whichever executor the
 * caller holds (#714).
 */
export function deferredPerDealSql(clientIds: string[]): SQL {
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

/**
 * The client's deferred total — the per-job figures below summed by the one
 * `deferredTotal`, which the counter's gate (`issueBoxes`) also calls on the
 * same list, so the screen, the approval's snapshot and the gate cannot drift
 * apart by a rounding (#513).
 */
export async function deferredBalanceUsd(clientId: string): Promise<number> {
  return deferredTotal(await deferredDealsUsd(clientId));
}

/**
 * The same deferral, per JOB and with who granted it (0114, qarz nazorati) —
 * what the handover stores so the register can name the person whose
 * «muddat» let the cargo go. The one per-deal rule (`deferredPerDealSql`)
 * with the deal's own columns beside it, never a second reading of it;
 * `deferredTotal` of this list IS `deferredBalanceUsd`.
 */
export async function deferredDealsUsd(
  clientId: string,
): Promise<{ dealId: string; code: string; by: string | null; owedUsd: number }[]> {
  const rows = (await db.execute(sql`
    SELECT per.deal_id, per.owed, d.code, d.deferred_by
      FROM (${deferredPerDealSql([clientId])}) per
      JOIN deals d ON d.id = per.deal_id
     ORDER BY d.deferred_at, d.code`)) as unknown as {
    deal_id: string;
    owed: string;
    code: string;
    deferred_by: string | null;
  }[];
  return [...rows].map((row) => ({
    dealId: row.deal_id,
    code: row.code,
    by: row.deferred_by,
    // Unrounded, like the sum `deferredBalanceUsd` rounds once: rounding
    // each job first could move the total by a cent.
    owedUsd: Number(row.owed ?? 0),
  }));
}

/** Per-client totals for the balances screen — only clients with any activity. */
export async function clientBalances(ownerId?: string) {
  const rows = await db
    .select({
      clientId: clientTransactions.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      chargesUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'charge'), 0)`,
      // NET of what was handed back (R6a) — the one «received» rule.
      paymentsUsd: sql<string>`coalesce(sum(${netPaidUsdSql()}), 0)`,
      refundsUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'refund'), 0)`,
      // Compensations for lost cargo (0105): not money, not a price — a
      // column of their own, so charges − payments − compensated (+ fx) is
      // still the balance beside them.
      compensatedUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'compensation'), 0)`,
      // The kurs farqi rows (0103, Q14), signed: a column of their own so the
      // screen's columns still add up to the balance beside them.
      fxUsd: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'fx_diff'), 0)`,
      // The balance is the ONE sign rule, never JS arithmetic over columns.
      balanceUsd: sql<string>`coalesce(sum(${signedUsdSql()}), 0)`,
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
      // NET of what was handed back (R6a), so the screen's columns still add
      // up to the balance beside them.
      paymentsUsd: Math.round(Number(r.paymentsUsd) * 100) / 100,
      refundsUsd: Math.round(Number(r.refundsUsd) * 100) / 100,
      compensatedUsd: Math.round(Number(r.compensatedUsd) * 100) / 100,
      fxUsd: Math.round(Number(r.fxUsd) * 100) / 100,
      balanceUsd: Math.round(Number(r.balanceUsd) * 100) / 100,
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
      /** A compensation's prixod (0105): the lost cargo it pays for. */
      receiptNumber: receipts.number,
      /** …how many of its cartons are lost NOW, and of how many. */
      lostNow: sql<number | null>`CASE WHEN ${clientTransactions}.type = 'compensation' THEN (
        SELECT count(*)::int FROM boxes b JOIN receipt_lots rl ON rl.id = b.lot_id
         WHERE rl.receipt_id = ${clientTransactions}.receipt_id AND b.status = 'lost') END`,
      boxesTotal: sql<number | null>`CASE WHEN ${clientTransactions}.type = 'compensation' THEN (
        SELECT count(*)::int FROM boxes b JOIN receipt_lots rl ON rl.id = b.lot_id
         WHERE rl.receipt_id = ${clientTransactions}.receipt_id AND b.status <> 'void') END`,
      /**
       * Cartons of that prixod that came back from «yo'qolgan» since the
       * compensation was written — the ⚠ «tekshiring» (Q6), whichever door
       * restored them. Exact for a partial find, where «lost now = 0» was
       * not. `${clientTransactions}` the table (#128).
       */
      foundSince: sql<number | null>`CASE WHEN ${clientTransactions}.type = 'compensation' THEN (
        SELECT count(*)::int FROM box_movements bm
          JOIN boxes b ON b.id = bm.box_id
          JOIN receipt_lots rl ON rl.id = b.lot_id
         WHERE rl.receipt_id = ${clientTransactions}.receipt_id
           AND bm.from_status = 'lost' AND bm.to_status NOT IN ('lost', 'void')
           AND bm.created_at > ${clientTransactions}.created_at) END`,
      /**
       * WHICH JOB this money answers. `deal_id` has been written by the
       * payment form since #531 and read by nobody but the deferral netting —
       * so the owner would pick a deal, save, and watch it become invisible
       * («bitim belgilanadgan joyda birga berish kerak», 2026-09-14). A LEFT
       * join: most money names no job, and that is not a defect.
       */
      dealCode: deals.code,
      /** A settlement through a colleague's account is staff money (M3a). */
      partnerStaff: sql<boolean>`${partnerIsStaffSql()}`,
    })
    .from(clientTransactions)
    .innerJoin(users, eq(clientTransactions.createdBy, users.id))
    .leftJoin(batches, eq(clientTransactions.batchId, batches.id))
    .leftJoin(deals, eq(clientTransactions.dealId, deals.id))
    .leftJoin(receipts, eq(clientTransactions.receiptId, receipts.id))
    .where(eq(clientTransactions.clientId, clientId))
    .orderBy(desc(clientTransactions.createdAt))
    .limit(500);
}

/** Active charges already entered against one batch (pricing screen). */
export const batchCharges = cache(async function batchCharges(batchId: string) {
  return db
    .select({
      tx: clientTransactions,
      clientCode: clients.clientCode,
      clientName: clients.name,
      // The job each price on the truck went to — «Bu mashinadagi narxlar»
      // (Q8 «c») prints it, since a price's deal is now sometimes chosen.
      dealCode: deals.code,
      // A deal-less price the person CHOSE as «bitimsiz» (its create audit),
      // told from a whole-cargo one written before the deals were known
      // (`pricedHereReading`). `${clientTransactions}.id`, never the column
      // object: audit_log has an id of its own (#128).
      chosenNone: sql<boolean>`${chosenNoneSql(sql`${clientTransactions}.id`)}`,
    })
    .from(clientTransactions)
    .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
    .leftJoin(deals, eq(clientTransactions.dealId, deals.id))
    .where(and(eq(clientTransactions.batchId, batchId), isNull(clientTransactions.voidedAt)))
    .orderBy(desc(clientTransactions.createdAt));
});

/**
 * The truck's prices the lost-cargo door lowered to ZERO — voided with no copy
 * (`zeroedByCompensationSql`), so `batchCharges` never sees them, while the
 * unpriced rule still counts each as the price it was. The «Narx» tab's table
 * reads them BESIDE the live prices (`pricedHereReading`'s `zeroed`): a deal
 * whose part was given back is not «narx yo'q», is never pre-filled, and a row
 * typed for it asks first — or the next press bills again exactly what the
 * compensation took back (review A1). Kept OUT of `pricesSeen`: the write body
 * re-reads live ids only, and a voided row is in no live set.
 */
export const batchZeroedCharges = cache(async function batchZeroedCharges(batchId: string) {
  const rows = (await db.execute(sql`
    SELECT ct.id, ct.client_id, ct.deal_id, d.code AS deal_code,
           ${chosenNoneSql(sql`ct.id`)} AS chosen_none
      FROM client_transactions ct
      LEFT JOIN deals d ON d.id = ct.deal_id
     WHERE ct.batch_id = ${batchId}::uuid AND ct.type = 'charge' AND ct.voided_at IS NOT NULL
       AND ${zeroedByCompensationSql(sql`ct.id`)}
     ORDER BY ct.created_at DESC, ct.id`)) as unknown as {
    id: string;
    client_id: string;
    deal_id: string | null;
    deal_code: string | null;
    chosen_none: boolean;
  }[];
  return [...rows].map((row) => ({
    id: row.id,
    clientId: row.client_id,
    dealId: row.deal_id,
    dealCode: row.deal_code,
    chosenNone: Boolean(row.chosen_none),
  }));
});

/**
 * The unpriced rule asked of one truck (`tripCoverageOn`), once per request:
 * the truck card's header and the «Narx» tab under it both count «Narx
 * qo'yilgan» from it (owner's 1a).
 */
export const batchTripCoverage = cache(async function batchTripCoverage(batchId: string) {
  return tripCoverageOn(db, batchId);
});

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
      // A price taken back for lost cargo (0105) — the homes' «this month's
      // revenue» is charged − compensated, the P&L month's own figure (#513).
      compensated: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.type} = 'compensation'), 0)`,
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
    compensated: cents(row?.compensated),
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
 * The debt the handover gate blocks on: the balance less what a live deferral
 * excuses, to the cent. One home, because the counter and the waiting list's
 * «qarz» tag must say the same thing about the same client.
 *
 * Not `blockingDebtUsd`: `issue/approvals.ts` has an async one of that name
 * that reads the pool, and the tx-pool fence (rightly) matches by name — a
 * pure function sharing it reads as a pooled call inside the handover's
 * transaction.
 */
export function blockingDebtOf(balanceUsd: number, deferredUsd: number): number {
  return Math.round((balanceUsd - deferredUsd) * 100) / 100;
}

/**
 * Does that debt STOP the counter — more than a cent after the deferral? The
 * question the handover asks and the waiting list's «qarz» tag repeats; the
 * line is stated here once so the tag cannot light up for a client the
 * counter would let through (or stay dark for one it refuses).
 */
export function debtBlocks(balanceUsd: number, deferredUsd: number): boolean {
  return blockingDebtOf(balanceUsd, deferredUsd) > 0.009;
}

/**
 * Balance and live-deferral totals for MANY clients, in one query each.
 *
 * The per-client pair above is right for a counter where one customer is
 * standing; the waiting list (issue/waiting.ts) and the truck's pricing page
 * ask about many clients at once, and
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
