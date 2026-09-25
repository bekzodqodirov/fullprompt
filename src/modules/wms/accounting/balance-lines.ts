/**
 * The Balans sheet's lines, said ONCE for the two screens that print it — the
 * Balans page and the dashboard's bridge chart (#513). Pure: it arranges the
 * figures `companyBalance()` already computed and adds none of its own, so a
 * correction to the balance moves both screens together.
 *
 * A line that is empty by nature (nothing waiting to be placed, no client
 * paid ahead) is left out rather than printed as $0.00 — a permanent zero is
 * a line nobody reads (A2).
 */
export type BalanceLineKey =
  | 'balCash'
  | 'balUnplaced'
  | 'balReceivable'
  | 'balPartnerReceivable'
  | 'balPayable'
  | 'balClientAdvances';

export interface BalanceLine {
  key: BalanceLineKey;
  /** Signed: + we hold or are owed, − we owe. */
  value: number;
  tone: 'text-ink-900' | 'text-warn' | 'text-good' | 'text-bad';
  href: string;
}

export interface BalanceFigures {
  cashUsd: number;
  unplacedUsd: number;
  unplacedCount: number;
  receivableUsd: number;
  partnerReceivableUsd: number;
  payableUsd: number;
  clientAdvancesUsd: number;
}

export function balanceLines(balance: BalanceFigures, cashHref = '/accounting/accounts'): BalanceLine[] {
  return [
    { key: 'balCash', value: balance.cashUsd, tone: 'text-ink-900', href: cashHref },
    ...(balance.unplacedCount > 0
      ? [{ key: 'balUnplaced', value: balance.unplacedUsd, tone: 'text-warn', href: '/finance/reestr?joylanmagan=1' } as const]
      : []),
    { key: 'balReceivable', value: balance.receivableUsd, tone: 'text-good', href: '/finance' },
    { key: 'balPartnerReceivable', value: balance.partnerReceivableUsd, tone: 'text-good', href: '/kontragentlar' },
    { key: 'balPayable', value: -balance.payableUsd, tone: 'text-bad', href: '/kontragentlar' },
    // Clients who paid ahead (R7a): a liability, on its own line — netting it
    // into «qarz» made the receivable disagree with the /finance total.
    ...(balance.clientAdvancesUsd > 0
      ? [{ key: 'balClientAdvances', value: -balance.clientAdvancesUsd, tone: 'text-bad', href: '/finance' } as const]
      : []),
  ];
}

/** Receivables by age, summed over the aging rows (the receivables page's Σ). */
export function agingTotals(rows: { balance: number; buckets: number[] }[]): { balance: number; buckets: number[] } {
  return rows.reduce(
    (acc, row) => {
      acc.balance += row.balance;
      row.buckets.forEach((value, index) => {
        acc.buckets[index] = (acc.buckets[index] ?? 0) + value;
      });
      return acc;
    },
    { balance: 0, buckets: [0, 0, 0, 0] as number[] },
  );
}
