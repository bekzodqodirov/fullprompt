/**
 * The freight zone read off the seller's free-text city — a leaf with no
 * imports (docs/SAKKIZ-R2.md K1).
 *
 * It lived in `workspace.ts`, which still answers for it by re-export. It
 * moved because round 2 asks it from three places that must not drag the
 * whole workspace in — the bot's reply, the yolkira tariff answer and the
 * screen's hint — and because a rule with three readers needs one home
 * (#513) that a unit test can import on its own.
 */

/**
 * What the seller typed, in the one spelling the vocabularies are written in:
 * lower case, and every apostrophe gone — «Qashg‘ar», «Qashg'ar» and
 * «Qashgʻar» are one city, and a phone keyboard decides which of the four
 * marks it gets.
 */
function normalise(fromCity: string | null): string {
  return (fromCity ?? '').toLowerCase().replace(/[’ʻʼ‘`´']/g, '');
}

/**
 * A word that must stand on its own, not inside another one: «gz» is a
 * Guangzhou shorthand and also two letters of a lot of words, «иу» is Yiwu
 * and the end of a Russian syllable. `\b` is ASCII-only in a JS regex, so the
 * edges are «no letter here» in every script.
 */
const whole = (word: string) => new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, 'u');
/** A word that may run on («yiwuda», «Guangzhoudan») but must START a word. */
const starts = (word: string) => new RegExp(`(?<!\\p{L})${word}`, 'u');
/**
 * A word that may carry only the Uzbek case endings a seller writes on a
 * city («Ивудан», «Ивуга») and nothing else — for a stem that also begins
 * ordinary words: «иву» starts «Ивушкина» (a street), and `starts` read that
 * address as Yiwu (review P1-R5).
 */
const withCase = (word: string) => new RegExp(`(?<!\\p{L})${word}(?:дан|да|га|нинг|ни|даги)?(?!\\p{L})`, 'u');

type City = 'kashgar' | 'cn' | 'horgos';

/**
 * TIER 1, the cities (docs/SAKKIZ-R2.md §6.3). The spellings are the ones a
 * seller types on a phone — Latin, Uzbek and Russian Cyrillic, Chinese —
 * including the transliterations of «Guangzhou» nobody agrees on.
 */
const CITY_WORDS: Record<City, RegExp[]> = {
  kashgar: [/qashqar/, /qashgar/, /kashgar/, whole('kashi'), /кашгар/, /қашқар/, /қашғар/, /кашкар/, /喀什/],
  cn: [
    /yiwu/,
    /yivu/,
    starts('iwu'),
    starts('ivu'),
    withCase('иву'),
    whole('иу'),
    /义乌/,
    /guangzhou/,
    /guanchjou/,
    /guanjou/,
    /gonchjou/,
    /гуанчжоу/,
    /广州/,
    whole('yw'),
    whole('gz'),
  ],
  // «Khorgas», «Horgas», «Qorgas», «Хоргас» — the Kazakh side's own
  // spellings and the Uzbek one with its apostrophes gone (review P1-R5).
  horgos: [/horgos/, /khorgos/, /xorgos/, /horgas/, /khorgas/, /qorgas/, /хоргос/, /хоргас/, /коргас/, /қорғас/, /霍尔果斯/],
};

/**
 * TIER 2, the country — read only when no city answered. Anchored to the
 * start of a word (review P1-R5): bare, «china» read «Machinaga», «Chinaz»
 * (the town Chinoz) and «Indochina» as the China zone, and the guess prices
 * the reply. «China» is a whole word — English carries no case ending — while
 * the Uzbek and Russian stems run on («Xitoydan», «Китаю»). 中国 has no word
 * edges to anchor to.
 */
const COUNTRY_WORDS: RegExp[] = [starts('xitoy'), starts('хитой'), starts('кита[йяюе]'), whole('china'), /中国/];

/** Where the earliest of these patterns stands in the text, or -1. */
function firstAt(text: string, patterns: RegExp[]): number {
  let at = -1;
  for (const p of patterns) {
    const i = text.search(p);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  return at;
}

/**
 * The zone and HOW it was read — the city itself (tier 1) or only the
 * country (tier 2). Null when neither is in the text.
 *
 * - A China-zone city wins wherever it stands. His 21a keeps Yiwu and
 *   Guangzhou cargo on the China price whichever border the truck takes, so
 *   «Qashqar orqali Yiwu» and «Horgos (Yiwu yuki)» are both «cn».
 * - Between Kashgar and Horgos the LEFTMOST is the origin — the city a seller
 *   writes first is where the road starts.
 * - The country word counts only when no city did: «Китай, Кашгар» is the
 *   ordinary Russian address shape for Kashgar cargo, and folding «Китай»
 *   into the city tier would read it as the China zone.
 * - Any other Chinese city (Foshan, Shenzhen, Urumqi) is not guessed (⭐ of
 *   his Question 3): «Foshan» alone is null, and «Foshan, Xitoy» is cn only
 *   through the country word — the reply prints what it read, so a wrong
 *   guess is visible to the seller.
 */
export function zoneGuessOf(fromCity: string | null): { zone: string; tier: 1 | 2 } | null {
  const c = normalise(fromCity);
  if (!c) return null;
  if (firstAt(c, CITY_WORDS.cn) !== -1) return { zone: 'cn', tier: 1 };
  const kashgar = firstAt(c, CITY_WORDS.kashgar);
  const horgos = firstAt(c, CITY_WORDS.horgos);
  if (kashgar !== -1 && (horgos === -1 || kashgar < horgos)) return { zone: 'kashgar', tier: 1 };
  if (horgos !== -1) return { zone: 'horgos', tier: 1 };
  if (firstAt(c, COUNTRY_WORDS) !== -1) return { zone: 'cn', tier: 2 };
  return null;
}

/**
 * A pure pre-selection, never a decision.
 *
 * The zone is a 36-58 % difference in the freight price, and `from_city` is
 * free text a seller typed on a phone. So this offers an answer and the
 * picker demands one: the seal refuses `freight_zone_required` no matter what
 * the city says. The bot's reply prices with it only as a «taxmin», and the
 * guess is never stored (#770(b)).
 */
export function guessZone(fromCity: string | null): string | null {
  return zoneGuessOf(fromCity)?.zone ?? null;
}

/**
 * The hint the workspace shows — a guessed zone only when the tariff PRICES
 * it. «horgos» is guessable from a city the day he opens the warehouse and
 * priceable only once he types its rows (answer 22); a hint naming an
 * unpriced zone points at a picker option that does not exist.
 */
export function guessedZoneFor(fromCity: string | null, priced: readonly string[]): string | null {
  const g = guessZone(fromCity);
  return g !== null && priced.includes(g) ? g : null;
}
