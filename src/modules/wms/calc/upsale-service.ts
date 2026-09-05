import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { calcOffers, expenseCategories, moneyAccounts } from '@/modules/platform/db/schema';
import { writeAudit, type AuditContext } from '@/modules/platform/audit/service';
import { getSetting } from '@/modules/platform/settings/service';
import { logger } from '@/modules/platform/logger';
import { balancesForClients } from '../finance/service';
import { rateFor } from '../costing/service';
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
}

const money = (n: unknown) => Math.round(Number(n ?? 0) * 100) / 100;

/** How many rows a screen may hold before it is a slice and says so (#559). */
export const UPSALE_CAP = 300;

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
  if (opts.from) where.push(sql`p.offered_at >= ${opts.from}::date`);
  // Inclusive to the end of the named day, the way every period filter here is.
  if (opts.to) where.push(sql`p.offered_at < (${opts.to}::date + 1)`);

  const raw = await db.execute<RawRow>(sql`
    SELECT p.*,
           u.full_name AS seller_name,
           c.id        AS client_id,
           c.client_code,
           c.name      AS client_name,
           inv.charged AS charged_usd
      FROM (${payableOffersSql()}) p
      JOIN users u ON u.id = p.offered_by
      LEFT JOIN deals d   ON d.id = p.entity_id AND p.entity_type = 'deal'
      LEFT JOIN clients c ON c.id = d.client_id
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(ct.amount_usd), 0) AS charged
          FROM client_transactions ct
         WHERE ct.deal_id = p.entity_id
           AND ct.voided_at IS NULL
           AND ct.type = 'charge'
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
    const bal = r.client_id ? balances.get(r.client_id) : undefined;
    let state: UpsaleState;
    if (r.payout_at) state = 'paid';
    else if (r.entity_type !== 'deal') state = 'no_deal';
    else if (money(r.charged_usd) < clientPriceUsd - MONEY_EPSILON) state = 'no_invoice';
    else if ((bal?.balanceUsd ?? 0) - (bal?.deferredUsd ?? 0) > MONEY_EPSILON) {
      state = 'awaiting_payment';
    } else state = 'payable';

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
      state,
    };
  });

  return { rows, truncated };
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
    cur.earnedUsd = money(cur.earnedUsd + r.upsaleUsd);
    if (r.state === 'paid') cur.paidUsd = money(cur.paidUsd + (r.paidUsd ?? 0));
    else cur.waitingUsd = money(cur.waitingUsd + r.upsaleUsd);
    out.set(r.sellerId, cur);
  }
  return [...out.values()].sort((a, b) => b.earnedUsd - a.earnedUsd);
}

/**
 * What the company owes its sellers, for the balance sheet.
 *
 * `payableUsd` only — an upsale is payable exactly when the client's cash is
 * already in, so it is a real liability against real money. What is merely
 * ACCRUED (earned on a job nobody has invoiced or collected) is reported on
 * the upsale screen and deliberately kept off the balance sheet: it is not
 * owed until the sale is.
 */
export async function upsaleLiability(): Promise<{ payableUsd: number; accruedUsd: number }> {
  const { rows } = await upsaleRows('all', '', {});
  let payableUsd = 0;
  let accruedUsd = 0;
  for (const r of rows) {
    // The LIABILITY is what is still owed, so it reads the remaining figure —
    // a job that already paid a commission owes only what a later, higher
    // re-offer added (audit A1).
    if (r.state === 'payable') payableUsd = money(payableUsd + r.payableUsd);
    else if (r.state !== 'paid') accruedUsd = money(accruedUsd + r.payableUsd);
  }
  return { payableUsd, accruedUsd };
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

  // The payout is an ordinary expense in a category the owner names once, so
  // the P&L, the cash flow and /accounting/expenses all see it for free. It is
  // MANDATORY and not overridable: paid into «Oyliklar» it would land on
  // `generateRecurring`'s idempotence slot — (category, date, employee,
  // warehouse), with no discriminator — and that seller's salary for the month
  // would be counted as already posted and silently skipped.
  const categoryId = String((await getSetting('upsale_expense_category_id')) ?? '').trim();
  if (!categoryId) throw new CalcError('upsale_category_unset');

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
  const quoted = await db.execute<{ id: string; payable_usd: string; offered_by: string }>(sql`
    SELECT p.id, p.payable_usd, p.offered_by
      FROM (${payableOffersSql()}) p
     WHERE p.id IN (${idList}) AND p.payout_expense_id IS NULL
  `);
  if (quoted.length !== ids.length) throw new CalcError('offer_not_payable');

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

  const { addExpenseTx } = await import('../accounting/service');

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
      .select({ id: expenseCategories.id })
      .from(expenseCategories)
      .where(and(eq(expenseCategories.id, id), eq(expenseCategories.active, true)));
    if (!row) throw new CalcError('category_not_found');
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
