/**
 * The corpus cases that FAIL on the code as it stands — 373 when the corpus
 * was written (commit 6b5f472), one after the fourth fix round (2026-10-22),
 * 135 once the round-4 probers' 134 regressions joined (c1894-c2027), none
 * after the fifth round read every one of them right (5c3b618, ca90c52,
 * a4f8815), then 65 once the round-5 probers' 65 regressions joined
 * (c2028-c2092: inputs 5e68eed read right and the round-5 rules read wrong,
 * each owed to the next round), and none again once the sixth round's three
 * packages (sheets, typed, collector) were merged: each a reviewer's input the
 * readers still get wrong. They run as `it.fails`: a fix that makes one pass
 * turns it RED here until its id leaves this list, so the list can only
 * shrink, and nothing on it is forgotten. Never add an id to make a red case
 * quiet — a case that newly fails is a regression.
 */
export const KNOWN_FAILING: ReadonlySet<string> = new Set([]);
