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
  | 'balClientAdvances'
  | 'balUnplacedCostsLine'
  | 'balSellerCommissions'
  | 'balRecurringArrears';

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
  unplacedCostCount: number;
  unplacedCostUsd: number;
  /** Of the queue, what every kassa's count already holds — not in the net. */
  unplacedCostInCountCount: number;
  unplacedCostInCountUsd: number;
  sellerCommissionsUsd: number;
  /** Due, unpaid recurring months (0106) — their money and how many carry it. */
  recurringArrearsUsd: number;
  recurringArrearsCount: number;
}

/**
 * The queued cargo costs the Balans takes off (U02): the queue less what
 * every kassa's count already holds (the pair rule, #528). ONE reading for
 * the line, the Balans page's note and the dashboard's — the line has to be
 * what the net subtracted, or the bridge does not add up to the net.
 */
export function unplacedCostsTakenOff(balance: BalanceFigures): { count: number; usd: number } {
  return {
    count: balance.unplacedCostCount - balance.unplacedCostInCountCount,
    usd: Math.round((balance.unplacedCostUsd - balance.unplacedCostInCountUsd) * 100) / 100,
  };
}

export function balanceLines(balance: BalanceFigures, cashHref = '/accounting/accounts'): BalanceLine[] {
  const costsOut = unplacedCostsTakenOff(balance);
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
    // Cargo costs spent from a kassa nobody has named yet (U02): money gone,
    // so it leaves the net on the day it is SPENT — and leaves this line for
    // its kassa's on the day the accountant places it, the net unmoved. Not
    // the part every kassa's count already holds: that is in the cash above.
    ...(costsOut.count > 0
      ? [{ key: 'balUnplacedCostsLine', value: -costsOut.usd, tone: 'text-warn', href: '/accounting/xarajat-kassa' } as const]
      : []),
    // Commissions owed on jobs the client has paid for (U10): out of money
    // already in the tills, so a liability until the accountant pays them.
    ...(balance.sellerCommissionsUsd > 0
      ? [{ key: 'balSellerCommissions', value: -balance.sellerCommissionsUsd, tone: 'text-bad', href: '/upsale' } as const]
      : []),
    // Rent and salaries whose day has come and nobody has paid (owner's Q6,
    // 0106): nothing leaves a kassa by itself, so the money is still in the
    // drawer above — owed, the commissions' own noun, until «To'landi».
    ...(balance.recurringArrearsCount > 0
      ? [{ key: 'balRecurringArrears', value: -balance.recurringArrearsUsd, tone: 'text-bad', href: '/accounting/expenses#recurring' } as const]
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
