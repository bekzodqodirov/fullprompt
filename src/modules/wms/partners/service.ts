import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import {
  batches,
  clients,
  clientTransactions,
  costEntries,
  expenses,
  moneyAccounts,
  partners,
  partnerTransactions,
  partnerTypes,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { rateFor } from '../costing/service';
import { staffPartnerSql } from './staff';
import { latestTxDate } from '../finance/dates';
import { exceedsRowUsd, signedNativeAmount } from '../finance/money-bounds';
import { mayPickTill } from '../accounting/till-door';

/**
 * Kontragentlar — the other side of the money (round 39, the owner's three
 * cases in one shape).
 *
 * The client ledger answers "who owes US". Nothing answered "who do WE owe",
 * so a truck taken on credit was a cost with no creditor, customs paid out of
 * another firm's account looked like our cash leaving, and the two men who
 * wire som into the company account and collect dollars from the till existed
 * only in somebody's notebook.
 *
 * One account per counterparty, five kinds of row, and the rule that keeps
 * the reports honest: **a cost and a debt are two different facts**. Entering
 * a cost against a partner does not move money; paying the partner does, and
 * the cost is not counted twice because the payment is not a cost.
 */

export class PartnerError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Rows that RAISE what we owe. The rest lower it (`adjust` and `fx_diff` do either). */
const RAISING = ['charge', 'receipt'] as const;

/**
 * Every kind a partner row may STORE. `fx_diff` (0103, the owner's Q14 A) is
 * the system's own «kurs farqi»: native 0, a signed dollar figure that closes
 * the residue of an account back at zero in its own currency. Nobody types it.
 */
export const PARTNER_TX_TYPES = ['charge', 'receipt', 'payment', 'offset', 'adjust', 'fx_diff'] as const;
export type PartnerTxType = (typeof PARTNER_TX_TYPES)[number];
/** The kinds a row may be POSTED as through any form (never `fx_diff`). */
const POSTED_TX_TYPES = ['charge', 'receipt', 'payment', 'offset', 'adjust'] as const satisfies readonly PartnerTxType[];

/**
 * The partner ledger's one sign rule, in SQL (0103 — it was restated inline in
 * four readers): + raises what WE owe, − lowers it; `adjust` and `fx_diff`
 * carry their sign in the amount. `column` names the native amount or the
 * dollars; `alias` the table alias of a raw correlated subquery (#128),
 * omitted for the drizzle table itself.
 */
export function partnerSignedSql(column: 'amount_usd' | 'amount', alias?: string): SQL {
  const col = (name: string) =>
    alias ? sql.raw(`${alias}.${name}`) : sql`${partnerTransactions}.${sql.raw(name)}`;
  return sql`(CASE WHEN ${col('type')} IN ('charge', 'receipt', 'adjust', 'fx_diff') THEN ${col(column)} ELSE -${col(column)} END)`;
}

/**
 * Which way each kind moves the account's OWN currency — the walk that finds
 * where a currency returns to zero (Q14). `fx_diff` never walks (native 0).
 */
export const PARTNER_NATIVE_SIGN: Record<Exclude<PartnerTxType, 'fx_diff'>, 1 | -1 | 'signed'> = {
  charge: 1,
  receipt: 1,
  payment: -1,
  offset: -1,
  adjust: 'signed',
};

/**
 * The kinds a person may write by hand on a partner's card (audit A31,
 * 2026-09-24). A `charge` is a debt for a SERVICE we took — a truck, customs,
 * rent, a salary — and a service is a cost: typed on the card it raised the
 * debt and reached no P&L, no tannarx and no profit screen, which is exactly
 * what DECISIONS #415 forbade («a cost and a debt are different facts — the
 * cost form's payer writes the charge»). It is written by the cost and expense
 * forms' «kim to'ladi» (`partners/link.ts`) and nowhere else. An `offset` is
 * a debt closed through a CLIENT, and has its own screen that names one.
 */
export const MANUAL_TX_TYPES: PartnerTxType[] = ['payment', 'receipt', 'adjust'];

/** Types that moved real money, and so must name the cash box that moved. */
export const CASH_TYPES: PartnerTxType[] = ['receipt', 'payment'];

/**
 * Does this row push what we owe UP? The one question a ledger row's colour
 * and sign both answer, and the ledger page used to answer it differently
 * from `balanceExpr` — which is the only opinion that decides the total.
 *
 * `adjust` is the kind whose SIGN is the meaning: a positive correction raises
 * the debt, a negative one lowers it, and the balance adds it signed. Reading
 * it as a reduction printed a +50 correction as «−$50.00» in green under a
 * balance it had just pushed up, so the rows stopped adding to the figure
 * above them. Exported so the screen and the sum cannot drift again.
 */
export function raisesBalance(type: string, amountUsd: number): boolean {
  if (type === 'adjust' || type === 'fx_diff') return amountUsd > 0;
  return (RAISING as readonly string[]).includes(type);
}

/**
 * The «kimga qarzdormiz» register, grouped.
 *
 * Grouping runs over EVERY type, including the hidden ones: `listPartnerTypes`
 * returns active types only, so an account whose type was hidden on
 * /admin/partner-types matched no group and vanished from the screen — while
 * its debt stayed in the total above it, and its card became reachable only by
 * typing the uuid. Hiding a type means "do not offer it for new accounts", not
 * "delete the accounts already under it".
 */
export function groupPartnersByType<T extends { code: string }>(
  rows: PartnerRow[],
  types: T[],
): { type: T; rows: PartnerRow[] }[] {
  return types
    .map((type) => ({ type, rows: rows.filter((row) => row.typeCode === type.code) }))
    .filter((group) => group.rows.length > 0);
}

export const partnerSchema = z.object({
  name: z.string().trim().min(2).max(200),
  typeId: z.string().uuid(),
  clientId: z.string().uuid().optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
  /**
   * The login this account belongs to (0101). THREE states, on purpose:
   * `undefined` = the form did not carry the field (it is drawn only for the
   * accountant and the admin), and that must read «unchanged» — a replace-all
   * save that took absence for «nobody» would unlink every staff account the
   * first time a VED fixed a typo on it (#171's shape); `''` = unlinked; a
   * uuid = linked.
   */
  userId: z.string().uuid().optional().or(z.literal('')),
});

/**
 * The check above and the write below are two statements, so two accountants
 * linking the same login at once both pass the check and the unique index
 * answers the second — as the same sentence, not as the error page (#472).
 */
async function write<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    type PgError = { code?: string; constraint_name?: string };
    const pg = err as PgError & { cause?: PgError };
    const code = pg?.code ?? pg?.cause?.code;
    const constraint = pg?.constraint_name ?? pg?.cause?.constraint_name;
    if (code === '23505' && constraint === 'partners_user_uniq') {
      throw new PartnerError('user_taken');
    }
    throw err;
  }
}

export async function savePartner(
  id: string | null,
  input: z.infer<typeof partnerSchema>,
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new PartnerError('unauthenticated');
  const clientId = input.clientId || null;
  if (clientId) {
    // One account per client, checked here so the screen can say WHY rather
    // than showing a unique-index crash.
    const [taken] = await db
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.clientId, clientId))
      .limit(1);
    if (taken && taken.id !== id) throw new PartnerError('client_taken');
  }
  const before = id ? await db.query.partners.findFirst({ where: eq(partners.id, id) }) : null;
  if (id && !before) throw new PartnerError('not_found');

  // Absent = unchanged (see the schema). Present: one account per login,
  // checked here so the screen can say WHY rather than the unique index
  // answering with a crash — and a login newly linked must be a live one (the
  // form offers active people only; the one ALREADY linked stays linkable, or
  // an unrelated edit on a leaver's account would be refused for ever).
  const userId = input.userId === undefined ? undefined : input.userId || null;
  if (userId) {
    const [person] = await db
      .select({ active: users.active })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!person || (!person.active && before?.userId !== userId)) {
      throw new PartnerError('user_not_found');
    }
    const [taken] = await db
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.userId, userId))
      .limit(1);
    if (taken && taken.id !== id) throw new PartnerError('user_taken');
  }
  const values = {
    name: input.name,
    typeId: input.typeId,
    clientId,
    phone: input.phone || null,
    note: input.note || null,
    ...(userId === undefined ? {} : { userId }),
  };

  if (id && before) {
    await write(() => db.update(partners).set(values).where(eq(partners.id, id)));
    await writeAudit(db, ctx, {
      entityType: 'partner',
      entityId: id,
      action: 'update',
      before: {
        name: before.name,
        typeId: before.typeId,
        clientId: before.clientId,
        userId: before.userId,
      },
      after: values,
    });
    return id;
  }

  const createdBy = ctx.actorId;
  const [row] = await write(() =>
    db
      .insert(partners)
      .values({ ...values, createdBy })
      .returning(),
  );
  await writeAudit(db, ctx, {
    entityType: 'partner',
    entityId: row!.id,
    action: 'create',
    after: values,
  });
  return row!.id;
}

export async function setPartnerActive(id: string, active: boolean, ctx: AuditContext) {
  if (!ctx.actorId) throw new PartnerError('unauthenticated');
  await db.update(partners).set({ active }).where(eq(partners.id, id));
  await writeAudit(db, ctx, {
    entityType: 'partner',
    entityId: id,
    action: 'update',
    after: { active },
  });
}

export const partnerTxSchema = z
  .object({
    partnerId: z.string().uuid(),
    type: z.enum(POSTED_TX_TYPES),
    // Signed (an `adjust` may be negative) and bounded BOTH ways by the
    // column (U44): −5e13 used to reach postgres as 22003, an error page.
    amount: signedNativeAmount(),
    currency: z.string().length(3).toUpperCase(),
    txDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    accountId: z.string().uuid().optional().or(z.literal('')),
    batchId: z.string().uuid().optional().or(z.literal('')),
    note: z.string().trim().max(2000).optional().or(z.literal('')),
  })
  // Zero is never an entry; only a correction may be negative.
  .refine((v) => (v.type === 'adjust' ? v.amount !== 0 : v.amount > 0), {
    message: 'amount',
  })
  // The database enforces this too — stated twice on purpose, because the
  // screen must be able to say which field is wrong.
  .refine((v) => CASH_TYPES.includes(v.type) === Boolean(v.accountId), {
    message: 'account',
  });
export type PartnerTxInput = z.infer<typeof partnerTxSchema>;

/**
 * One row on a partner's account. FX is frozen at entry (#108): a rate
 * corrected next month must not silently rewrite a settled debt.
 */
export async function addPartnerTx(input: PartnerTxInput, ctx: AuditContext) {
  if (!ctx.actorId) throw new PartnerError('unauthenticated');
  if (!MANUAL_TX_TYPES.includes(input.type)) {
    throw new PartnerError(input.type === 'charge' ? 'charge_via_cost' : 'offset_via_settlement');
  }
  // #995's rule (U21): a payment dated next month moved a till today.
  if (input.txDate > latestTxDate()) throw new PartnerError('future_date');
  // A named cash box must speak the row's currency (the ledger rule).
  if (input.accountId) {
    const [account] = await db
      .select({ currency: moneyAccounts.currency })
      .from(moneyAccounts)
      .where(eq(moneyAccounts.id, input.accountId));
    if (account && account.currency !== input.currency) {
      throw new PartnerError('account_currency_mismatch');
    }
  }
  const rate = await rateFor(input.currency, input.txDate);
  if (rate === null) throw new PartnerError('fx_missing');
  const amountUsd = Math.round(input.amount * rate * 100) / 100;
  if (exceedsRowUsd(amountUsd)) throw new PartnerError('amount_too_large');

  const [row] = await db
    .insert(partnerTransactions)
    .values({
      partnerId: input.partnerId,
      type: input.type,
      amount: String(input.amount),
      currency: input.currency,
      rateToUsd: String(rate),
      amountUsd: String(amountUsd),
      txDate: input.txDate,
      accountId: input.accountId || null,
      batchId: input.batchId || null,
      note: input.note || null,
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'partner_transaction',
    entityId: row!.id,
    action: 'create',
    after: {
      partnerId: input.partnerId,
      type: input.type,
      amount: input.amount,
      currency: input.currency,
      amountUsd,
    },
  });
  return row!;
}

/**
 * Which account a ledger row sits on, and which kassa it moved — read from
 * the ROW, so a door that voids by transaction id judges what the row really
 * is and never the `partnerId` the form carried beside it. Null when there is
 * no such row.
 */
export async function partnerTxDoorFacts(txId: string): Promise<{
  partnerId: string;
  accountId: string | null;
  costEntryId: string | null;
  expenseId: string | null;
  costEnteredBy: string | null;
} | null> {
  const [row] = await db
    .select({
      partnerId: partnerTransactions.partnerId,
      accountId: partnerTransactions.accountId,
      costEntryId: partnerTransactions.costEntryId,
      expenseId: partnerTransactions.expenseId,
      costEnteredBy: costEntries.enteredBy,
    })
    .from(partnerTransactions)
    .leftJoin(costEntries, eq(costEntries.id, partnerTransactions.costEntryId))
    .where(eq(partnerTransactions.id, txId))
    .limit(1);
  return row ?? null;
}

/**
 * Has this firm's account MOVED since a cost named it as the payer? (U34,
 * owner's answer B, 2026-09-25)
 *
 * The person who typed a firm-paid cost may cancel their own typo until the
 * firm's account has been touched after it; from then on the void would
 * reopen money that has already been settled against (a paid firm then reads
 * as owing US), so it is the accountant's and the admin's. «Touched» is a
 * LIVE row that moves or settles the balance — a payment, a receipt, an
 * offset (the settlement's firm leg) or an adjust — written AFTER the cost's
 * own charge (or the cost itself, when an old one has no charge). A later
 * CHARGE is another debt, not a settlement, and does not count. Compared on
 * `created_at`, never `tx_date`: a date can be typed into the past.
 */
export async function firmMovedSinceCost(costEntryId: string, partnerId: string): Promise<boolean> {
  const [row] = await db.execute<{ moved: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM partner_transactions later
       WHERE later.partner_id = ${partnerId}::uuid
         AND later.voided_at IS NULL
         AND later.type IN ('payment', 'receipt', 'offset', 'adjust')
         AND later.created_at > coalesce(
               (SELECT min(charge.created_at) FROM partner_transactions charge
                 WHERE charge.cost_entry_id = ${costEntryId}::uuid AND charge.voided_at IS NULL),
               (SELECT entry.created_at FROM cost_entries entry WHERE entry.id = ${costEntryId}::uuid))
    ) AS moved
  `);
  return row?.moved === true;
}

export type FirmDebtVoidRefusal = 'forbidden' | 'partner_cost_not_yours' | 'partner_cost_settled';

/**
 * Who may cancel a debt a cost or an expense WROTE onto a firm's account —
 * ONE answer for both doors that do it (#513): the cost's own ✕ (voiding the
 * cost voids its charge) and the ✕ on the counterparty card (voiding the
 * charge unlinks the cost's payer). Owner's answer B (U34): the accountant
 * and the admin always; the person who typed the cost while the firm's
 * account has not moved since it; an EXPENSE's debt only the accountant and
 * the admin — nothing but the expense book writes one. The card's ✕ used to
 * ask none of this, so the VED (who holds `finance.manage`) could make a
 * paid firm owe us from a door the cost rule never saw (review of wc).
 */
export async function firmDebtVoidRefusal(
  actor: { id: string; permissions: ReadonlySet<string> },
  debt: { partnerId: string; costEntryId: string | null; expenseId: string | null; costEnteredBy: string | null },
): Promise<FirmDebtVoidRefusal | null> {
  if (mayPickTill(actor.permissions)) return null;
  if (debt.expenseId) return 'forbidden';
  if (!debt.costEntryId) return null;
  if (debt.costEnteredBy !== actor.id) return 'partner_cost_not_yours';
  return (await firmMovedSinceCost(debt.costEntryId, debt.partnerId)) ? 'partner_cost_settled' : null;
}

export async function voidPartnerTx(id: string, reason: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new PartnerError('unauthenticated');
  const row = await db.query.partnerTransactions.findFirst({
    where: eq(partnerTransactions.id, id),
  });
  if (!row) throw new PartnerError('not_found');
  if (row.voidedAt) throw new PartnerError('already_voided');
  // A recurring month paid THROUGH a firm (0106, M4). «The firm did not pay»
  // means the payment did not happen, and that is voided on the EXPENSE:
  // `voidExpense` takes this charge with it, re-opens a rasxod xabari, and
  // re-opens the month on the due list. Unlinking the payer here instead
  // left the month «paid» on a one-sided expense no kassa and no firm stood
  // behind. Refused, never voided in-line — that would bypass the expense
  // door's pair rules and its `finance.expenses` gate. On top of, not
  // instead of, `firmDebtVoidRefusal` at the action (who may cancel it).
  if (row.expenseId) {
    const [source] = await db
      .select({ recurringId: expenses.recurringId })
      .from(expenses)
      .where(eq(expenses.id, row.expenseId));
    if (source?.recurringId) throw new PartnerError('recurring_payment');
  }
  await db.transaction(async (tx) => {
    await tx
      .update(partnerTransactions)
      .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
      .where(eq(partnerTransactions.id, id));
    // A three-cornered settlement is ONE agreement with two halves. Voiding
    // the partner half while the client half still says "paid" would leave
    // the client's debt forgiven with nothing standing behind it.
    if (row.clientTxId) {
      await tx
        .update(clientTransactions)
        .set({ voidedAt: new Date(), voidedBy: ctx.actorId, voidReason: reason })
        .where(and(eq(clientTransactions.id, row.clientTxId), isNull(clientTransactions.voidedAt)));
    }
    // A charge DERIVED from a cost or an expense is the pair rule's other
    // direction. Voiding the debt says «this firm does not answer for this
    // money» — the cost stays a P&L fact, but it must lose its payer, or the
    // next recompute (any FX save, any batch departure) re-derives the charge
    // the accountant just cancelled, under the original enterer's name. The
    // void of the DEBT without this line was a void that undid itself.

    if (row.costEntryId) {
      await tx
        .update(costEntries)
        .set({ partnerId: null })
        .where(eq(costEntries.id, row.costEntryId));
    }
    if (row.expenseId) {
      await tx.update(expenses).set({ partnerId: null }).where(eq(expenses.id, row.expenseId));
    }
  });
  await writeAudit(db, ctx, {
    entityType: 'partner_transaction',
    entityId: id,
    action: 'void',
    after: {
      reason,
      clientTxId: row.clientTxId,
      // The record that the source fact lost its payer, and to whom it points.
      ...(row.costEntryId ? { unlinkedCostEntry: row.costEntryId } : {}),
      ...(row.expenseId ? { unlinkedExpense: row.expenseId } : {}),
    },
  });
}

/** USD balance of one partner. Positive = we owe them. */
export async function partnerBalanceUsd(partnerId: string): Promise<number> {
  const [row] = await db
    .select({ balance: balanceExpr() })
    .from(partnerTransactions)
    .where(
      and(eq(partnerTransactions.partnerId, partnerId), isNull(partnerTransactions.voidedAt)),
    );
  return Math.round(Number(row?.balance ?? 0) * 100) / 100;
}

function balanceExpr() {
  return sql<string>`coalesce(sum(${partnerSignedSql('amount_usd')}), 0)`;
}

/**
 * One account's balance per currency, native AND in dollars — the card's
 * «O'z valyutasida» line (0103): a firm paid ¥20,000 for ¥20,000 of trucks
 * reads «0 CNY» there even while a dollar residue waits to be closed.
 */
export async function partnerNativeBalances(
  partnerId: string,
): Promise<{ currency: string; native: number; usd: number }[]> {
  const rows = await db
    .select({
      currency: partnerTransactions.currency,
      native: sql<string>`coalesce(sum(${partnerSignedSql('amount')}), 0)`,
      usd: sql<string>`coalesce(sum(${partnerSignedSql('amount_usd')}), 0)`,
    })
    .from(partnerTransactions)
    .where(and(eq(partnerTransactions.partnerId, partnerId), isNull(partnerTransactions.voidedAt)))
    .groupBy(partnerTransactions.currency)
    .orderBy(partnerTransactions.currency);
  const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;
  return rows.map((row) => ({ currency: row.currency, native: cents(row.native), usd: cents(row.usd) }));
}

export interface PartnerRow {
  id: string;
  name: string;
  typeName: string;
  typeCode: string;
  clientId: string | null;
  clientCode: string | null;
  /** The login this account belongs to — set on a staff account (0101). */
  userId: string | null;
  staff: boolean;
  active: boolean;
  balanceUsd: number;
}

/** Everybody, with what we owe each — the «kimga qarzdormiz» screen. */
/**
 * The register's two totals, rounded per account the way `companyBalance`
 * rounds them, so both Balans lines can be checked on the page they link to
 * (audit A6). The page used to print only what we owe; «what firms owe US»
 * sat on the Balans and nowhere here.
 */
export function partnerTotals(rows: { balanceUsd: number }[]): { owedByUs: number; owedToUs: number } {
  let owedByUs = 0;
  let owedToUs = 0;
  for (const row of rows) {
    const value = Math.round(row.balanceUsd * 100) / 100;
    if (value > 0) owedByUs += value;
    else owedToUs += -value;
  }
  return { owedByUs: Math.round(owedByUs * 100) / 100, owedToUs: Math.round(owedToUs * 100) / 100 };
}

/**
 * `includeStaff` is REQUIRED (owner M3a): a staff account is shown only to
 * the accountant and the admin, and an optional flag fails OPEN — making it
 * required turned every caller into a compile error that had to decide.
 */
export async function listPartners(opts: {
  includeInactive?: boolean;
  includeStaff: boolean;
}): Promise<PartnerRow[]> {
  const rows = await db
    .select({
      id: partners.id,
      name: partners.name,
      typeName: partnerTypes.name,
      typeCode: partnerTypes.code,
      clientId: partners.clientId,
      clientCode: clients.clientCode,
      userId: partners.userId,
      staff: sql<boolean>`${staffPartnerSql()}`,
      active: partners.active,
      balance: sql<string>`coalesce((
        SELECT sum(${partnerSignedSql('amount_usd', 'pt')})
        FROM partner_transactions pt
        WHERE pt.partner_id = ${partners}.id AND pt.voided_at IS NULL), 0)`,
    })
    .from(partners)
    .innerJoin(partnerTypes, eq(partners.typeId, partnerTypes.id))
    .leftJoin(clients, eq(partners.clientId, clients.id))
    .where(
      and(
        opts.includeInactive ? undefined : eq(partners.active, true),
        opts.includeStaff ? undefined : sql`NOT ${staffPartnerSql()}`,
      ),
    )
    .orderBy(asc(partnerTypes.sortOrder), asc(partners.name));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    typeName: r.typeName,
    typeCode: r.typeCode,
    clientId: r.clientId,
    clientCode: r.clientCode,
    userId: r.userId,
    staff: r.staff === true,
    active: r.active,
    balanceUsd: Math.round(Number(r.balance) * 100) / 100,
  }));
}

/** One partner's account, newest first. */
export async function partnerLedger(partnerId: string, limit = 200) {
  return db
    .select({
      tx: partnerTransactions,
      accountName: moneyAccounts.name,
      batchCode: batches.code,
      authorName: users.fullName,
      /** A recurring month's payment (0106): voided on the expense, never here. */
      expenseRecurringId: expenses.recurringId,
    })
    .from(partnerTransactions)
    .leftJoin(moneyAccounts, eq(partnerTransactions.accountId, moneyAccounts.id))
    .leftJoin(batches, eq(partnerTransactions.batchId, batches.id))
    .leftJoin(users, eq(partnerTransactions.createdBy, users.id))
    .leftJoin(expenses, eq(partnerTransactions.expenseId, expenses.id))
    .where(eq(partnerTransactions.partnerId, partnerId))
    .orderBy(desc(partnerTransactions.txDate), desc(partnerTransactions.createdAt))
    .limit(limit);
}

export async function partnerById(id: string) {
  const [row] = await db
    .select({
      partner: partners,
      typeName: partnerTypes.name,
      typeCode: partnerTypes.code,
      clientCode: clients.clientCode,
      clientName: clients.name,
      staff: sql<boolean>`${staffPartnerSql()}`,
    })
    .from(partners)
    .innerJoin(partnerTypes, eq(partners.typeId, partnerTypes.id))
    .leftJoin(clients, eq(partners.clientId, clients.id))
    .where(eq(partners.id, id))
    .limit(1);
  return row ?? null;
}

export async function listPartnerTypes(includeInactive = false) {
  return db
    .select()
    .from(partnerTypes)
    .where(includeInactive ? undefined : eq(partnerTypes.active, true))
    .orderBy(asc(partnerTypes.sortOrder), asc(partnerTypes.name));
}

export { RAISING };
