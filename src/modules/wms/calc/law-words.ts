import { UNIT_WORD_KEYS, unitLabel, type UnitWordKey, type UnitWords } from './units';
import type { DutyMode } from './pricing';

/**
 * The law, the excise and the declaration fee as a person reads them — the
 * VALUES the `calc.law.*` sentences are filled with (2026-10-09, P2.1/P2.6/
 * P2.7). One home for the three readers that print a law in words: the block
 * footer, its ⚙ fold and the sealed sheet (#513).
 *
 * Pure, and it builds no sentence of its own: the words live in the four
 * bundles, the numbers are formatted here, so a translation can never move a
 * figure and a figure's format is never spelt twice.
 */

/** Literal keys (#163): a runtime `t(\`law.${mode}\`)` is invisible to the
 * i18n fence and throws at render in all four locales. */
export const LAW_SHAPE_KEY = {
  advalor: 'law.advalor',
  specific: 'law.specific',
  max: 'law.max',
  plus: 'law.plus',
} as const satisfies Record<DutyMode, `law.${DutyMode}`>;

/** A rate as it is written — no trailing zeros, at most four decimals, a DOT
 * for the decimal (the house rule, `ambiguous.hint`). */
export const rateText = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : String(Number(n.toFixed(4)));

/** «412 000» — whole numbers grouped by three, the way the office writes
 * so'm; a fraction keeps its dot («12 650.5»). */
export function groupDigits(n: number): string {
  const [whole, frac] = String(Number(n.toFixed(2))).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** «2026-10-09» → «09.10.2026», the date the rate book is read on. */
export const dayText = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
};

/** The unit words out of the bundle's `calc.units.*` — one reader for every
 * screen that names a unit beside a law. */
export function unitWordsOf(say: (key: UnitWordKey) => string): UnitWords {
  return Object.fromEntries(UNIT_WORD_KEYS.map((k) => [k, say(k)])) as UnitWords;
}

/** The values of a law-shape sentence: `{pct}%, kamida ${amount}/{unit}`. */
export function lawValues(
  law: { dutyPct: number | null; dutySpecific: number | null; dutyUnit: string | null },
  words: UnitWords,
): { pct: string; amount: string; unit: string } {
  return {
    pct: rateText(law.dutyPct),
    amount: rateText(law.dutySpecific),
    unit: law.dutyUnit ? unitLabel(law.dutyUnit, words) : '—',
  };
}

/**
 * The fee's inputs, ready for `law.feeInputs` — «2.5 BHM × 412 000 so‘m ÷
 * 12 650 (kurs 09.10.2026) ≈ $81.42». Null when any input is missing (an
 * override, or a seal from before the receipt carried them): a sentence with
 * a hole in it reads as a broken figure.
 */
export function feeInputsValues(fee: {
  usd: number;
  bhm: number | null;
  bhmUzs: number | null;
  fxUzsPerUsd: number | null;
  fxDate: string | null;
}): { bhm: string; bhmUzs: string; rate: string; date: string; usd: string } | null {
  if (fee.bhm === null || fee.bhmUzs === null || fee.fxUzsPerUsd === null || fee.fxDate === null) return null;
  return {
    bhm: rateText(fee.bhm),
    bhmUzs: groupDigits(fee.bhmUzs),
    rate: groupDigits(fee.fxUzsPerUsd),
    date: dayText(fee.fxDate),
    usd: fee.usd.toFixed(2),
  };
}

/** What the re-read book moved on a correction, carried to the new request's
 * first load (P2.2) — the codes and the rows, nothing else. One spelling for
 * both recalc buttons (the sealed panel and the answered page). */
export function relawedQuery(r: { relawed?: string[]; remeasure?: number[] }): string {
  const q = new URLSearchParams();
  if (r.relawed && r.relawed.length > 0) q.set('relawed', r.relawed.join(','));
  if (r.remeasure && r.remeasure.length > 0) q.set('olchov', r.remeasure.join(','));
  const text = q.toString();
  return text ? `?${text}` : '';
}
