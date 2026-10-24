/**
 * Which language a customer is writing in — so the reply is in the same one.
 *
 * His 13 (2026-10-24): «fors va xtoycha ham gaplashaversin afgon eron
 * klientlarim bor», on top of the report's uz (Latin and Cyrillic), ru and en.
 * Six answers, and the first thing that decides between most of them is the
 * SCRIPT, which is a fact about the characters and not a guess: Han is
 * Chinese, Arabic script is Persian (his Afghan and Iranian customers — Dari
 * and Farsi share it and the model answers in the variant it was written to),
 * Cyrillic is Russian or Uzbek, Latin is Uzbek or English.
 *
 * Inside one script the words decide, and only words that cannot be the other
 * language's: «ў қ ғ ҳ» exist only in Uzbek Cyrillic, «oʻ gʻ» and a handful of
 * everyday Uzbek words only in Uzbek Latin. A text that settles nothing —
 * «ok», «👍», «GS777», a photo's empty caption — keeps the language the
 * conversation already had (`previous`), because the customer has not
 * switched; with no history it says it is unsure and the caller keeps its own
 * default.
 *
 * PURE: the policy's G5 asks the same function about the DRAFT, so «the reply
 * is in the customer's language» is one rule applied twice, not two rules.
 */

export const AGENT_LOCALES = ['uz', 'uz_cyrl', 'ru', 'en', 'fa', 'zh'] as const;
export type AgentLocale = (typeof AGENT_LOCALES)[number];

export type ScriptName = 'latin' | 'cyrillic' | 'arabic' | 'han' | 'none';

export interface LocaleGuess {
  locale: AgentLocale | null;
  /** True when the text itself decided; false when it fell back to `previous` or to nothing. */
  confident: boolean;
  script: ScriptName;
}

const HAN = /\p{Script=Han}/gu;
const ARABIC = /\p{Script=Arabic}/gu;
const CYRILLIC = /\p{Script=Cyrillic}/gu;
const LATIN = /\p{Script=Latin}/gu;

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

/** The script most of the letters are in; 'none' when there are no letters at all. */
export function dominantScript(text: string): ScriptName {
  const counts: [ScriptName, number][] = [
    ['han', count(text, HAN)],
    ['arabic', count(text, ARABIC)],
    ['cyrillic', count(text, CYRILLIC)],
    ['latin', count(text, LATIN)],
  ];
  // A Han character carries a word; a Latin letter carries a sound. Two
  // characters of Chinese in a line of pinyin or of a product code is a
  // Chinese sentence, so Han is weighted to compete with whole words.
  counts[0][1] *= 3;
  const [best] = counts.sort((a, b) => b[1] - a[1]);
  return best && best[1] > 0 ? best[0] : 'none';
}

/** Letters only Uzbek Cyrillic has. */
const UZ_CYRL_LETTERS = /[ўқғҳЎҚҒҲ]/u;
/** Everyday Uzbek Cyrillic words that are not Russian. */
const UZ_CYRL_WORDS = /(?:^|[^\p{L}])(?:ва|учун|керак|канча|қанча|рахмат|раҳмат|салом|ассалому|борми|нима|қачон|качон|юк|нарх|йўқ|йук|ха|хоп|бўлади|булади)(?=$|[^\p{L}])/iu;

/** The Uzbek Latin apostrophe letters, in every spelling a phone keyboard produces. */
const UZ_LATIN_LETTERS = /[og]['ʻʼ‘’`]/iu;
/** Everyday Uzbek Latin words that are not English. */
const UZ_LATIN_WORDS =
  /(?:^|[^\p{L}])(?:salom|assalomu|alaykum|rahmat|raxmat|qancha|kancha|nechpul|necha|kerak|bormi|yoq|yo'q|xop|hop|yuk|yukim|narx|narxi|qayerda|qachon|kachon|keldimi|ketdimi|bo'ladi|boladi|aka|opa|uka|iltimos|mumkinmi|qilib|berasiz|bering|kub|kubi|xitoydan|toshkentga)(?=$|[^\p{L}])/iu;
/** Everyday English words that are not Uzbek. */
const EN_WORDS =
  /(?:^|[^\p{L}])(?:hello|hi|the|is|are|what|how|much|price|cost|cargo|shipping|please|thanks|thank|when|where|my|your|can|you|need|delivery|from|to)(?=$|[^\p{L}])/iu;

/**
 * The customer's language, from what they just wrote.
 *
 * `previous` is the conversation's stored language: a message that settles
 * nothing keeps it, and so does a message in the same script that only
 * leans one way (a Russian-speaking customer who types «ок, спс» is still
 * Russian, and an Uzbek one who types «ok» is still Uzbek).
 */
export function detectLocale(text: string, previous: AgentLocale | null = null): LocaleGuess {
  const script = dominantScript(text);
  if (script === 'han') return { locale: 'zh', confident: true, script };
  if (script === 'arabic') return { locale: 'fa', confident: true, script };
  if (script === 'cyrillic') {
    if (UZ_CYRL_LETTERS.test(text) || UZ_CYRL_WORDS.test(text)) return { locale: 'uz_cyrl', confident: true, script };
    // Cyrillic with no Uzbek mark: Russian, unless the conversation is Uzbek
    // Cyrillic already and this line is too short to say otherwise.
    if (previous === 'uz_cyrl' && count(text, CYRILLIC) < 12) return { locale: previous, confident: false, script };
    return { locale: 'ru', confident: true, script };
  }
  if (script === 'latin') {
    const uz = UZ_LATIN_LETTERS.test(text) || UZ_LATIN_WORDS.test(text);
    const en = EN_WORDS.test(text);
    if (uz && !en) return { locale: 'uz', confident: true, script };
    if (en && !uz) return { locale: 'en', confident: true, script };
    // Both or neither: the conversation keeps its language — a Russian
    // customer's «ok» is still a Russian conversation; with no history,
    // Uzbek, the company's own language and the commoner customer.
    if (previous) return { locale: previous, confident: false, script };
    return { locale: uz ? 'uz' : null, confident: false, script };
  }
  return { locale: previous, confident: false, script };
}

/** The script a reply in this language must be written in — G5's half of the rule. */
export function scriptOf(locale: AgentLocale): Exclude<ScriptName, 'none'> {
  switch (locale) {
    case 'zh':
      return 'han';
    case 'fa':
      return 'arabic';
    case 'ru':
    case 'uz_cyrl':
      return 'cyrillic';
    case 'uz':
    case 'en':
      return 'latin';
  }
}
