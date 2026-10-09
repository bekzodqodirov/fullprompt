/**
 * The codes that MAY carry an excise (2026-10-09, his answer 2a) — a list for
 * a WARNING, never a law.
 *
 * Excise in Uzbekistan is set by the Tax Code's own schedule and its rates
 * move every year; this system holds no excise dictionary on purpose (an
 * excise is answered per JOB on the group's ⚙). What this list is for is the
 * one mistake nobody sees: a beer, cigarette, fuel or car job priced with no
 * excise at all because nobody thought to ask, whose VAT base then comes out
 * short by the excise too. A code here with excise UNANSWERED raises
 * `excise_unanswered`, recorded by the ✅ like every warning, never a blocker
 * — the VED answers «yo'q» and it is gone.
 *
 * Headings, matched as prefixes of the group's code: 2202 sweetened drinks,
 * 2203-2208 beer, wine, spirits, 2402-2404 tobacco and its successors, 2710
 * fuels and oils, 8703 cars, 8711 motorcycles. A heading missing here costs a
 * warning, never a number — the engine charges whatever the group says.
 */
export const EXCISE_MAY_APPLY: readonly string[] = [
  '2202',
  '2203',
  '2204',
  '2205',
  '2206',
  '2207',
  '2208',
  '2402',
  '2403',
  '2404',
  '2710',
  '8703',
  '8711',
];

/** Does this code fall under a heading that may carry an excise? */
export function exciseMayApply(code: string | null | undefined): boolean {
  const c = (code ?? '').replace(/\D/g, '');
  return c.length >= 4 && EXCISE_MAY_APPLY.some((h) => c.startsWith(h));
}

/**
 * «Answered» is either shape set (judge MR-12): `excise_pct = 0` is «aksiz
 * yo'q» and a specific amount is a specific excise; all three null is a
 * question nobody has answered yet.
 */
export function exciseAnswered(g: {
  excisePct: number | null;
  exciseSpecific: number | null;
}): boolean {
  return g.excisePct !== null || g.exciseSpecific !== null;
}

/**
 * The units a specific excise may be counted in on a group (judge S4).
 *
 * kg and the piece counts live on the row's own columns; a PAIR unit (litr,
 * m², juft, sm³) lives on the row's ONE measure pair, which the code's LAW
 * already owns when it pins one. So a pair unit is allowed only when it IS
 * the law's own pair — beer under 2203 (law per litr) excised per litr — and
 * a row can never need a second pair, which is the one thing the measure
 * pass (P3's chain) cannot hold. Refused in words otherwise.
 */
export function exciseUnitsFor(dutyUnit: string | null): string[] {
  const base = ['kg', 'dona', '1000_dona'];
  return dutyUnit === 'litr' || dutyUnit === 'm2' || dutyUnit === 'juft' || dutyUnit === 'sm3'
    ? [...base, dutyUnit]
    : base;
}
