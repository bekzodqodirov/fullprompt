/**
 * Which of a client's charges are still OWED once the money he handed over is
 * applied — oldest charge first (0117; the client card's trips have walked it
 * this way since round 29, and the KPI's «paid cargo», the owner's 6b, reads
 * the same walk). Pure and zero-import: client-cargo.ts and the KPI call it
 * on rows they read themselves.
 *
 * Three kinds of credit, applied in this order:
 *
 *  1. A COMPENSATION names a prixod (0105): it is money taken off THAT cargo's
 *     price, so it settles the charges covering that receipt first, oldest
 *     first. Whatever is left of it is an ordinary credit. Without the
 *     targeting, his own example goes wrong: A $1000 unpaid, B $1000
 *     compensated — a general walk would settle A with B's compensation and
 *     call A's cargo paid.
 *  2. A DEFERRAL belongs to one DEAL (finance/service.ts `deferredPerDealSql`):
 *     the owner decided that deal's debt may wait, so it counts as collected
 *     against that deal's charges only, oldest first. The residue is
 *     discarded — a deferral is a decision, not money, and must never settle
 *     another job.
 *  3. Everything else (payments, less refunds and a kurs farqi's sign —
 *     `settlesUsd`, net of what step 1 already used) settles what remains,
 *     oldest first.
 *
 * «Oldest» is (tx_date, created_at, id) — the id breaks a tie so two runs over
 * the same rows can never disagree about which of two same-day charges is paid.
 *
 * NOT arAging's walk: that one ages ANY debit (a refund raises the debt and
 * ages from its own day) to answer «how old is what he owes»; this one asks
 * «which PRICE has been paid for», and only a charge is a price.
 */

export interface FifoCharge {
  id: string;
  /** `YYYY-MM-DD`. */
  txDate: string;
  createdAt: Date | string;
  amountUsd: number;
  dealId: string | null;
  /** The receipts this charge covers (the unpriced rule's `covers`) — only a compensation's targeting reads it. */
  coversReceipts?: string[];
}

export interface FifoCredits {
  /** Σ `settlesUsd` over the non-charge rows — compensations INCLUDED (step 1 takes back what it used). */
  generalUsd: number;
  compensations?: { receiptId: string; amountUsd: number }[];
  deferrals?: { dealId: string; owedUsd: number }[];
}

const ms = (value: Date | string) => (value instanceof Date ? value.getTime() : new Date(value).getTime());

/** Oldest first: tx_date, then created_at, then id. Exported for the tie test. */
export function fifoOrder(a: FifoCharge, b: FifoCharge): number {
  if (a.txDate !== b.txDate) return a.txDate < b.txDate ? -1 : 1;
  const at = ms(a.createdAt);
  const bt = ms(b.createdAt);
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** What is still owed on each charge, by id. */
export function settleCharges(charges: FifoCharge[], credits: FifoCredits): Map<string, number> {
  const ordered = [...charges].sort(fifoOrder);
  const owed = new Map<string, number>(ordered.map((c) => [c.id, Math.max(0, c.amountUsd)]));

  /** Apply `amount` to the charges `pick` admits, oldest first; returns what was used. */
  const apply = (amount: number, pick: (c: FifoCharge) => boolean): number => {
    let left = amount;
    for (const charge of ordered) {
      if (left <= 0) break;
      if (!pick(charge)) continue;
      const open = owed.get(charge.id)!;
      if (open <= 0) continue;
      const used = Math.min(left, open);
      owed.set(charge.id, open - used);
      left -= used;
    }
    return amount - left;
  };

  // 1. Compensations onto their own receipt's charges.
  let usedByCompensations = 0;
  for (const comp of credits.compensations ?? []) {
    if (!(comp.amountUsd > 0)) continue;
    usedByCompensations += apply(comp.amountUsd, (c) => (c.coversReceipts ?? []).includes(comp.receiptId));
  }
  // 2. Deferrals onto their own deal's charges; the residue is not money.
  for (const deferral of credits.deferrals ?? []) {
    if (!(deferral.owedUsd > 0)) continue;
    apply(deferral.owedUsd, (c) => c.dealId === deferral.dealId);
  }
  // 3. What is left of the money, oldest charge first.
  const general = credits.generalUsd - usedByCompensations;
  if (general > 0) apply(general, () => true);

  return owed;
}
