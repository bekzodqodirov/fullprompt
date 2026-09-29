/**
 * Who /hodimlar lists — pure, so the rule is tested as a function and not as
 * a filter buried in a page (0120, the owner's 2b).
 *
 * `?hodim=<id>` is an explicit ask for ONE person and is answered whatever
 * their state — the admin page links here, and «Qayta faollashtirish» must be
 * reachable after the salary stops (the judges' A3/O3). Otherwise: everybody
 * active, plus a person who has left but is still OWED or still OWES — the due
 * list's set (`owedEmployeeIds`; null = that read failed, so nobody is
 * dropped), a KPI line this month, a payable or an overpayment, or (the KPI
 * reads ran out of budget) a stamped seller.
 */
export function visibleStaff<P extends { id: string; active: boolean }>(
  people: readonly P[],
  q: {
    hodim: string | null;
    owed: ReadonlySet<string> | null;
    kpiLineIds: ReadonlySet<string>;
    payables: ReadonlyMap<string, { payableUsd: number; overpaidUsd: number }>;
    kpiFailed: boolean;
    kpiSellers: ReadonlySet<string>;
  },
): P[] {
  if (q.hodim !== null) return people.filter((p) => p.id === q.hodim);
  return people.filter(
    (p) =>
      p.active ||
      q.owed === null ||
      q.owed.has(p.id) ||
      q.kpiLineIds.has(p.id) ||
      (q.payables.get(p.id)?.payableUsd ?? 0) > 0 ||
      (q.payables.get(p.id)?.overpaidUsd ?? 0) > 0 ||
      (q.kpiFailed && q.kpiSellers.has(p.id)),
  );
}

/**
 * «Ketganlar» — the way BACK for a person who never signs in and has dropped
 * off the list (0120's review, UI-2): once their last template is stopped and
 * settled, `visibleStaff` lets them go, and «Qayta faollashtirish» lives on
 * their own card. Without this fold the accountant's only road there was
 * retyping the name and reading the same-name warning. Only people the page
 * does NOT already draw; a login leaver is the admin's, on /admin/users.
 */
export function droppedLeavers<P extends { id: string; active: boolean; loginEnabled: boolean }>(
  people: readonly P[],
  shown: ReadonlySet<string>,
): P[] {
  return people.filter((p) => !p.active && !p.loginEnabled && !shown.has(p.id));
}
