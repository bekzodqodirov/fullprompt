/**
 * The tier words of a model designation — one home for #1468's rule
 * (docs/SAKKIZ-R3.md §8.1, re-check p3-16), MOVED verbatim out of
 * calc-intake.ts, where it was private. Two readers ask it: `otherName`, which
 * keeps two stalls' phone cases apart when the Excel and the model meet, and
 * the bot table's name address (wms/calc/line-address.ts), which must not
 * hand «iPhone 15 Pro 40 dona» to the «iPhone 15» row. Zero imports, so the
 * pure wms parser can read it without calc-intake.ts's staff-bot import.
 */

/**
 * The tier words of a model designation — «iPhone 15 Pro Max», «Galaxy S24
 * Ultra», «Redmi Note 13 Pro» — in either script, each counted only right
 * after a word with a digit or another tier word: before or apart from a model
 * number the same words describe («Pro hair dryer», «Plus size»), and a
 * translation drops them.
 */
export const TIER_WORDS: Readonly<Record<string, string>> = {
  pro: 'pro', max: 'max', plus: 'plus', ultra: 'ultra', lite: 'lite', se: 'se', fe: 'fe',
  про: 'pro', макс: 'max', плюс: 'plus', ультра: 'ultra', лайт: 'lite',
};

export function tierWords(key: string): Set<string> {
  const tiers = new Set<string>();
  let afterModel = false;
  for (const word of key.normalize('NFKC').toLowerCase().split(' ').filter(Boolean)) {
    const tier = TIER_WORDS[word.replace(/[^\p{L}]/gu, '')];
    if (tier !== undefined && afterModel) tiers.add(tier);
    else afterModel = /\d/u.test(word);
  }
  return tiers;
}
