import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import uz from '../../../../messages/uz.json';
import { addDays, mondayOf, tashkentDay } from '../../platform/time/tashkent';
import { dashPeriod, type DashPeriod } from './dashboard-math';
import { clipText, groupDigits, roundKg, roundM3, usd } from '../../platform/telegram/format';
import { STAFF_TEXT_CAP } from '../../platform/notifications/staff-html';
import { remainderOf } from '../accounting/recurring-math';
import type { DuePart } from '../partners/terms';
import { factText, type AttentionFact, type AttentionKey, type FactFormat, type FactText } from './attention';

/**
 * The owner's evening summary as WORDS — pure: every figure arrives computed
 * by `owner-summary.ts` from the report functions the dashboard reads, and
 * this file only decides how the message reads on a phone.
 *
 * Uzbek, like every staff message the bot sends (the team writes Uzbek). The
 * attention rows are the dashboard's own sentences, read out of the uz BUNDLE
 * through next-intl's translator (judge 6) — the row on the screen and the
 * line in Telegram cannot be worded twice. Dates are `dd.MM` cut from the
 * string, never `Intl` month names (#678: Chromium has no Uzbek months).
 *
 * Money that has no rate is NAMED in its own currency with ⚠, never printed as
 * $0 (#86, U14, U24), and money in another currency is never converted.
 */

/** How many list lines a block prints before «… yana N ta». */
export const LIST_CAP = 8;
/** A name is cut here, in code points (`clipText`). */
export const NAME_MAX = 40;
/** An attention sentence is cut here — the bundle's longest is ~130. */
const SENTENCE_MAX = 300;
/** The weekly block looks this far ahead — the approved «keyingi 4 hafta». */
export const PAYMENTS_DAYS = 28;

export type SummaryWindowKey = 'bugun' | '7';

/**
 * Which window a moment belongs to — decided on TASHKENT's day (R5, #1063):
 * 19:30 UTC on a Monday is 00:30 on Tuesday here, a daily message. Monday is
 * the week's message, over the dashboard's own «7 kun» (Tuesday to Monday)
 * and its weekday is `mondayOf`'s, never `getUTCDay()` of an instant.
 */
export function summaryWindow(now: Date): { today: string; weekly: boolean; key: SummaryWindowKey; period: DashPeriod } {
  const today = tashkentDay(now);
  const weekly = mondayOf(today) === today;
  const key: SummaryWindowKey = weekly ? '7' : 'bugun';
  return { today, weekly, key, period: dashPeriod(key, today) };
}

/** `YYYY-MM-DD` → `dd.MM`, from the string (#678). */
export const ddmm = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

/** Money in its own currency: «CNY 5 000», «UZS 1 250 000.5» — never converted. */
export function ownMoney(currency: string, amount: number): string {
  if (currency === 'USD') return usd(amount);
  return `${currency} ${groupDigits(Math.round(amount * 100) / 100)}`;
}

/** Figures as Telegram prints them — the attention sentences' formats. */
export const TELEGRAM_FORMAT: FactFormat = {
  usd,
  m3: (value) => groupDigits(roundM3(value)),
  num: (value) => groupDigits(value),
};

const uzDashboard = createTranslator({
  locale: 'uz',
  messages: uz as unknown as AbstractIntlMessages,
  namespace: 'dashboard',
});

/** A fact's sentence in the uz bundle's words, cut to a length a phone can carry. */
export function attentionLine(fact: FactText & { suffix?: FactText | null }): string {
  const text = factText(fact, (key: AttentionKey, values) => uzDashboard(`att.${key}`, values), TELEGRAM_FORMAT);
  return clipText(text, SENTENCE_MAX);
}

// ---------------------------------------------------------------------------
// The weekly «kelgusi to'lovlar» — outflows only, each in its own money.
// ---------------------------------------------------------------------------

export interface DueItem {
  /** `YYYY-MM-DD`, or null for money owed now with no day of its own (the sellers' share). */
  date: string | null;
  label: string;
  amount: number;
  currency: string;
  overdue: boolean;
  /** Money with no rate yet — named in its own currency with ⚠, never $0 (#86). */
  unrated: boolean;
  /** «qisman to'langan», «arxivda» — said beside the figure, never folded into it. */
  note: string | null;
}

/** A recurring month as `recurringDue` answers it — the fields this reads. */
export interface DueRecurring {
  dueDate: string;
  amount: number;
  currency: string;
  cash: boolean;
  dueNow: boolean;
  templateActive: boolean;
  categoryName: string;
  employeeName: string | null;
  warehouseCode: string | null;
  paidParts: { amount: number; currency: string }[];
}

export interface DuePartner {
  name: string;
  active: boolean;
  open: DuePart[];
}

/**
 * A cost that names a dated firm as its payer and has NO dollars yet (its
 * currency had no rate that day). `chargeForCost` posts the firm's charge
 * only once the rate exists — a charge is frozen in dollars (R1) — so until
 * then this debt is on no partner ledger and `termStates` cannot see it.
 * `dueDate` = the cost's day + the firm's `pay_within_days`.
 */
export interface DueUnratedCost {
  name: string;
  active: boolean;
  currency: string;
  amount: number;
  dueDate: string;
}

export interface PaymentsDue {
  items: DueItem[];
  /** Every item AND the arrears, per currency in its own money — never one converted sum. */
  totals: { currency: string; amount: number }[];
}

/**
 * What must be paid out over the next `days` days, as a list.
 *
 * - Recurring months still AHEAD (due after today, within the window) —
 *   cash ones only (a book entry moves no kassa) of a live template. A month
 *   whose day has come is NOT listed: those are the Balans's arrears, printed
 *   once above the list (`arrearsLine`, the Balans's own cash count and
 *   dollars, book entries said apart — judge 5: two rules for one overdue
 *   rent in one message is the #513 defect), and only their money joins the
 *   totals. A part-paid month prints what is left
 *   (`remainderOf`); when that cannot be known (a part in another currency)
 *   it prints the whole amount and says «qisman».
 * - Counterparties' FIFO open debts with a due day: an overdue part and the
 *   coming part, each summed per firm. A due day of TODAY is coming, not
 *   overdue (`dueStateOf`'s own «strictly before today»), and the heading
 *   starts today so it stands under it. A retired firm we still owe is listed
 *   and says so (#428) — retiring is a menu decision, not a payment.
 * - A dated firm's costs that have no rate yet (`DueUnratedCost`): the same
 *   overdue/coming split, per firm AND currency, in the firm's own money with
 *   ⚠ — they cannot enter the FIFO walk without dollars, and leaving them out
 *   would tell the owner the firm is owed nothing.
 * - The sellers' commissions that are payable now (U10's uncapped figure).
 *
 * No inflow and no «net» line: a coming payment is a fact with a date, and
 * nothing in the books promises when a client will pay.
 */
export function paymentsDue(input: {
  today: string;
  days?: number;
  recurring: readonly DueRecurring[];
  partners: readonly DuePartner[];
  /** Required: a caller that forgets the unrated half prints a firm as owed nothing. */
  partnersUnrated: readonly DueUnratedCost[];
  upsale: { usd: number; count: number };
  arrears: { usd: number; unrated: readonly { currency: string; amount: number }[] } | null;
}): PaymentsDue {
  const today = input.today;
  const last = addDays(today, input.days ?? PAYMENTS_DAYS);
  const items: DueItem[] = [];

  for (const row of input.recurring) {
    if (!row.cash || !row.templateActive || row.dueNow) continue;
    if (row.dueDate > last) continue;
    const left = remainderOf({ amount: row.amount, currency: row.currency }, row.paidParts, row.currency);
    if (left !== null && left <= 0.004) continue;
    const who = [row.categoryName, row.employeeName, row.warehouseCode].filter(Boolean).join(' · ');
    items.push({
      date: row.dueDate,
      label: clipText(who, NAME_MAX),
      amount: left ?? row.amount,
      currency: row.currency,
      overdue: false,
      unrated: false,
      note: left === null ? 'qisman to‘langan' : null,
    });
  }

  for (const partner of input.partners) {
    const overdue = partner.open.filter((part) => part.dueDate < today);
    const coming = partner.open.filter((part) => part.dueDate >= today && part.dueDate <= last);
    const name = clipText(partner.name, NAME_MAX);
    const note = partner.active ? null : 'arxivda';
    const sum = (parts: DuePart[]) => Math.round(parts.reduce((acc, part) => acc + part.usd, 0) * 100) / 100;
    if (overdue.length > 0) {
      items.push({ date: overdue[0]!.dueDate, label: name, amount: sum(overdue), currency: 'USD', overdue: true, unrated: false, note });
    }
    if (coming.length > 0) {
      items.push({ date: coming[0]!.dueDate, label: name, amount: sum(coming), currency: 'USD', overdue: false, unrated: false, note });
    }
  }

  // The same split for the firms' costs that have no dollars yet, per firm
  // AND currency: yuan and so'm are never one figure.
  const unrated = new Map<string, DueItem>();
  for (const cost of input.partnersUnrated) {
    if (cost.dueDate > last) continue;
    const overdue = cost.dueDate < today;
    const key = JSON.stringify([cost.name, cost.active, cost.currency, overdue]);
    const item = unrated.get(key);
    if (item) {
      item.amount = Math.round((item.amount + cost.amount) * 100) / 100;
      if (cost.dueDate < item.date!) item.date = cost.dueDate;
      continue;
    }
    unrated.set(key, {
      date: cost.dueDate,
      label: clipText(cost.name, NAME_MAX),
      amount: Math.round(cost.amount * 100) / 100,
      currency: cost.currency,
      overdue,
      unrated: true,
      note: cost.active ? null : 'arxivda',
    });
  }
  items.push(...unrated.values());

  if (input.upsale.count > 0 && input.upsale.usd > 0.004) {
    items.push({
      date: null,
      label: `Sotuvchilar ulushi (${input.upsale.count} ta)`,
      amount: input.upsale.usd,
      currency: 'USD',
      overdue: false,
      unrated: false,
      note: null,
    });
  }

  // Overdue first (oldest first), then by day, then the undated.
  items.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.date === null || b.date === null) return a.date === null ? (b.date === null ? 0 : 1) : -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : a.label.localeCompare(b.label);
  });

  const totals = new Map<string, number>();
  const add = (currency: string, amount: number) =>
    totals.set(currency, Math.round(((totals.get(currency) ?? 0) + amount) * 100) / 100);
  for (const item of items) add(item.currency, item.amount);
  if (input.arrears) {
    if (input.arrears.usd > 0.004) add('USD', input.arrears.usd);
    for (const row of input.arrears.unrated) add(row.currency, row.amount);
  }
  return {
    items,
    totals: [...totals].map(([currency, amount]) => ({ currency, amount })).filter((row) => row.amount > 0.004)
      .sort((a, b) => (a.currency === 'USD' ? -1 : b.currency === 'USD' ? 1 : a.currency.localeCompare(b.currency))),
  };
}

// ---------------------------------------------------------------------------
// The message.
// ---------------------------------------------------------------------------

export interface SummaryFacts {
  /** Tashkent's today, and the window the figures cover. */
  day: string;
  weekly: boolean;
  from: string;
  to: string;
  /** «HH:MM» on Tashkent's clock — when the figures were read. */
  asOf: string;
  /** The P&L revenue over the window (`pnlParts(…).revenue`). */
  revenueUsd: number;
  /** `clientMoneyInPeriod(…).netCollected` — the homes' «Mijozlar to'lagan (sof)» (U26). */
  collectedUsd: number;
  /** The cash flow's own in/out over the window and the costs it could not count. */
  cash: {
    inUsd: number;
    outUsd: number;
    unconverted: { count: number; byCurrency: readonly { currency: string; amount: number }[] };
  };
  /** The tills now: dollars, how many, and what has no rate. */
  tills: { usd: number; count: number; unrated: readonly { currency: string; balance: number; count: number }[] };
  intake: { receipts: number; boxes: number; m3: number; kg: number };
  trucks: { departed: number; arrived: number; onRoad: number };
  /** Null for a reader the funnel's outcome gate refuses. */
  leads: { fresh: number; won: number; wonUsd: number; wonOther: number } | null;
  /** The ranked attention rows, top first — already the owner's own list. */
  attention: { total: number; top: readonly AttentionFact[] };
  /** Monday only. */
  weeklyBlock: {
    payments: PaymentsDue;
    /** The overdue recurring months, moved here from the attention list. */
    arrears: SummaryArrears | null;
    pendingSpend: {
      count: number;
      byCurrency: readonly { currency: string; amount: number }[];
      ownPocket: { count: number; byCurrency: readonly { currency: string; amount: number }[] };
    };
    receivableUsd: number;
  } | null;
  /** The dashboard over exactly this window (#513) — the drain lifts it into «↗️ Ochish». */
  link: string;
}

/**
 * The rent-and-salary months whose day has come and nobody has paid — the
 * Balans's own arrears (`recurringArrears`), in the payments block's words
 * (judge 5). The attention row counts every such month, book entries
 * (depreciation) included; under a PAYMENTS heading a month that moves no
 * money must not be counted as one to pay, so the three are said apart.
 */
export interface SummaryArrears {
  /** Cash months with a rate — `recurringArrearsCount`. */
  cashCount: number;
  /** What those months still owe, in dollars — `recurringArrearsUsd`. */
  usd: number;
  /** Cash months in a currency with no rate, in their own money — `recurringArrearsUnrated`. */
  unrated: readonly { currency: string; amount: number; count: number }[];
  /** Book entries: due, unpaid, and no kassa ever opens for them. */
  bookCount: number;
}

/** Is there anything in the arrears a kassa must pay? */
const arrearsPayable = (a: SummaryArrears | null) => a !== null && (a.cashCount > 0 || a.unrated.length > 0);

/** The arrears line: payable months first, their money, then what is not a payment. */
export function arrearsLine(a: SummaryArrears): string {
  const parts: string[] = [];
  if (a.cashCount > 0) parts.push(`${a.cashCount} ta — ${usd(a.usd)}`);
  if (a.unrated.length > 0) {
    parts.push(`kursi yo‘q: ${a.unrated.map((row) => `${ownMoney(row.currency, row.amount)} (${row.count} ta)`).join(' · ')}`);
  }
  if (a.bookCount > 0) parts.push(`+${a.bookCount} ta hisob yozuvi (pul chiqmaydi)`);
  return `⚠ Muddati o‘tgan doimiy xarajat: ${parts.join(' · ')}`;
}

/**
 * Nothing HAPPENED in the window: every flow figure is zero. Standing state —
 * the tills, the attention list, the trucks on the road — is the same
 * tomorrow and is not news, so it never sends a message by itself. On a
 * Monday a payment coming due is news, and sends one.
 */
export function summaryQuiet(f: SummaryFacts): boolean {
  const zero = (value: number) => Math.abs(value) < 0.005;
  const flows =
    zero(f.revenueUsd) &&
    zero(f.collectedUsd) &&
    zero(f.cash.inUsd) &&
    zero(f.cash.outUsd) &&
    f.cash.unconverted.count === 0 &&
    f.intake.receipts === 0 &&
    f.trucks.departed === 0 &&
    f.trucks.arrived === 0 &&
    (f.leads === null || (f.leads.fresh === 0 && f.leads.won === 0));
  if (!flows) return false;
  if (!f.weeklyBlock) return true;
  // A book entry alone is standing state, not a payment: it wakes nothing.
  return f.weeklyBlock.payments.items.length === 0 && !arrearsPayable(f.weeklyBlock.arrears);
}

const listOf = (lines: string[], cap = LIST_CAP) =>
  lines.length > cap ? [...lines.slice(0, cap), `… yana ${lines.length - cap} ta`] : lines;

const sums = (rows: readonly { currency: string; amount: number }[]) =>
  rows.map((row) => ownMoney(row.currency, row.amount)).join(' · ');

/**
 * The message. `quietLine` is the pull's: a person who pressed «📊 Holat» on a
 * quiet day gets the standing figures and one line saying nothing moved,
 * where the push would have stayed silent.
 */
export function ownerSummaryText(f: SummaryFacts, opts: { quietLine?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(
    f.weekly
      ? `📊 GSR — hafta xulosasi, ${ddmm(f.from)}–${ddmm(f.to)} (soat ${f.asOf})`
      : `📊 GSR — kun xulosasi, ${ddmm(f.day)} (soat ${f.asOf})`,
  );
  lines.push('');
  lines.push(`💰 Tushum (hisoblangan): ${usd(f.revenueUsd)}`);
  lines.push(`💵 Mijozlar to‘lagan (sof): ${usd(f.collectedUsd)}`);
  lines.push(`🏦 Kassa: kirim ${usd(f.cash.inUsd)} · chiqim ${usd(f.cash.outUsd)}`);
  if (f.cash.unconverted.count > 0) {
    lines.push(
      `   ⚠ ${f.cash.unconverted.count} ta xarajat kursi yo‘q (${sums(f.cash.unconverted.byCurrency)}) — chiqimga kirmagan`,
    );
  }
  lines.push(`💼 Kassalarda: ${usd(f.tills.usd)} · ${f.tills.count} kassa`);
  if (f.tills.unrated.length > 0) {
    const unrated = f.tills.unrated.map((row) => `${ownMoney(row.currency, row.balance)} (${row.count} kassa)`).join(' · ');
    lines.push(`   ⚠ kursi yo‘q: ${unrated} — jamiga kirmagan`);
  }
  lines.push(
    `📦 Prixod: ${f.intake.receipts} ta · ${groupDigits(f.intake.boxes)} karobka · ${groupDigits(roundM3(f.intake.m3))} m³ · ${groupDigits(roundKg(f.intake.kg))} kg`,
  );
  lines.push(`🚚 Jo‘nadi: ${f.trucks.departed} · Keldi: ${f.trucks.arrived} · Yo‘lda: ${f.trucks.onRoad}`);
  if (f.leads) {
    const other = f.leads.wonOther > 0 ? ` (+${f.leads.wonOther} boshqa valyutada)` : '';
    lines.push(`👥 Yangi lid: ${f.leads.fresh} · Yutildi: ${f.leads.won} · ${usd(f.leads.wonUsd)}${other}`);
  }

  if (f.attention.total > 0) {
    lines.push('');
    lines.push(`⚠️ E’tibor kerak (${f.attention.total}):`);
    for (const fact of f.attention.top) lines.push(`• ${attentionLine(fact)}`);
    if (f.attention.total > f.attention.top.length) {
      lines.push(`… yana ${f.attention.total - f.attention.top.length} ta — ekranda`);
    }
  }

  if (f.weeklyBlock) {
    const w = f.weeklyBlock;
    lines.push('');
    // From TODAY: a firm's part due today is listed as coming (it is not
    // overdue until tomorrow), so the heading must not start tomorrow.
    lines.push(`📅 Keyingi 4 hafta to‘lovlari (${ddmm(f.day)}–${ddmm(addDays(f.day, PAYMENTS_DAYS))}):`);
    if (w.arrears) lines.push(arrearsLine(w.arrears));
    const items = w.payments.items.map((item) => {
      const when = item.date ? `${item.overdue || item.unrated ? '⚠ ' : ''}${ddmm(item.date)} — ` : '';
      const notes = [item.overdue ? 'muddati o‘tgan' : null, item.unrated ? 'kursi yo‘q' : null, item.note].filter(Boolean);
      return `• ${when}${item.label}: ${ownMoney(item.currency, item.amount)}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    });
    if (items.length === 0 && !w.arrears) lines.push('• to‘lov yo‘q');
    lines.push(...listOf(items));
    if (w.payments.totals.length > 0) lines.push(`Jami: ${sums(w.payments.totals)}`);
    if (w.pendingSpend.count > 0) {
      lines.push(`🧾 Chiqib ketgan, hali yozilmagan: ${w.pendingSpend.count} ta — ${sums(w.pendingSpend.byCurrency)}`);
      if (w.pendingSpend.ownPocket.count > 0) {
        lines.push(
          `   shundan ${w.pendingSpend.ownPocket.count} tasi hodimning o‘z pulidan: ${sums(w.pendingSpend.ownPocket.byCurrency)}`,
        );
      }
    }
    lines.push(`💳 Mijozlar qarzi (muddatsiz): ${usd(w.receivableUsd)}`);
  }

  if (opts.quietLine) {
    lines.push('');
    lines.push('Hali harakat yo‘q.');
  }

  return withLink(lines.join('\n'), f.link);
}

/**
 * The body and the link on its own last line, the whole within the staff cap.
 *
 * The shapes above are bounded by construction (lists capped at eight, names
 * and sentences clipped), so this cut should never bite; it exists so the
 * bound is a property of the function and not of today's data. It measures
 * UTF-16 units like the drain's cap (`STAFF_TEXT_CAP`), never halves an emoji,
 * and keeps the LINK — the one line the drain turns into «↗️ Ochish».
 */
function withLink(body: string, link: string): string {
  const room = STAFF_TEXT_CAP - link.length - 3;
  let text = body.replace(/\s+$/, '');
  if (text.length > room) {
    text = text.slice(0, room);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    text = `${text}…`;
  }
  return `${text}\n\n${link}`;
}
