import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../platform/db/client';
import { partners, partnerTransactions } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { tashkentDay } from '../../platform/time/tashkent';
import { partnerSignedSql } from './ledger-sign';
import { PartnerError } from './service';
import { dueStateOf, termAlerts, type DueState, type LedgerMove, type TermAlert } from './terms';

/**
 * The counterparty's payment terms on the database (0108): the card's own
 * small form, the state every screen reads, and the daily reminder.
 *
 * A form of its own and not two more fields on `savePartner`: that save is
 * replace-all, and a term a VED never saw would be wiped the first time they
 * fixed a typo in the firm's name (#171's shape).
 */
export const partnerTermsSchema = z.object({
  payWithinDays: z.union([z.literal(''), z.coerce.number().int().min(1).max(3650)]),
  debtLimitUsd: z.union([z.literal(''), z.coerce.number().positive().finite()]),
});

export async function setPartnerTerms(
  id: string,
  input: z.infer<typeof partnerTermsSchema>,
  ctx: AuditContext,
): Promise<void> {
  const before = await db.query.partners.findFirst({ where: eq(partners.id, id) });
  if (!before) throw new PartnerError('not_found');
  const values = {
    payWithinDays: input.payWithinDays === '' ? null : input.payWithinDays,
    debtLimitUsd: input.debtLimitUsd === '' ? null : input.debtLimitUsd.toFixed(2),
    // New terms, new reminders: a changed promise is announced afresh.
    dueSoonAlertedFor: null,
    overdueAlertedFor: null,
    limitAlertedAt: null,
  };
  await db.update(partners).set(values).where(eq(partners.id, id));
  await writeAudit(db, ctx, {
    entityType: 'partner',
    entityId: id,
    action: 'update',
    before: { payWithinDays: before.payWithinDays, debtLimitUsd: before.debtLimitUsd },
    after: { payWithinDays: values.payWithinDays, debtLimitUsd: values.debtLimitUsd },
  });
}

export interface TermState {
  payWithinDays: number | null;
  debtLimitUsd: number | null;
  balanceUsd: number;
  due: DueState;
  /** Share of the limit the debt has reached, when there is a limit. */
  limitPct: number | null;
}

/**
 * Every account with terms: ONE read of their ledgers (#432), grouped here.
 * `partnerIds` narrows it to a page's rows; absent = every account with terms.
 */
export async function termStates(partnerIds?: string[], today = tashkentDay()): Promise<Map<string, TermState>> {
  const out = new Map<string, TermState>();
  if (partnerIds && partnerIds.length === 0) return out;
  const accounts = await db
    .select({
      id: partners.id,
      payWithinDays: partners.payWithinDays,
      debtLimitUsd: partners.debtLimitUsd,
    })
    .from(partners)
    .where(
      and(
        or(isNotNull(partners.payWithinDays), isNotNull(partners.debtLimitUsd)),
        partnerIds ? inArray(partners.id, partnerIds) : undefined,
      ),
    );
  if (accounts.length === 0) return out;
  const moves = await db
    .select({
      partnerId: partnerTransactions.partnerId,
      date: sql<string>`${partnerTransactions.txDate}::text`,
      usd: sql<string>`${partnerSignedSql('amount_usd')}`,
    })
    .from(partnerTransactions)
    .where(
      and(
        inArray(
          partnerTransactions.partnerId,
          accounts.map((a) => a.id),
        ),
        isNull(partnerTransactions.voidedAt),
        // A row not yet converted has no dollars to count (it is named
        // elsewhere as unconverted); a NULL here would read as $0 paid.
        isNotNull(partnerTransactions.amountUsd),
      ),
    );
  const byPartner = new Map<string, LedgerMove[]>();
  for (const m of moves) {
    const list = byPartner.get(m.partnerId) ?? [];
    list.push({ date: m.date, usd: Number(m.usd) });
    byPartner.set(m.partnerId, list);
  }
  for (const a of accounts) {
    const list = byPartner.get(a.id) ?? [];
    const balanceUsd = Math.round(list.reduce((sum, m) => sum + m.usd, 0) * 100) / 100;
    const limit = a.debtLimitUsd === null ? null : Number(a.debtLimitUsd);
    out.set(a.id, {
      payWithinDays: a.payWithinDays,
      debtLimitUsd: limit,
      balanceUsd,
      due:
        a.payWithinDays === null
          ? { dueDate: null, dueUsd: 0, overdueUsd: 0 }
          : dueStateOf(list, a.payWithinDays, today),
      limitPct: limit ? Math.round((balanceUsd / limit) * 100) : null,
    });
  }
  return out;
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The reminder's words — the owner's and the accountant's Telegram. */
export function termAlertText(name: string, alert: TermAlert, link: string): string {
  const head =
    alert.kind === 'due_soon'
      ? `⏰ ${name}: ${alert.dueDate} gacha ${usd(alert.dueUsd)} to'lash kerak (${alert.days === 0 ? 'bugun' : `${alert.days} kun qoldi`}).`
      : alert.kind === 'overdue'
        ? `⚠️ ${name}: to'lov muddati o'tdi (${alert.dueDate}) — ${usd(alert.overdueUsd)} kechikkan.`
        : `💳 ${name}: qarzimiz ${usd(alert.balanceUsd)} — chegaraning ${alert.pct}% (${usd(alert.limitUsd)}).`;
  return `${head}\n${link}`;
}

/**
 * The daily sweep: each owed reminder once, to everyone who reads the
 * company's money (`finance.reports` — the owner and the accountant, his
 * «menga ham bugalterga ham»). Stamps are written whether or not anybody has
 * the type muted — they record «reported», like the silent-truck alarm — and
 * the limit stamp is cleared once the debt falls back below 80 %, so the next
 * crossing is a new report.
 */
export async function alertPartnerTerms(today = tashkentDay()): Promise<number> {
  const states = await termStates(undefined, today);
  if (states.size === 0) return 0;
  const rows = await db
    .select({
      id: partners.id,
      name: partners.name,
      active: partners.active,
      dueSoonAlertedFor: partners.dueSoonAlertedFor,
      overdueAlertedFor: partners.overdueAlertedFor,
      limitAlertedAt: partners.limitAlertedAt,
    })
    .from(partners)
    .where(inArray(partners.id, [...states.keys()]));
  const userIds = await usersWithPermission('finance.reports');
  const appUrl = process.env.APP_URL ?? '';
  let sent = 0;
  for (const row of rows) {
    if (!row.active) continue;
    const state = states.get(row.id)!;
    const alerts = termAlerts({
      due: state.due,
      balanceUsd: state.balanceUsd,
      payWithinDays: state.payWithinDays,
      debtLimitUsd: state.debtLimitUsd,
      today,
      dueSoonAlertedFor: row.dueSoonAlertedFor,
      overdueAlertedFor: row.overdueAlertedFor,
      limitAlerted: row.limitAlertedAt !== null,
    });
    for (const alert of alerts) {
      await notifyStaffTelegram({
        userIds,
        type: 'PartnerDebtDue',
        text: termAlertText(row.name, alert, `${appUrl}/kontragentlar/${row.id}`),
      });
      sent += 1;
    }
    const set: Partial<typeof partners.$inferInsert> = {};
    for (const alert of alerts) {
      if (alert.kind === 'due_soon') set.dueSoonAlertedFor = alert.dueDate;
      if (alert.kind === 'overdue') set.overdueAlertedFor = alert.dueDate;
      if (alert.kind === 'limit') set.limitAlertedAt = new Date();
    }
    if (
      row.limitAlertedAt !== null &&
      state.debtLimitUsd !== null &&
      state.balanceUsd < state.debtLimitUsd * 0.8
    ) {
      set.limitAlertedAt = null;
    }
    if (Object.keys(set).length > 0) await db.update(partners).set(set).where(eq(partners.id, row.id));
  }
  return sent;
}
