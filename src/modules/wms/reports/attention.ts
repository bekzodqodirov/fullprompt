import { mayReadBatches } from '../batches/read-door';
import type { CompanyMoneySight } from '../finance/scope';
import type { TrucksOnRoad } from '../tracking/on-road';
import type { taskPulse } from '../../platform/tasks/analytics';
import type { pendingApprovals } from '../issue/approvals';
import type { calcQueueCounts } from '../calc/service';
import type {
  loadAging,
  loadBalanceParts,
  loadCostMissing,
  loadGaps,
  loadRisk,
  loadTrips,
  loadUnbilled,
  loadUnclaimed,
} from './dashboard';
import { approvalCounts, tripKind, type AttentionItem } from './dashboard-math';

/**
 * «E'tibor kerak» as FACTS — the rows the dashboard's attention list draws,
 * built once here so the owner's evening Telegram (owner-summary.ts) reads the
 * same rows and not a second copy of them (#513). The bot cannot import from
 * `src/app`, which is where the list used to be assembled.
 *
 * A fact carries its message KEY under `dashboard.att`, its RAW figures and the
 * way each is to be printed — never a formatted string: the page formats with
 * the chart helpers, the bot with Telegram's, and the words are the bundle's on
 * both (the page through `getTranslations`, the bot through the uz bundle).
 * The key moves with the viewer: a viewer with no money sight gets the
 * `…NoMoney` sentence, never the money one with a hole in it.
 *
 * Money is gated by the TOKEN (round B, O6): every money source is read only
 * when the caller holds a `CompanyMoneySight`, which only `companyMoneySight`
 * can mint — so a surface cannot build the money rows by passing `true`.
 *
 * PURE at runtime (every import below the first is a type): the reads live in
 * `attention-sources.ts`, so the Telegram words (owner-summary-text.ts) can
 * import the sentences without importing a database.
 */

export const ATTENTION_KINDS = [
  'missing',
  'phantom',
  'lost',
  'negativeTills',
  'old90',
  'unbilled',
  'stuck',
  'unpriced',
  'unallocated',
  'costMissing',
  'unconverted',
  'manualCharges',
  'unplacedPayments',
  'unplacedCosts',
  'unratedTills',
  'undocumented',
  'unclaimed',
  'overdueTasks',
  'recurringDue',
  'approvals',
  'priceApprovals',
  'calcLate',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/**
 * Every sentence a fact may name, under `dashboard.att` — one list, so a test
 * holds each to all four bundles (a missing key throws at render, #163) and a
 * fact cannot name a key that is not on it.
 */
export const ATTENTION_KEYS = [
  'missing',
  'missingNoMoney',
  'phantom',
  'phantomNoMoney',
  'lost',
  'lostNoMoney',
  'undocumented',
  'stuck',
  'negativeTills',
  'unratedTills',
  'unplacedPayments',
  'unplacedCosts',
  'old90',
  'unbilled',
  'unpriced',
  'unpricedUnbatched',
  'unallocated',
  'unconverted',
  'manualCharges',
  'costMissing',
  'unclaimed',
  'overdueTasks',
  'recurringDue',
  'recurringDueNoUsd',
  'approvals',
  'approvalsNoMoney',
  'calcLate',
  'priceApprovals',
] as const;
export type AttentionKey = (typeof ATTENTION_KEYS)[number];

/**
 * A figure, and how it is printed. `n` is a bare number — the one ICU reads
 * as a count; `num` is a grouped count («1 234»), `usd` dollars, `m3` cubic
 * metres, `sums` a per-currency list in each currency's own money (never
 * converted, #86).
 */
export type FactValue =
  | { as: 'n'; v: number }
  | { as: 'num'; v: number }
  | { as: 'usd'; v: number }
  | { as: 'm3'; v: number }
  | { as: 'sums'; v: readonly { currency: string; amount: number }[] };

export interface FactText {
  key: AttentionKey;
  params: Record<string, FactValue>;
}

export interface AttentionFact extends AttentionItem<AttentionKind>, FactText {
  /** A second sentence joined with « — » (the unpriced row's unbatched revenue). */
  suffix: FactText | null;
  href: string;
}

/** How a surface prints each figure — the page's chart helpers or Telegram's. */
export interface FactFormat {
  usd: (value: number) => string;
  m3: (value: number) => string;
  num: (value: number) => string;
}

export function formatFactParams(params: Record<string, FactValue>, fmt: FactFormat): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    switch (value.as) {
      case 'n':
        out[name] = value.v;
        break;
      case 'num':
        out[name] = fmt.num(value.v);
        break;
      case 'usd':
        out[name] = fmt.usd(value.v);
        break;
      case 'm3':
        out[name] = fmt.m3(value.v);
        break;
      case 'sums':
        out[name] = value.v.map((row) => `${row.currency} ${fmt.num(row.amount)}`).join(', ');
        break;
    }
  }
  return out;
}

/** A fact's sentence, through the surface's own translator and formats. */
export function factText(
  fact: FactText & { suffix?: FactText | null },
  translate: (key: AttentionKey, values: Record<string, string | number>) => string,
  fmt: FactFormat,
): string {
  const base = translate(fact.key, formatFactParams(fact.params, fmt));
  return fact.suffix ? `${base} — ${translate(fact.suffix.key, formatFactParams(fact.suffix.params, fmt))}` : base;
}

/** What a viewer may be shown — each row is built only for somebody who may open its screen. */
export interface AttentionGates {
  /** Null for a viewer who may not read the company's money. */
  sight: CompanyMoneySight | null;
  cargo: boolean;
  allWh: boolean;
  canExpenses: boolean;
  canApprove: boolean;
  canCalc: boolean;
  /** Where the «no rate» rows link: the rates screen when the viewer may type one. */
  canFx: boolean;
  /** The cargo section's own condition for drawing the list the cost-missing row jumps to. */
  seesCostMissing: boolean;
}

/**
 * The gates, from the grants and the page's two facts about its scope: a
 * warehouse-scoped viewer (`scoped`) and a chosen warehouse (`company`) read no
 * company-wide cost-missing count, because that count takes no scope.
 */
export function attentionGates(
  permissions: { has(code: string): boolean },
  input: { sight: CompanyMoneySight | null; scoped: boolean; company: boolean },
): AttentionGates {
  const cargo = mayReadBatches(permissions);
  const allWh = permissions.has('reports.all_warehouses');
  return {
    sight: input.sight,
    cargo,
    allWh,
    canExpenses: permissions.has('finance.expenses'),
    canApprove: permissions.has('finance.debt_override'),
    canCalc: permissions.has('ved.docs'),
    canFx: permissions.has('costs.fx.manage'),
    seesCostMissing: allWh && !input.scoped && cargo && !input.company,
  };
}

export type BalanceParts = Awaited<ReturnType<typeof loadBalanceParts>>;

export interface AttentionSources {
  balance: BalanceParts | null;
  aging: Awaited<ReturnType<typeof loadAging>> | null;
  trips: Awaited<ReturnType<typeof loadTrips>> | null;
  gaps: Awaited<ReturnType<typeof loadGaps>> | null;
  unbilled: Awaited<ReturnType<typeof loadUnbilled>> | null;
  risk: Awaited<ReturnType<typeof loadRisk>> | null;
  trucks: TrucksOnRoad | null;
  unclaimed: Awaited<ReturnType<typeof loadUnclaimed>>;
  costMissing: Awaited<ReturnType<typeof loadCostMissing>> | null;
  tasks: Awaited<ReturnType<typeof taskPulse>> | null;
  approvals: Awaited<ReturnType<typeof pendingApprovals>> | null;
  calc: Awaited<ReturnType<typeof calcQueueCounts>> | null;
  /** Revenue on no truck — read only when an unpriced truck is listed. */
  unbatched: number | null;
}

/**
 * The priced-nothing trucks the unpriced row counts: arrived or later, not an
 * internal leg. Exported so the source reader asks the SAME question before it
 * pays for the second-stage read.
 */
export function unpricedTrips(trips: NonNullable<AttentionSources['trips']>) {
  return trips.filter(
    (row) => tripKind(row) === 'unpriced' && ['arrived', 'unloaded', 'closed'].includes(row.status),
  );
}

const n = (v: number): FactValue => ({ as: 'n', v });
const usdOf = (v: number): FactValue => ({ as: 'usd', v });
const m3Of = (v: number): FactValue => ({ as: 'm3', v });

/**
 * The rows, from the sources — no reads, so every surface that holds the same
 * sources builds the same rows. `w` names the twelve-month window the profit
 * links open over (the loaders' own window).
 */
export function attentionFacts(
  g: AttentionGates,
  s: AttentionSources,
  w: { m12Start: string; today: string },
): AttentionFact[] {
  const money = g.sight !== null;
  const facts: AttentionFact[] = [];
  const push = (fact: Omit<AttentionFact, 'suffix'> & { suffix?: FactText | null }) =>
    facts.push({ ...fact, suffix: fact.suffix ?? null });

  if (s.risk) {
    const risk = s.risk;
    push({
      kind: 'missing',
      level: 'bad',
      count: risk.missing.boxes,
      usd: money ? risk.missing.usd : null,
      key: money ? 'missing' : 'missingNoMoney',
      params: money
        ? { n: n(risk.missing.boxes), m3: m3Of(risk.missing.m3), usd: usdOf(risk.missing.usd) }
        : { n: n(risk.missing.boxes), m3: m3Of(risk.missing.m3) },
      href: '/transit',
    });
    push({
      kind: 'phantom',
      level: 'bad',
      count: risk.phantom.boxes,
      usd: money ? risk.phantom.usd : null,
      key: money ? 'phantom' : 'phantomNoMoney',
      params: money ? { n: n(risk.phantom.boxes), usd: usdOf(risk.phantom.usd) } : { n: n(risk.phantom.boxes) },
      href: '/reports/yuk-xavfi#phantom',
    });
    push({
      kind: 'lost',
      level: 'bad',
      count: risk.lost.boxes,
      usd: money ? risk.lost.usd : null,
      key: money ? 'lost' : 'lostNoMoney',
      params: money ? { n: n(risk.lost.boxes), usd: usdOf(risk.lost.usd) } : { n: n(risk.lost.boxes) },
      href: '/reports/yuk-xavfi#lost',
    });
    push({
      kind: 'undocumented',
      level: 'warn',
      count: risk.undocumented.boxes,
      key: 'undocumented',
      params: { n: n(risk.undocumented.boxes) },
      href: '/reports/yuk-xavfi#undocumented',
    });
  }
  if (s.trucks) {
    // The trucks card's own ranking (`STUCK_AT_GATE_DAYS`): the row and the
    // card cannot count a truck standing at the gate differently.
    const stuck = s.trucks.counts.stuck;
    push({ kind: 'stuck', level: 'warn', count: stuck, key: 'stuck', params: { n: n(stuck) }, href: '/transit' });
  }
  if (money && s.balance) {
    const balance = s.balance;
    // The Balans's own list (U14): one predicate for both screens.
    const negative = balance.negativeTills.length;
    push({
      kind: 'negativeTills',
      level: 'bad',
      count: negative,
      key: 'negativeTills',
      params: { n: n(negative) },
      href: g.canExpenses ? '/accounting/accounts' : '/accounting/balance',
    });
    // The Balans's own list (U14): an EMPTY till with no rate hides nothing.
    const unrated = balance.unratedTills.reduce((sum, row) => sum + row.count, 0);
    push({
      kind: 'unratedTills',
      level: 'warn',
      count: unrated,
      key: 'unratedTills',
      params: { n: n(unrated) },
      href: g.canFx ? '/admin/fx' : '/accounting/balance',
    });
    push({
      kind: 'unplacedPayments',
      level: 'warn',
      count: balance.unplacedCount,
      usd: balance.unplacedUsd,
      key: 'unplacedPayments',
      params: { n: n(balance.unplacedCount), usd: usdOf(balance.unplacedUsd) },
      href: '/finance/reestr?joylanmagan=1',
    });
    if (g.canExpenses) {
      push({
        kind: 'unplacedCosts',
        level: 'warn',
        count: balance.unplacedCostCount,
        usd: balance.unplacedCostUsd,
        key: 'unplacedCosts',
        params: { n: n(balance.unplacedCostCount), usd: usdOf(balance.unplacedCostUsd) },
        href: '/accounting/xarajat-kassa',
      });
    }
  }
  if (money && s.aging) {
    const old = s.aging.filter((row) => (row.buckets[3] ?? 0) > 0.009);
    const oldUsd = old.reduce((sum, row) => sum + (row.buckets[3] ?? 0), 0);
    push({
      kind: 'old90',
      level: 'bad',
      count: old.length,
      usd: oldUsd,
      key: 'old90',
      params: { usd: usdOf(oldUsd), n: n(old.length) },
      href: '/accounting/receivables',
    });
  }
  if (money && s.unbilled) {
    const boxes = s.unbilled.reduce((sum, row) => sum + row.boxes, 0);
    const volume = s.unbilled.reduce((sum, row) => sum + row.m3, 0);
    push({
      kind: 'unbilled',
      level: 'bad',
      count: s.unbilled.length,
      key: 'unbilled',
      params: { n: n(s.unbilled.length), boxes: { as: 'num', v: boxes }, m3: m3Of(volume) },
      href: '#narxsiz',
    });
  }
  if (money && s.trips) {
    const rows = unpricedTrips(s.trips);
    const cost = rows.reduce((sum, row) => sum + row.costUsd, 0);
    const unbatched = s.unbatched ?? 0;
    push({
      kind: 'unpriced',
      level: 'warn',
      count: rows.length,
      usd: cost,
      key: 'unpriced',
      params: { n: n(rows.length), usd: usdOf(cost) },
      suffix:
        rows.length > 0 && unbatched > 0.009
          ? { key: 'unpricedUnbatched', params: { usd: usdOf(unbatched) } }
          : null,
      href: `/accounting/profit?view=batch&from=${w.m12Start}&to=${w.today}`,
    });
    const unallocated = s.trips.filter((row) => row.unallocatedUsd > 0.009);
    const unallocatedUsd = unallocated.reduce((sum, row) => sum + row.unallocatedUsd, 0);
    push({
      kind: 'unallocated',
      level: 'warn',
      count: unallocated.length,
      usd: unallocatedUsd,
      key: 'unallocated',
      params: { n: n(unallocated.length), usd: usdOf(unallocatedUsd) },
      href: `/accounting/profit?view=batch&from=${w.m12Start}&to=${w.today}`,
    });
  }
  if (money && s.gaps) {
    push({
      kind: 'unconverted',
      level: 'warn',
      count: s.gaps.unconverted.count,
      key: 'unconverted',
      params: { n: n(s.gaps.unconverted.count), sums: { as: 'sums', v: s.gaps.unconverted.byCurrency } },
      href: g.canFx ? '/admin/fx' : `/accounting/pnl?from=${w.m12Start}&to=${w.today}`,
    });
    push({
      kind: 'manualCharges',
      level: 'warn',
      count: s.gaps.manualCharges.count,
      usd: s.gaps.manualCharges.usd,
      key: 'manualCharges',
      params: { n: n(s.gaps.manualCharges.count), usd: usdOf(s.gaps.manualCharges.usd) },
      href: '/kontragentlar',
    });
  }
  if (s.costMissing) {
    push({
      kind: 'costMissing',
      level: 'warn',
      count: s.costMissing.count,
      key: 'costMissing',
      params: { n: n(s.costMissing.count) },
      href: '#xarajatsiz',
    });
  }
  push({
    kind: 'unclaimed',
    level: 'warn',
    count: s.unclaimed.receipts,
    key: 'unclaimed',
    params: { receipts: n(s.unclaimed.receipts), boxes: n(s.unclaimed.boxes) },
    href: '/unclaimed',
  });
  if (s.tasks) {
    push({
      kind: 'overdueTasks',
      level: 'warn',
      count: s.tasks.overdue,
      key: 'overdueTasks',
      params: { n: n(s.tasks.overdue) },
      href: '/reports/vazifalar',
    });
  }
  // Rent and salaries whose day has come and nobody has paid (owner's Q6):
  // the Balans line's own figures, so this row, the home counter and the
  // subtracted line are one count (#513). Book entries count here and carry
  // no money — hence the total beside the Balans line's dollars.
  if (money && g.canExpenses && s.balance) {
    const balance = s.balance;
    // «N, $0» read as «owed nothing» (review): with no dollars the items are
    // book entries or a currency with no rate, and the words say so.
    const withUsd = balance.recurringArrearsUsd > 0.004;
    push({
      kind: 'recurringDue',
      level: 'warn',
      count: balance.recurringArrearsTotal,
      usd: balance.recurringArrearsUsd,
      key: withUsd ? 'recurringDue' : 'recurringDueNoUsd',
      params: withUsd
        ? { n: n(balance.recurringArrearsTotal), usd: usdOf(balance.recurringArrearsUsd) }
        : { n: n(balance.recurringArrearsTotal) },
      href: '/accounting/expenses#recurring',
    });
  }
  if (s.approvals) {
    // 0104: a request may ask about a debt, about cargo with no price, or
    // both — each sentence counts only the rows that ask its question, so a
    // price-only request never reads as «qarz bilan berishga ruxsat».
    const counts = approvalCounts(s.approvals);
    if (counts.debt.n > 0) {
      push({
        kind: 'approvals',
        level: 'warn',
        count: counts.debt.n,
        usd: money ? counts.debt.usd : null,
        key: money ? 'approvals' : 'approvalsNoMoney',
        params: money ? { n: n(counts.debt.n), usd: usdOf(counts.debt.usd) } : { n: n(counts.debt.n) },
        href: '/approvals',
      });
    }
    if (counts.price.n > 0) {
      push({
        kind: 'priceApprovals',
        level: 'warn',
        count: counts.price.n,
        key: 'priceApprovals',
        params: { n: n(counts.price.n) },
        href: '/approvals',
      });
    }
  }
  if (s.calc) {
    push({ kind: 'calcLate', level: 'warn', count: s.calc.late, key: 'calcLate', params: { n: n(s.calc.late) }, href: '/hisoblash' });
  }
  return facts;
}
