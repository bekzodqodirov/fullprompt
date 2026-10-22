/**
 * The corpus cases that FAIL on the code as it stands — 373 when the corpus
 * was written (commit 6b5f472), one after the fourth fix round (2026-10-22),
 * then 135 once the round-4 probers' 134 regressions joined (c1894-c2027:
 * inputs 6b5f472 read right and the round-4 rules read wrong, each owed to
 * the next round): each a reviewer's input the readers still get wrong. They
 * run as `it.fails`: a fix that makes one pass turns it RED here until its id
 * leaves this list, so the list can only shrink, and nothing on it is
 * forgotten. Never add an id to make a red case quiet — a case that newly
 * fails is a regression.
 */
export const KNOWN_FAILING: ReadonlySet<string> = new Set([
  // ── r4-probe collector ───────────────────────────────────────────────────
  // intakeClientLabel: HUG's lookbehind takes an apostrophe for a word
  // boundary — «Ra'no», «Sa'id», «Ma'no» lose their tail as a contact word.
  'c2000', 'c2001', 'c2002', 'c2003',
  // intakeClientLabel: HUG cuts a contact word that is part of the NAME
  // («Smart Mobile», «Магазин Телефон», «Phone Market»).
  'c2004', 'c2005', 'c2006', 'c2007', 'c2008', 'c2009',
  // intakeClientLabel: DIGIT_RUN starts on a digit, so «(90) …» leaves its «(».
  'c2010', 'c2011',
  // intakeClientLabel: CODE_LABEL misses «Код клиента», the line stays in the name.
  'c2012',
  // pickGoods: `goodsNameKeys` splits an unbracketed Han name into halves, so
  // different products meet through a colour, a size or «LED/USB/PVC».
  'c2013', 'c2014', 'c2015', 'c2016', 'c2017', 'c2018', 'c2019', 'c2020', 'c2021',
  'c2022', 'c2023',
]);
