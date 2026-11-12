/**
 * The shape of a totals answer, and nothing else (docs/SAKKIZ-R3.md K6).
 *
 * Zero imports on purpose: wms's pure table parser reads these, and
 * calc-intake.ts — their old home — imports staff-bot, which is the whole
 * database. calc-intake.ts re-exports them, so no importer moved.
 */

/**
 * A totals answer that names no unit — the shape only the question it
 * answers can read («3500» after the brutto question). Digits with the
 * house's separators, nothing else. Pure.
 */
export function bareTotalsNumber(text: string): boolean {
  return /^\s*\d[\d\s.,'’ʼʻ]*\s*$/u.test(text);
}

/**
 * One figure of a totals answer: «3 500» grouped by thousands, else «1,2» /
 * «3500» — and, FIRST, the way a packing list writes a weight: «1,136.5»,
 * «12,500.00» (comma groups AND a decimal point), its mirror «1.136,5», and
 * «1'200» (docs/AI-SORAYDI.md §3.1 T14). Counted as two figures, a bare
 * «1,136.5» answering the brutto question was refused as «two numbers».
 * Zero imports here, so the grammar is restated — `tests/unit/
 * scaled-kilos.test.ts` holds it to `calc/units.ts` `AMOUNT_NUMBER`.
 */
export const TOTALS_NUMBER =
  /\d{1,3}(?:,\d{3})+\.\d+|\d{1,3}(?:\.\d{3})+,\d+|\d{1,3}(?:['’ʼʻ]\d{3})+(?:[.,]\d+)?|\d{1,3}(?:\s\d{3})+(?![\d.,])|\d+(?:[.,]\d+)?/gu;

/**
 * The words a totals answer may be written in — kilos, cubes, «brutto» — as
 * ONE global regex over a lower-cased text. The CALLER's: the vocabulary is
 * wms's (`calc/units.ts`, docs/AI-SORAYDI.md §2.4), this file imports
 * nothing, and the list it used to keep here was the third private one — it
 * knew «cbm» and «kgs» while the reader behind it did not, so «5.9 cbm» was
 * recognised as an answer and then refused. `calc/line-address.ts` builds it
 * (`TOTALS_UNIT_WORDS`). With none, no word is a unit: a worded answer is
 * then no totals answer at all, and only a BARE figure is told apart.
 */
export type TotalsUnitWords = RegExp;

/**
 * How many figures a totals answer holds — «3 500» and «1 200 000» are ONE
 * (grouped by thousands), «12 3500» is two (review P3-R7). A bare answer to
 * the kilos question that holds two is not one weight: the house reader kept
 * the last and the first (the cube, as often as not) was dropped in silence.
 * Pure.
 */
export function totalsFigureCount(text: string): number {
  return (text.match(TOTALS_NUMBER) ?? []).length;
}

/**
 * What an answer to the totals question can look like, and nothing else: at
 * most TWO figures, and the kg / kub / m³ words — «3500», «3 500 kg», «12 kub
 * 3500 kg».
 *
 * Asked by the staff tail when NO collection is live (judge concurrency-5):
 * the collection lives in memory until round 3, so a restart or the TTL
 * between the question and the answer loses it, and the orphaned «3500»
 * would otherwise fall to the paid assistant, which can say nothing about it.
 * A goods line («Kurtka 300 kg») or a code («GS777») is not this shape.
 *
 * Nor is a PHONE NUMBER (review P3-R1): the assistant finds a client, a lead
 * or a partner by its last nine digits, and the first version of this read
 * «+998 90 123 45 67» as a lost totals answer. Nine digits or more in all
 * (no shipment is 100 000 000 kg), or three figures that are not one
 * thousands-grouped number («123 45 67») — and it is not a total. A «+» is
 * no longer stripped as punctuation, so it is a word no unit matches. Pure.
 */
export function looksLikeTotalsAnswer(text: string, units: TotalsUnitWords | null = null): boolean {
  return totalsAnswerShape(text, units) !== null;
}

/**
 * …and WHICH totals answer it looks like (review REG-3): `worded` names a
 * unit («3500 kg», «12 kub»), `bare` is figures alone («777», «150»). Only a
 * worded one is evidence of a lost collection — a bare figure is as often a
 * code typed without its letters, and was told «to‘plam topilmadi» about a
 * collection that never existed (`[].every()` is true). Pure.
 */
export function totalsAnswerShape(text: string, units: TotalsUnitWords | null = null): 'worded' | 'bare' | null {
  // The unit words come out FIRST: «m3» and «м3» end in a digit, and counted
  // as a figure it made «12 m3» two numbers and a stray «m».
  let worded = false;
  const t = units
    ? text
        .trim()
        .toLowerCase()
        .replace(new RegExp(units.source, units.flags.includes('g') ? units.flags : `${units.flags}g`), () => {
          worded = true;
          return ' ';
        })
    : text.trim().toLowerCase();
  const digits = (t.match(/\d/gu) ?? []).length;
  if (digits === 0 || digits >= 9) return null;
  if (totalsFigureCount(t) > 2) return null;
  // Anything left beside the figures and their punctuation is another word.
  if (/[^\s.,;:]/u.test(t.replace(TOTALS_NUMBER, ' '))) return null;
  return worded ? 'worded' : 'bare';
}
