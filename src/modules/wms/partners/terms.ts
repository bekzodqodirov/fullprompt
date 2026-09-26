/**
 * A counterparty's payment terms (0108, the owner's 8a): when the debt is due
 * and how close it is to the limit — pure, so the reminder sweep, the card
 * and the list read ONE answer and a test can pin it.
 *
 * «Har bir qarz yozilgandan keyin N kun ichida» is FIFO: what we paid closes
 * the OLDEST debt first, so the next due date is the date of the oldest debt
 * not yet covered, plus N days, for the part of it still open. A row that
 * lowers the account (payment, offset, a negative adjust or kurs farqi) is
 * money paid; a row that raises it is a debt.
 */
import { addDays } from '@/modules/platform/time/tashkent';

export const DUE_SOON_DAYS = 3;
export const LIMIT_WARN_SHARE = 0.8;

export interface LedgerMove {
  /** Tashkent day the row is dated, `YYYY-MM-DD`. */
  date: string;
  /** Signed dollars: + raises what WE owe, − lowers it (`partnerSignedSql`). */
  usd: number;
}

export interface DueState {
  /** The oldest open debt's due day, or null when nothing is owed. */
  dueDate: string | null;
  /** The open part of that oldest debt. */
  dueUsd: number;
  /** Everything whose due day has passed (strictly before `today`). */
  overdueUsd: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function dueStateOf(moves: LedgerMove[], payWithinDays: number, today: string): DueState {
  const sorted = [...moves].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let paid = sorted.filter((m) => m.usd < 0).reduce((sum, m) => sum - m.usd, 0);
  let dueDate: string | null = null;
  let dueUsd = 0;
  let overdueUsd = 0;
  for (const debt of sorted.filter((m) => m.usd > 0)) {
    const covered = Math.min(paid, debt.usd);
    paid -= covered;
    const open = cents(debt.usd - covered);
    if (open <= 0.009) continue;
    const due = addDays(debt.date, payWithinDays);
    if (dueDate === null) {
      dueDate = due;
      dueUsd = open;
    }
    if (due < today) overdueUsd = cents(overdueUsd + open);
  }
  return { dueDate, dueUsd, overdueUsd };
}

/** Whole days from `today` to `day` (negative once it has passed). */
export function daysUntil(day: string, today: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export type TermAlert =
  | { kind: 'due_soon'; dueDate: string; dueUsd: number; days: number }
  | { kind: 'overdue'; dueDate: string; overdueUsd: number }
  | { kind: 'limit'; balanceUsd: number; limitUsd: number; pct: number };

/**
 * Which reminders are owed now, each ONCE: a due date is announced three
 * days ahead and again when it passes, never twice for the same date; the
 * limit once per crossing of 80 % (the sweep clears the stamp below it).
 */
export function termAlerts(input: {
  due: DueState;
  balanceUsd: number;
  payWithinDays: number | null;
  debtLimitUsd: number | null;
  today: string;
  dueSoonAlertedFor: string | null;
  overdueAlertedFor: string | null;
  limitAlerted: boolean;
}): TermAlert[] {
  const out: TermAlert[] = [];
  const { due, today } = input;
  if (input.payWithinDays !== null && due.dueDate !== null) {
    const days = daysUntil(due.dueDate, today);
    if (days < 0) {
      if (input.overdueAlertedFor !== due.dueDate) {
        out.push({ kind: 'overdue', dueDate: due.dueDate, overdueUsd: due.overdueUsd });
      }
    } else if (days <= DUE_SOON_DAYS && input.dueSoonAlertedFor !== due.dueDate) {
      out.push({ kind: 'due_soon', dueDate: due.dueDate, dueUsd: due.dueUsd, days });
    }
  }
  if (
    input.debtLimitUsd !== null &&
    input.debtLimitUsd > 0 &&
    !input.limitAlerted &&
    input.balanceUsd >= input.debtLimitUsd * LIMIT_WARN_SHARE
  ) {
    out.push({
      kind: 'limit',
      balanceUsd: cents(input.balanceUsd),
      limitUsd: input.debtLimitUsd,
      pct: Math.round((input.balanceUsd / input.debtLimitUsd) * 100),
    });
  }
  return out;
}
