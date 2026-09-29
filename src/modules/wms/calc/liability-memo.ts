/**
 * The sellers' commission liability for the NET's readers, remembered in
 * this process for a minute (3a, review defect 2).
 *
 * `upsaleLiability('net')` is a company-wide paid-cargo walk whose
 * candidates are every unpaid deal offer ever made, so its cost grows with
 * the company's history — and `companyBalance()` is read on EVERY render of
 * the Balans page, the dashboard's money section and the hero's net tile, and
 * by the AI's `company_balance` tool. One walk a minute serves all of them.
 *
 * - Keyed by nothing: the figure is the company's, the same for every reader
 *   (the net's readers are gated by their own doors before they ask).
 * - Concurrent callers share ONE in-flight promise — ten tabs opening the
 *   dashboard at nine o'clock start one walk, not ten.
 * - A rejected promise is not remembered: the next reader asks again.
 * - Every door in THIS process that changes the answer forgets it at once:
 *   the payout (`payUpsale`), the payout's void re-opening its offers
 *   (`reopenUpsaleForExpense`), recording an offer and releasing a
 *   below-floor one. A client's charge, payment or compensation, a seal or a
 *   correction also move the answer and deliberately do NOT forget it — up to
 *   60 s of staleness on the Balans line is accepted for those (a person who
 *   just pressed «To'lash» sees his own press at once; a payment typed on
 *   another screen reaches the line within a minute). Another process (the
 *   job worker, a second app container) keeps its own minute.
 *
 * Zero imports on purpose: the calc doors that forget it (workspace.ts) must
 * not import the upsale service, whose own imports reach back into them.
 */
export const LIABILITY_TTL_MS = 60_000;

let memo: { at: number; promise: Promise<unknown> } | null = null;

/** The remembered figure, or `load()` once for every caller of the next minute. */
export function rememberedLiability<T>(load: () => Promise<T>, now: number = Date.now()): Promise<T> {
  if (memo && now - memo.at < LIABILITY_TTL_MS) return memo.promise as Promise<T>;
  const entry = { at: now, promise: load() as Promise<unknown> };
  memo = entry;
  // A failure is the caller's to see and nobody's to be served again. Only
  // THIS entry is dropped — a newer one a forget-and-reload put in its place
  // must survive the old promise's failure.
  entry.promise.catch(() => {
    if (memo === entry) memo = null;
  });
  return entry.promise as Promise<T>;
}

/** Forget it — the next reader walks again. Called by every door that changes the answer. */
export function forgetUpsaleLiability(): void {
  memo = null;
}
