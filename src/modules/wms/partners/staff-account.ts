import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  expenseRequests,
  partners,
  partnerTransactions,
  partnerTypes,
  users,
} from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { isUniqueViolation } from '../../platform/db/errors';
import { partnerBalanceUsd, partnerLedger, partnerSignedSql, raisesBalance, type PartnerTxType } from './service';

/**
 * A staff member's own account with the company (owner A1c/A2a/M1a).
 *
 * Two halves, one file, because both are keyed on a LOGIN and on nothing
 * else: the accountant opening the account the moment an own-pocket report
 * needs one, and the person reading it on /profile.
 */

export class StaffAccountError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/**
 * «Hodim kontragentini ochish» — the one-press mint behind «Kiritish» on an
 * own-pocket report whose reporter has no account yet.
 *
 * Idempotent by the LOGIN: a second press, another accountant's press, or a
 * race between the two all answer with the one row `partners_user_uniq`
 * allows — never a second account, because two accounts for one person would
 * each show half of what the company owes them. A login already tied to a
 * counterparty that is NOT a plain staff account (a transport firm, a client's
 * card) is refused instead of adopted: booking a colleague's taxi fare as a
 * debt to a trucking company is the wrong creditor, silently.
 */
export async function openStaffPartner(
  userId: string,
  ctx: AuditContext,
): Promise<{ id: string; created: boolean }> {
  if (!ctx.actorId) throw new StaffAccountError('unauthenticated');
  const existing = await linkedPartner(userId);
  if (existing) return adopt(existing);

  const [user, type] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }),
    db.query.partnerTypes.findFirst({ where: eq(partnerTypes.code, 'staff') }),
  ]);
  if (!user) throw new StaffAccountError('user_not_found');
  // Looked up by CODE, never by name: the name is the owner's to rename on
  // /admin/partner-types, the code is what the seed wrote.
  if (!type) throw new StaffAccountError('staff_type_missing');

  let row: { id: string } | undefined;
  try {
    [row] = await db
      .insert(partners)
      .values({
        name: user.fullName,
        typeId: type.id,
        userId,
        phone: user.phone,
        createdBy: ctx.actorId,
      })
      .returning({ id: partners.id });
  } catch (err) {
    // Two presses at once: the other one won the unique index — its row is
    // the answer, exactly as if this press had come second.
    if (!isUniqueViolation(err)) throw err;
    const winner = await linkedPartner(userId);
    if (!winner) throw err;
    return adopt(winner);
  }
  await writeAudit(db, ctx, {
    entityType: 'partner',
    entityId: row!.id,
    action: 'create',
    after: { name: user.fullName, typeCode: 'staff', userId, via: 'expense_request' },
  });
  return { id: row!.id, created: true };
}

async function linkedPartner(userId: string) {
  const [row] = await db
    .select({ id: partners.id, clientId: partners.clientId, typeCode: partnerTypes.code })
    .from(partners)
    .innerJoin(partnerTypes, eq(partners.typeId, partnerTypes.id))
    .where(eq(partners.userId, userId))
    .limit(1);
  return row ?? null;
}

function adopt(row: { id: string; clientId: string | null; typeCode: string }) {
  if (row.typeCode !== 'staff' || row.clientId) {
    throw new StaffAccountError('user_linked_elsewhere');
  }
  return { id: row.id, created: false };
}

/** The headline's three answers, in the employee's words on the screen. */
export type StaffHeadline = 'company_owes' | 'advance_left' | 'settled';

/**
 * Positive = the company owes the person (the partner ledger's own sign:
 * «what WE owe them»). Judged on the CENT the screen prints, so a residue of
 * $0.004 from FX rounding reads «yopilgan» and not «qarz: $0.00».
 */
export function staffHeadline(balanceUsd: number): StaffHeadline {
  const cents = Math.round(balanceUsd * 100);
  if (cents > 0) return 'company_owes';
  if (cents < 0) return 'advance_left';
  return 'settled';
}

export interface StaffAccountView {
  headline: StaffHeadline;
  /** Absolute dollars for the headline; the sign is the headline's word. */
  amountUsd: number;
  /**
   * Signed native sums per currency, same sign as the balance. A currency at
   * 0 in its own money but not in dollars stays (0103): only a pre-deploy
   * residue can be that, and without it the headline's dollars read wrong.
   */
  perCurrency: { currency: string; amount: number; usd: number }[];
  rows: {
    id: string;
    txDate: string;
    kind: PartnerTxType;
    amount: number;
    currency: string;
    raises: boolean;
  }[];
  /** Own-pocket reports nobody has entered yet — NOT a debt, and said so. */
  pending: { id: string; amount: string; currency: string; note: string; createdAt: Date }[];
}

/**
 * «Kompaniya bilan hisob-kitobim» on /profile (A2a). Keyed on the SESSION's
 * user id and nothing else — the caller passes `user.id` from
 * `getSessionUser`, never a parameter from the URL (#514): this is payroll,
 * and M3a shows it to its owner, the accountant and the admin only.
 *
 * Null when there is nothing to say — no account and no report waiting — so
 * the panel does not appear on the profile of somebody who has never spent a
 * som of their own.
 */
export async function staffAccountView(userId: string): Promise<StaffAccountView | null> {
  const [partner] = await db
    .select({ id: partners.id })
    .from(partners)
    .where(eq(partners.userId, userId))
    .limit(1);
  const pending = await db
    .select({
      id: expenseRequests.id,
      amount: expenseRequests.amount,
      currency: expenseRequests.currency,
      note: expenseRequests.note,
      createdAt: expenseRequests.createdAt,
    })
    .from(expenseRequests)
    .where(
      and(
        eq(expenseRequests.createdBy, userId),
        eq(expenseRequests.paidBySelf, true),
        // Open, or claimed with no expense behind it (a crash mid-Kiritish,
        // the queue's own ⚠ row): either way no debt has been written yet.
        or(
          eq(expenseRequests.status, 'open'),
          and(eq(expenseRequests.status, 'done'), isNull(expenseRequests.expenseId)),
        ),
      ),
    )
    .orderBy(desc(expenseRequests.createdAt))
    .limit(20);
  if (!partner && pending.length === 0) return null;

  let balanceUsd = 0;
  let perCurrency: StaffAccountView['perCurrency'] = [];
  let rows: StaffAccountView['rows'] = [];
  if (partner) {
    const [balance, sums, ledger] = await Promise.all([
      partnerBalanceUsd(partner.id),
      db
        .select({
          currency: partnerTransactions.currency,
          // The balance's own sign rule (`partnerSignedSql`), on the native
          // amount: an `adjust` carries its sign in the amount.
          amount: sql<string>`sum(${partnerSignedSql('amount')})`,
          usd: sql<string>`sum(${partnerSignedSql('amount_usd')})`,
        })
        .from(partnerTransactions)
        .where(
          and(eq(partnerTransactions.partnerId, partner.id), isNull(partnerTransactions.voidedAt)),
        )
        .groupBy(partnerTransactions.currency)
        .orderBy(partnerTransactions.currency),
      partnerLedger(partner.id, 40),
    ]);
    balanceUsd = balance;
    perCurrency = sums
      .map((row) => ({
        currency: row.currency,
        amount: Math.round(Number(row.amount) * 100) / 100,
        usd: Math.round(Number(row.usd) * 100) / 100,
      }))
      .filter((row) => row.amount !== 0 || row.usd !== 0);
    rows = ledger
      // A voided row is history the accountant keeps; to the person it is a
      // line that never happened, and it is not in the balance above either.
      // A kurs farqi row (0103) moves no money of theirs — noise to them.
      .filter(({ tx }) => !tx.voidedAt && tx.type !== 'fx_diff')
      .slice(0, 10)
      .map(({ tx }) => ({
        id: tx.id,
        txDate: tx.txDate,
        kind: tx.type as PartnerTxType,
        amount: Number(tx.amount),
        currency: tx.currency,
        raises: raisesBalance(tx.type, Number(tx.amountUsd)),
      }));
  }
  return {
    headline: staffHeadline(balanceUsd),
    amountUsd: Math.abs(Math.round(balanceUsd * 100) / 100),
    perCurrency,
    rows,
    pending,
  };
}
