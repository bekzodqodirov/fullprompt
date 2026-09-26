import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { calcOffers, expenseCategories, moneyAccounts } from '@/modules/platform/db/schema';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { getSetting } from '@/modules/platform/settings/service';
import { logger } from '@/modules/platform/logger';
import { balancesForClients } from '../finance/service';
import { rateFor } from '../costing/service';
import { latestTxDate } from '../finance/dates';
import { CalcError } from './service';
import { MONEY_EPSILON, payableOffersSql } from './upsale';
import type { UpsaleScope } from './upsale-scope';

/**
 * The upsale's services (docs/VED.md law 4) — reading it, allowing it, paying it.
 *
 * Every read embeds `payableOffersSql()` and none of them restates it. The
 * one deliberate second use is `payUpsale`'s claim, which embeds the SAME
 * fragment as a correlated source inside its own UPDATE rather than trusting
 * the ids the accountant ticked: between the queue rendering and the press a
 * VED can discount a job or a colleague can pay it, and a claim that trusts
 * the posted list pays money the rule no longer allows.
 *
 * The client's money is asked in a SECOND grouped query rather than joined
 * into the first. That keeps the deferral rule where it already lives —
 * `liveDeferralWhere` in finance/service.ts, the handover gate's own — instead
 * of restating it in a string here (#513), and it is two queries for any
 * number of rows rather than two per row (#432).
 */

export type UpsaleState = 'paid' | 'payable' | 'awaiting_payment' | 'no_invoice' | 'no_deal';

export interface UpsaleRow {
  offerId: string;
  requestId: string;
  entityType: 'deal' | 'lead';
  entityId: string;
  sellerId: string;
  sellerName: string | null;
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  offeredAt: Date;
  section: string;
  clientPriceUsd: number;
  floorUsd: number;
  upsaleUsd: number;
  /** What a payout would MOVE today: the promise's difference less whatever
   * this job has already paid (audit A1). Equal to `upsaleUsd` on the
   * ordinary once-offered job; smaller after a re-offer on a paid one. */
  payableUsd: number;
  paidAt: Date | null;
  paidUsd: number | null;
  /** Taken back for the job's lost cargo (0105) — why a commission waits. */
  compensatedUsd: number;
  state: UpsaleState;
}

interface RawRow extends Record<string, unknown> {
  id: string;
  request_id: string;
  entity_type: string;
  entity_id: string;
  offered_by: string;
  offered_at: Date;
  section: string;
  client_price_usd: string;
  total_usd: string;
  upsale_usd: string;
  payable_usd: string;
  payout_at: Date | null;
  payout_usd: string | null;
  seller_name: string | null;
  client_id: string | null;
  client_code: string | null;
  client_name: string | null;
  charged_usd: string | null;
  compensated_usd: string | null;
}

const money = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

/** How many rows a screen may hold before it is a slice and says so (#559). */
export const UPSALE_CAP = 300;

/**
 * Why one offer is or is not payable yet — the rule, ONCE, for the /upsale
 * screen and the Balans's liability line (audit U10), so the screen and the
 * balance sheet cannot drift about which commission is owed (#513). See
 * `upsaleRows` for the three states and why each is asked of the DEAL.
 */
export function upsaleStateOf(
  row: {
    payout_at: Date | null;
    entity_type: string;
    client_price_usd: string;
    charged_usd: string | null;
    /**
     * Taken back for the job's lost cargo (0105). REQUIRED: both readers
     * must pass it, or a job whose price was taken back pays a commission.
     */
    compensated_usd: string | null;
  },
  bal: { balanceUsd: number; deferredUsd: number } | undefined,
): UpsaleState {
  if (row.payout_at) return 'paid';
  if (row.entity_type !== 'deal') return 'no_deal';
  // The job's NET price (his own rule, a lowered price holds the upsale):
  // whether the price was lowered or kept and compensated above it, a job
  // whose money was taken back is «Hisob-faktura yo'q» until it is whole.
  if (money(money(row.charged_usd) - money(row.compensated_usd)) < money(row.client_price_usd) - MONEY_EPSILON) {
    return 'no_invoice';
  }
  if ((bal?.balanceUsd ?? 0) - (bal?.deferredUsd ?? 0) > MONEY_EPSILON) return 'awaiting_payment';
  return 'payable';
}

/**
 * Every upsale in the window, with why each one is or is not payable yet.
 *
 * The obvious single question — «has the client paid?» — is wrong asked
 * alone: a balance of zero is true of a client who has settled AND of a
 * client nobody has invoiced, and a client with no ledger rows at all has no
 * row to read, so the offer falls out of every bucket and is never paid,
 * silently. Three states, asked about the DEAL:
 *
 *   no_invoice        — less has been charged on this deal than was quoted
 *   awaiting_payment  — charged, and the client still owes past their deferral
 *   payable           — charged and collected
 *
 * Collection uses `balance − deferred`, the handover gate's own arithmetic:
 * a deferral is a decision the owner already made, and a commission gate
 * stricter than the gate that released the cargo leaves sellers unpaid on
 * goods the company has already handed over.
 */
export async function upsaleRows(
  scope: UpsaleScope,
  actorId: string,
  opts: { from?: string; to?: string; sellerId?: string } = {},
): Promise<{ rows: UpsaleRow[]; truncated: boolean }> {
  if (scope === 'none') return { rows: [], truncated: false };

  const where = [sql`TRUE`];
  if (scope === 'own') where.push(sql`p.offered_by = ${actorId}::uuid`);
  else if (opts.sellerId) where.push(sql`p.offered_by = ${opts.sellerId}::uuid`);
  // Tashkent's days (R5) — a bare `::date` against the timestamptz is a UTC
  // midnight, so an offer made at 02:00 on the 1st counted in the previous
  // month.
  if (opts.from) where.push(sql`p.offered_at >= ((${opts.from}::date)::timestamp AT TIME ZONE 'Asia/Tashkent')`);
  // Inclusive to the end of the named day, the way every period filter here is.
  if (opts.to) where.push(sql`p.offered_at < ((${opts.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tashkent')`);

  const raw = await db.execute<RawRow>(sql`
    SELECT p.*,
           u.full_name AS seller_name,
           c.id        AS client_id,
           c.client_code,
           c.name      AS client_name,
           inv.charged AS charged_usd,
           inv.compensated AS compensated_usd
      FROM (${payableOffersSql()}) p
      JOIN users u ON u.id = p.offered_by
      LEFT JOIN deals d   ON d.id = p.entity_id AND p.entity_type = 'deal'
      LEFT JOIN clients c ON c.id = d.client_id
      LEFT JOIN LATERAL (
        -- The job's prices AND what was taken back for its lost cargo (0105),
        -- in both readers — the screen and the Balans liability decide in
        -- ONE place (upsaleStateOf) on the job's NET price.
        SELECT coalesce(sum(ct.amount_usd) FILTER (WHERE ct.type = 'charge'), 0) AS charged,
               coalesce(sum(ct.amount_usd) FILTER (WHERE ct.type = 'compensation'), 0) AS compensated
          FROM client_transactions ct
         WHERE ct.deal_id = p.entity_id
           AND ct.voided_at IS NULL
           AND ct.type IN ('charge', 'compensation')
      ) inv ON p.entity_type = 'deal'
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY p.offered_at DESC
     LIMIT ${UPSALE_CAP + 1}
  `);

  const truncated = raw.length > UPSALE_CAP;
  const slice = truncated ? raw.slice(0, UPSALE_CAP) : raw;

  const balances = await balancesForClients(
    slice.map((r) => r.client_id).filter((x): x is string => Boolean(x)),
  );

  const rows = slice.map((r): UpsaleRow => {
    const clientPriceUsd = money(r.client_price_usd);
    const state = upsaleStateOf(r, r.client_id ? balances.get(r.client_id) : undefined);

    return {
      offerId: r.id,
      requestId: r.request_id,
      entityType: r.entity_type as 'deal' | 'lead',
      entityId: r.entity_id,
      sellerId: r.offered_by,
      sellerName: r.seller_name,
      clientId: r.client_id,
      clientCode: r.client_code,
      clientName: r.client_name,
      offeredAt: new Date(r.offered_at),
      section: r.section,
      clientPriceUsd,
      floorUsd: money(r.total_usd),
      upsaleUsd: money(r.upsale_usd),
      payableUsd: money(r.payable_usd),
      paidAt: r.payout_at ? new Date(r.payout_at) : null,
      paidUsd: r.payout_usd === null ? null : money(r.payout_usd),
      compensatedUsd: money(r.compensated_usd),
      state,
    };
  });

  return { rows, truncated };
}

/**
 * What one row adds to «earned»: the money actually handed over on a paid
 * row, and what is still owed on an unpaid one — never the promise's whole
 * difference. Since audit A18 a sale's paid row stays listed beside a later,
 * higher re-offer of the same sale, and adding both promises would count the
 * part already paid twice.
 */
export function earnedOf(row: UpsaleRow): number {
  return row.state === 'paid' ? (row.paidUsd ?? 0) : row.payableUsd;
}

/** Per-seller totals for the scoreboard — ONE grouped pass over the rows. */
export function bySeller(rows: UpsaleRow[]) {
  const out = new Map<
    string,
    { sellerId: string; sellerName: string | null; jobs: number; earnedUsd: number; paidUsd: number; waitingUsd: number }
  >();
  for (const r of rows) {
    const cur =
      out.get(r.sellerId) ??
      { sellerId: r.sellerId, sellerName: r.sellerName, jobs: 0, earnedUsd: 0, paidUsd: 0, waitingUsd: 0 };
    cur.jobs += 1;
    cur.earnedUsd = money(cur.earnedUsd + earnedOf(r));
    if (r.state === 'paid') cur.paidUsd = money(cur.paidUsd + (r.paidUsd ?? 0));
    else cur.waitingUsd = money(cur.waitingUsd + r.payableUsd);
    out.set(r.sellerId, cur);
  }
  return [...out.values()].sort((a, b) => b.earnedUsd - a.earnedUsd);
}

/**
 * What the company owes its sellers, for the balance sheet.
 *
 * `payableUsd` only — an upsale is payable exactly when the client's cash is
 * already in, so it is a real liability against real money. What is merely
 * ACCRUED (earned on a job nobody has invoiced or collected) is returned for
 * a hint and deliberately kept off the balance sheet: it is not owed until
 * the sale is.
 *
 * An UNCAPPED aggregate (audit U10): it used to read `upsaleRows`, whose list
 * is the screen's — capped at UPSALE_CAP newest rows, paid ones kept for ever
 * — so once a year of paid commissions had piled up, an older unpaid one fell
 * off the slice and the liability read $0. Same fragment, same deal/charged
 * LATERAL and the same state rule (`upsaleStateOf`) as the screen, with no
 * ORDER BY and no LIMIT, over the unpaid DEAL offers only; two grouped
 * queries for any number of rows (#432).
 */
export async function upsaleLiability(): Promise<{ payableUsd: number; payableCount: number; accruedUsd: number }> {
  const raw = await db.execute<{
    entity_type: string;
    client_price_usd: string;
    payable_usd: string;
    payout_at: Date | null;
    client_id: string | null;
    charged_usd: string | null;
    compensated_usd: string | null;
  }>(sql`
    SELECT p.entity_type, p.client_price_usd, p.payable_usd, p.payout_at,
           d.client_id,
           inv.charged AS charged_usd,
           inv.compensated AS compensated_usd
      FROM (${payableOffersSql()}) p
      LEFT JOIN deals d ON d.id = p.entity_id AND p.entity_type = 'deal'
      LEFT JOIN LATERAL (
        -- The job's prices AND what was taken back for its lost cargo (0105),
        -- in both readers — the screen and the Balans liability decide in
        -- ONE place (upsaleStateOf) on the job's NET price.
        SELECT coalesce(sum(ct.amount_usd) FILTER (WHERE ct.type = 'charge'), 0) AS charged,
               coalesce(sum(ct.amount_usd) FILTER (WHERE ct.type = 'compensation'), 0) AS compensated
          FROM client_transactions ct
         WHERE ct.deal_id = p.entity_id
           AND ct.voided_at IS NULL
           AND ct.type IN ('charge', 'compensation')
      ) inv ON p.entity_type = 'deal'
     WHERE p.payout_expense_id IS NULL
       AND p.entity_type = 'deal'
  `);
  const balances = await balancesForClients(
    raw.map((r) => r.client_id).filter((x): x is string => Boolean(x)),
  );
  let payableUsd = 0;
  let payableCount = 0;
  let accruedUsd = 0;
  for (const r of raw) {
    // The LIABILITY is what is still owed, so it reads the remaining figure —
    // a job that already paid a commission owes only what a later, higher
    // re-offer added (audit A1).
    const state = upsaleStateOf(r, r.client_id ? balances.get(r.client_id) : undefined);
    if (state === 'payable') {
      payableUsd = money(payableUsd + money(r.payable_usd));
      payableCount += 1;
    } else if (state !== 'paid') accruedUsd = money(accruedUsd + money(r.payable_usd));
  }
  return { payableUsd, payableCount, accruedUsd };
}

/**
 * Pay a seller for the offers the accountant ticked.
 *
 * The amount is DERIVED, never typed. The accountant chooses which jobs, the
 * till, the currency and the date; the server sums those jobs' upsale and
 * writes that. A typed figure is how a screen ends up saying «$340 paid»
 * while $200 leaves the till, and a partial payment is expressed by ticking
 * fewer jobs rather than by writing a smaller number.
 *
 * Everything that READS happens before the transaction (#714/#725): the rate,
 * the category setting and the account's currency all come from the pool, and
 * inside the transaction only the expense insert, the claim and the audit run.
 */
export async function payUpsale(
  offerIds: string[],
  input: { accountId: string; currency: string; expenseDate: string; note?: string },
  ctx: AuditContext,
): Promise<{ expenseId: string; paidUsd: number; count: number }> {
  if (!ctx.actorId) throw new CalcError('unauthenticated');
  const ids = [...new Set(offerIds)].filter(Boolean);
  if (ids.length === 0) throw new CalcError('no_offers');
  // #995's rule (U21), asked before any read or claim so the refusal is in
  // the upsale's own words; `addExpenseTx` asks it again as the last door.
  if (input.expenseDate > latestTxDate()) throw new CalcError('future_date');

  // The payout is an ordinary expense in a category the owner names once, so
  // the P&L, the cash flow and /accounting/expenses all see it for free. It is
  // MANDATORY and not overridable: paid into «Oyliklar» the P&L's salary line
  // would carry commissions, and the seller's monthly salary — a recurring
  // template since 0099, paid by «To'landi» since 0106 — would see the payout
  // offered as its own payment on the due list were it not for the candidate
  // rule's payout fence (accounting/recurring-sql.ts). A kind of its own keeps
  // both honest without leaning on that fence.
  const categoryId = String((await getSetting('upsale_expense_category_id')) ?? '').trim();
  if (!categoryId) throw new CalcError('upsale_category_unset');

  const { addExpenseTx, namesMoneyOnNonCash } = await import('../accounting/service');
  // Every payout carries a till, so its category must move money (U06) — a
  // setting chosen before that rule existed is refused here, on the pool and
  // before the transaction (#714), in words.
  if (await namesMoneyOnNonCash(categoryId, { accountId: input.accountId })) {
    throw new CalcError('non_cash_category');
  }

  const rate = await rateFor(input.currency, input.expenseDate);
  if (rate === null) throw new CalcError('fx_missing');

  const [account] = await db
    .select({ currency: moneyAccounts.currency })
    .from(moneyAccounts)
    .where(eq(moneyAccounts.id, input.accountId));
  if (!account) throw new CalcError('not_found');
  if (account.currency !== input.currency) throw new CalcError('account_currency_mismatch');

  // What these jobs are worth, by the rule and not by the browser. Read here
  // rather than inside the transaction because the expense must carry the
  // amount at the moment it is inserted, and the claim below re-derives the
  // same rule and refuses if anything moved in between.
  const idList = sql.join(
    ids.map((offerId) => sql`${offerId}::uuid`),
    sql`, `,
  );
  // …and by the STATE rule the screen draws the tick from (review of the
  // comp unit): «a job whose price was taken back pays no commission» and
  // «the client has not paid yet» lived in upsaleStateOf alone, so a posted
  // id — a stale tab, a forged post — paid a commission the screen would
  // not have offered. The same two sums, the same balances, the same word.
  const quoted = await db.execute<{
    id: string;
    payable_usd: string;
    offered_by: string;
    payout_at: Date | null;
    entity_type: string;
    client_price_usd: string;
    client_id: string | null;
    charged_usd: string | null;
    compensated_usd: string | null;
  }>(sql`
    SELECT p.id, p.payable_usd, p.offered_by, p.payout_at, p.entity_type, p.client_price_usd,
           d.client_id, inv.charged AS charged_usd, inv.compensated AS compensated_usd
      FROM (${payableOffersSql()}) p
      LEFT JOIN deals d ON d.id = p.entity_id AND p.entity_type = 'deal'
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(ct.amount_usd) FILTER (WHERE ct.type = 'charge'), 0) AS charged,
               coalesce(sum(ct.amount_usd) FILTER (WHERE ct.type = 'compensation'), 0) AS compensated
          FROM client_transactions ct
         WHERE ct.deal_id = p.entity_id AND ct.voided_at IS NULL AND ct.type IN ('charge', 'compensation')
      ) inv ON p.entity_type = 'deal'
     WHERE p.id IN (${idList}) AND p.payout_expense_id IS NULL
  `);
  if (quoted.length !== ids.length) throw new CalcError('offer_not_payable');
  const stateBalances = await balancesForClients(
    quoted.map((q) => q.client_id).filter((x): x is string => Boolean(x)),
  );
  if (quoted.some((q) => upsaleStateOf(q, q.client_id ? stateBalances.get(q.client_id) : undefined) !== 'payable')) {
    throw new CalcError('offer_not_payable');
  }

  const sellers = new Set(quoted.map((q) => q.offered_by));
  // One expense names one employee. Paying two sellers on one row puts both
  // names on it and neither on the P&L honestly.
  if (sellers.size !== 1) throw new CalcError('one_seller_at_a_time');
  const employeeId = [...sellers][0]!;

  // The REMAINING amount, not the promise's whole difference: a job that has
  // already paid a commission pays only what a higher re-offer added (A1).
  const paidUsd = money(quoted.reduce((sum, q) => sum + Number(q.payable_usd), 0));
  if (!(paidUsd > 0)) throw new CalcError('nothing_to_pay');
  const amount = Math.round((paidUsd / rate) * 100) / 100;

  return db.transaction(async (tx) => {
    const expense = await addExpenseTx(
      tx,
      {
        categoryId,
        amount,
        currency: input.currency,
        expenseDate: input.expenseDate,
        accountId: input.accountId,
        employeeId,
        note: input.note?.trim() || `Upsale · ${quoted.length}`,
      } as Parameters<typeof addExpenseTx>[1],
      rate,
      ctx,
    );

    // The claim IS the UPDATE, and it re-derives the whole payable rule rather
    // than trusting the ids that were ticked: between the queue rendering and
    // the press a VED can discount a job or a colleague can pay it, and a
    // claim that trusts the posted list pays money the rule no longer allows.
    //
    // All four payout columns are set in ONE statement, because
    // `calc_offers_payout_pair_check` says paid is all four or none — which
    // caught the first version of this function writing them in two steps.
    const claimed = await tx.execute<{ id: string; payout_usd: string }>(sql`
      UPDATE calc_offers o
         SET payout_expense_id = ${expense.id}::uuid,
             payout_at = now(),
             payout_by = ${ctx.actorId}::uuid,
             payout_usd = p.payable_usd
        FROM (${payableOffersSql()}) p
       WHERE o.id = p.id
         AND o.id IN (${idList})
         AND o.payout_expense_id IS NULL
      RETURNING o.id, o.payout_usd
    `);

    // Short by one row, or short by a cent, and the amount already written on
    // the expense is no longer the right amount — so the whole thing rolls
    // back rather than paying a figure nothing agrees with.
    if (claimed.length !== ids.length) throw new CalcError('offer_already_paid');
    const claimedUsd = money(claimed.reduce((sum, c) => sum + Number(c.payout_usd), 0));
    if (claimedUsd !== paidUsd) throw new CalcError('amount_moved');

    await writeAudit(tx, ctx, {
      entityType: 'expense',
      entityId: expense.id,
      action: 'update',
      after: { upsaleOffers: claimed.length, paidUsd, employeeId },
    });

    return { expenseId: expense.id, paidUsd, count: claimed.length };
  });
}

/**
 * A taken-back payout re-opens the offers it settled (#528's pair rule).
 *
 * Without it a voided expense leaves its offers reading «to'landi» for ever
 * and the seller is never paid again for work they did.
 */
export async function reopenUpsaleForExpense(expenseId: string): Promise<number> {
  const rows = await db
    .update(calcOffers)
    .set({ payoutExpenseId: null, payoutAt: null, payoutBy: null, payoutUsd: null })
    .where(eq(calcOffers.payoutExpenseId, expenseId))
    .returning({ id: calcOffers.id });
  if (rows.length > 0) logger.info({ expenseId, count: rows.length }, '[upsale] payout reopened');
  return rows.length;
}

/** Below-floor promises waiting on a person. */
export async function pendingBelowFloor() {
  return db
    .select()
    .from(calcOffers)
    .where(and(eq(calcOffers.belowFloor, true), isNull(calcOffers.approvedAt)))
    .orderBy(calcOffers.offeredAt);
}

/**
 * Which expense category an upsale payout is written into — CHOSEN, not typed.
 *
 * It is a setting and so it renders on `/admin/settings` like every other
 * one: a mono text box asking for a uuid the owner has no screen to read one
 * from. That is not a choice a person can make, so the real door is a picker
 * on `/upsale` — beside the button that refuses without it — exactly as
 * `crm_calc_stage` is picked on the funnel's own settings screen.
 *
 * The id is re-checked against the table here and not merely against the
 * `<select>`: a picker's bad value is a forged post (#506-508). ACTIVE only,
 * because a retired category would be accepted once and then quietly stop
 * being a category anybody can post into. An empty value is a real answer —
 * «nobody has chosen» — and `payUpsale` refuses with its own sentence.
 */
export async function setUpsaleCategory(categoryId: string, ctx: AuditContext): Promise<void> {
  const id = categoryId.trim();
  if (id) {
    const [row] = await db
      .select({ id: expenseCategories.id, cash: expenseCategories.cash })
      .from(expenseCategories)
      .where(and(eq(expenseCategories.id, id), eq(expenseCategories.active, true)));
    if (!row) throw new CalcError('category_not_found');
    // A commission is money HANDED OVER, out of a till every time (U06): a
    // non-cash kind (depreciation) would take it out of the drawer while the
    // cash flow said nothing left.
    if (!row.cash) throw new CalcError('non_cash_category');
  }
  const { getSetting, setSetting, SETTINGS_AUDIT_ID } = await import(
    '@/modules/platform/settings/service'
  );
  const before = await getSetting('upsale_expense_category_id');
  await setSetting('upsale_expense_category_id', id, ctx.actorId ?? null);
  // The same entity the generic settings screen audits under, so one history
  // reads whichever door was used.
  await writeAudit(db, ctx, {
    entityType: 'settings',
    entityId: SETTINGS_AUDIT_ID,
    action: 'update',
    before: { upsale_expense_category_id: before },
    after: { upsale_expense_category_id: id },
  });
}

/**
 * «The cash screen must show both figures side by side» — law 4's accountant
 * half, found missing by the whole-module audit: the payout screen had both
 * numbers, the cash INTAKE (the client's ledger, the one charge/payment door)
 * had neither. One row per deal that carries a standing released offer: the
 * sealed floor and the client price, so the person taking the money sees what
 * the client owes AND what of it is the company's.
 *
 * The CALLER gates on `upsaleScopeFor(actor) === 'all'` — this read is the
 * difference between the two numbers, i.e. the upsale, and law 4 shows that
 * to the owner and the accountant only. Not baked in here because the page
 * already resolved the actor and a second resolution per panel is #432's
 * shape.
 */
export async function bothFiguresForDeals(
  dealIds: string[],
): Promise<Map<string, { floorUsd: number; clientPriceUsd: number }>> {
  const out = new Map<string, { floorUsd: number; clientPriceUsd: number }>();
  const ids = [...new Set(dealIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const { offerStandsSql, releasedOfferWhere } = await import('./workspace');
  const rows = await db
    .select({
      dealId: calcOffers.entityId,
      clientPriceUsd: calcOffers.clientPriceUsd,
      // Phase 4: the floor follows the offer's anchor — version total, or the
      // Готово answer. A version-only subselect here read NULL on every
      // request-anchored row, and money(NULL) prints a $0 floor on the cash
      // screen (judge, phase 4).
      floorUsd: sql<string>`COALESCE(
        (SELECT v.total_usd FROM calc_versions v WHERE v.id = ${calcOffers.versionId}),
        (SELECT r.answer_amount FROM calc_requests r WHERE r.id = ${calcOffers.requestId})
      )`,
      offeredAt: calcOffers.offeredAt,
    })
    .from(calcOffers)
    .where(
      and(
        eq(calcOffers.entityType, 'deal'),
        inArray(calcOffers.entityId, ids),
        releasedOfferWhere(),
        offerStandsSql(),
      ),
    )
    .orderBy(calcOffers.offeredAt);
  // Ordered ascending and overwritten, so the NEWEST standing offer per deal
  // wins — the same answer releasedPriceFor gives one deal at a time.
  for (const r of rows) {
    out.set(r.dealId, { floorUsd: money(r.floorUsd), clientPriceUsd: money(r.clientPriceUsd) });
  }
  return out;
}
