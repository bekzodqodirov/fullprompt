/**
 * ONE margin rule for every screen and file (#513, found by the 0105 design).
 * Revenue can be NEGATIVE now — a client or a month whose compensation for
 * lost cargo is larger than its prices — and the old truthiness guards
 * (`revenue ? profit / revenue : 0`) printed −$1,300 over −$500 as «+260 %».
 * A margin exists only over positive revenue; otherwise it is null and the
 * screens print «—». Zero imports: pages, reports and unit tests all read it.
 */
export const marginPct = (profit: number, revenue: number): number | null =>
  revenue > 0.009 ? Math.round((profit / revenue) * 1000) / 10 : null;
