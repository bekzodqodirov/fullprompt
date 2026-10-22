/**
 * The corpus cases that FAIL on the code as it stands — 373 when the corpus
 * was written (commit 6b5f472), one after the fourth fix round (2026-10-22):
 * each a reviewer's input the readers still get wrong. They run as `it.fails`: a fix
 * that makes one pass turns it RED here until its id leaves this list, so the
 * list can only shrink, and nothing on it is forgotten. Never add an id to
 * make a red case quiet — a case that newly fails is a regression.
 */
export const KNOWN_FAILING: ReadonlySet<string> = new Set([
  // «Мест: 45» — a carton word written as a FIELD before its number reads as
  // pieces in the kernel (units.ts parseGoodsLine); owed to the next round.
  'c0347',
]);
