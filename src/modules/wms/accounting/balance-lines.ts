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
  | 'balUnpricedCargo'
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
  /** Spent on cargo whose price is not written yet (U03) — what the net added. */
  unpricedCargoUsd: number;
}

/**
 * Where two of the lines lead, REQUIRED: an optional href fell back to a
 * page some viewers bounce off. `cash` is the kassa list (or the Balans for
 * a reader who may not open it); `cargo` is the Balans's own notes card —
 * never /finance/narxsiz, which lists landed cargo only, scoped to the
 * viewer's clients and with no money, so it cannot confirm this figure.
 */
export interface BalanceHrefs {
  cash: string;
  cargo: string;
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

export function balanceLines(balance: BalanceFigures, hrefs: BalanceHrefs): BalanceLine[] {
  const costsOut = unplacedCostsTakenOff(balance);
  return [
    { key: 'balCash', value: balance.cashUsd, tone: 'text-ink-900', href: hrefs.cash },
    ...(balance.unplacedCount > 0
      ? [{ key: 'balUnplaced', value: balance.unplacedUsd, tone: 'text-warn', href: '/finance/reestr?joylanmagan=1' } as const]
      : []),
    { key: 'balReceivable', value: balance.receivableUsd, tone: 'text-good', href: '/finance' },
    // U03, the owner's Q16 A: the money we already spent carrying cargo whose
    // price is not written yet — «what they owe» followed by «what they will
    // owe once priced». The net added exactly this. `text-good` like every
    // other asset line: most of it is cargo on the road that nobody can price
    // before rastamojka, and a permanent orange line teaches the owner to
    // ignore orange — the risk colour is the notes card's handed-over part.
    ...(balance.unpricedCargoUsd > 0.004
      ? [{ key: 'balUnpricedCargo', value: balance.unpricedCargoUsd, tone: 'text-good', href: hrefs.cargo } as const]
      : []),
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

/**
 * What the Balans line «narxi hali yozilmagan yukka sarflangan» (U03) prints
 * beside its arithmetic — `companyBalance().unpricedCargo`'s shape, restated
 * structurally so this file stays pure.
 */
export interface UnpricedCargoNotes {
  grossUsd: number;
  cardUsd: number;
  elsewhereUsd: number;
  unclaimed: { usd: number };
  oldNoKassa: { count: number };
  tillUnrated: { count: number };
  noDebt: { count: number };
  pickupNoBox: { count: number };
  noBox: { count: number };
  unconverted: number;
  gate: 'on' | 'off' | 'invalid';
}

/**
 * How many notes the Balans's card prints besides the arithmetic — the
 * dashboard's one «ℹ️ … N ta izoh» line, so the owner learns the line has
 * explanations without the card being copied onto a second screen. The
 * dated ban sentence is always true and carries no figure, so it is not a
 * note; the ban being OFF (or unreadable) is.
 */
export function unpricedNotesCount(notes: UnpricedCargoNotes): number {
  return [
    notes.cardUsd > 0.004,
    notes.elsewhereUsd > 0.004,
    notes.unclaimed.usd > 0.004,
    notes.oldNoKassa.count > 0,
    notes.tillUnrated.count > 0,
    notes.noDebt.count > 0,
    notes.pickupNoBox.count > 0,
    notes.noBox.count > 0,
    notes.unconverted > 0,
    notes.gate !== 'on',
  ].filter(Boolean).length;
}

/** The Balans draws the card when the line has arithmetic to show or anything was left out. */
export function unpricedNotesDrawn(notes: UnpricedCargoNotes): boolean {
  return notes.grossUsd > 0.004 || unpricedNotesCount(notes) > 0;
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
