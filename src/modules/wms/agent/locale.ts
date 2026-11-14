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
  // A Han character carries a word; a Latin letter carries a sound. Two
  // characters of Chinese in a line of pinyin or of a product code is a
  // Chinese sentence, so Han is weighted to compete with whole words.
  const counts: [ScriptName, number][] = [
    ['han', count(text, HAN) * 3],
    ['arabic', count(text, ARABIC)],
    ['cyrillic', count(text, CYRILLIC)],
    ['latin', count(text, LATIN)],
  ];
  const [best] = counts.sort((a, b) => b[1] - a[1]);
  return best && best[1] > 0 ? best[0] : 'none';
}

/** Letters only Uzbek Cyrillic has. */
const UZ_CYRL_LETTERS = /[ўқғҳЎҚҒҲ]/u;
/** Everyday Uzbek Cyrillic words that are not Russian. */
const UZ_CYRL_WORDS = /(?:^|[^\p{L}])(?:ва|учун|керак|канча|қанча|борми|нима|қачон|качон|юк|нарх|йўқ|йук|бўлади|булади)(?=$|[^\p{L}])/iu;

/**
 * What makes a Cyrillic line RUSSIAN by its own words (0148 fix): the everyday words Uzbek does not have, and the
 * two letters its alphabet lacks. «Cyrillic with no Uzbek mark» is not Russian — it is how most Uzbek customers
 * type, on a Russian keyboard with «у» for «ў», «к» for «қ», «г» for «ғ», «х» for «ҳ»: «Кийим-кечак, Гуанчжоудан
 * жунатаман», «5 куб 800 кг», «Иву шахридан» carry no mark of either language. Loan words are no mark («груз»,
 * «доставка», «склад» are Uzbek speech too), and neither are «у», «да», «от», «мой», «из», «не» — each an Uzbek
 * word as well.
 */
const RU_LETTERS = /[ыщЫЩ]/u;
// …and the everyday Russian a request is made of (fix pass 3), now that «пожалуйста» and «здравствуйте» are greetings:
// «Отправьте фото груза сегодня, пожалуйста» is Russian by «отправьте» and «сегодня». And the trade's own words in
// the cases Uzbek does not decline them into (fix pass 4): «5 кубов», «3 куба», «вес груза», «Цена?» — «Здравствуйте!
// Груз из Гуанчжоу, 5 кубов, 800 кг. Цена?» carried no mark once the greeting was none, and an Uzbek reply went by
// itself. «Груз», «куб», «товар», «доставка» stay unmarked: an Uzbek says them too.
const RU_WORDS =
  /(?:^|[^\p{L}])(?:сколько|что|как|это|есть|для|или|если|можно|нужно|надо|хочу|можете|будет|стоит|когда|где|почему|уже|ещё|еще|меня|мне|вас|вам|нет|и|в|на|по|за|до|сегодня|завтра|вчера|сейчас|потом|тогда|тоже|очень|только|здесь|напишите|скиньте|отправьте|пришлите|подскажите|скажите|который|которая|которые|кубов|куба|кубы|кубах|кубами|груза|грузов|грузы|грузом|товара|товаров|товары|цена|цену|цены|ценой|вес|веса|весом|стоимость|стоимости|объём|объем|объёма|объема|доставку|доставки|килограмм|килограммов)(?=$|[^\p{L}])/iu;

/**
 * The greetings, thanks and «yes» every customer here says in BOTH languages (fix pass 3): «Ассалому алайкум»,
 * «салом», «рахмат», «хоп», «ха» from a Russian speaker, «Здравствуйте», «Привет», «спасибо», «пожалуйста» from an
 * Uzbek one. The run reads the customer's whole burst (0148 fix), and one such word ON TOP of a question in the other
 * language decided «confidently» — «Ассалому алайкум» / «Сколько стоит доставка…?» refused the Russian reply,
 * «Здравствуйте» / «Кийим-кечак, Гуанчжоудан жунатаман» the Uzbek one. So a greeting is no MARK of either language:
 * it says its language only of a text that is nothing else, with no conversation of the same script to keep.
 */
const CYRL_GREETING_UZ = /(?<![\p{L}])(?:ассалому|ассалом|алайкум|алейкум|салом|рахмат|раҳмат|хоп|ха)(?![\p{L}])/giu;
const CYRL_GREETING_RU = /(?<![\p{L}])(?:здравствуйте|здравствуй|привет|добрый|доброе|спасибо|пожалуйста)(?![\p{L}])/giu;
const LATIN_GREETING_UZ = /(?<![\p{L}])(?:assalomu|assalom|alaykum|aleykum|salom|rahmat|raxmat|xop|hop)(?![\p{L}])/giu;
const LATIN_GREETING_EN = /(?<![\p{L}])(?:hello|hi|hey|thanks|thank)(?![\p{L}])/giu;
/** Fewer letters than this left when the greetings are out: the text was a greeting, and the greeting may speak. */
const GREETING_ONLY = 6;

/** A line of fewer letters than this cannot turn an Uzbek conversation into another language's. */
const SHORT_LINE = 12;

/** The Uzbek Latin apostrophe letters, in every spelling a phone keyboard produces. */
const UZ_LATIN_LETTERS = /[og]['ʻʼ‘’`]/iu;
/** Everyday Uzbek Latin words that are not English. */
const UZ_LATIN_WORDS =
  /(?:^|[^\p{L}])(?:qancha|kancha|nechpul|necha|kerak|bormi|yoq|yo'q|yuk|yukim|narx|narxi|qayerda|qachon|kachon|keldimi|ketdimi|bo'ladi|boladi|aka|opa|uka|iltimos|mumkinmi|qilib|berasiz|bering|kub|kubi|xitoydan|toshkentga)(?=$|[^\p{L}])/iu;
/**
 * Everyday English words that are not Uzbek — and the function words an English request is made of (fix pass 4): «Hi,
 * I have 3 cbm of clothes in Yiwu» carried no mark once «Hi» was none, and the English reply waited. Never «it» (a
 * dog) or «in» (a den): Uzbek words too.
 */
const EN_WORDS =
  /(?:^|[^\p{L}])(?:the|is|are|what|how|much|price|cost|cargo|shipping|please|when|where|my|your|can|you|need|delivery|from|to|i|i'm|i've|have|has|of|we|want|would|like|ship|send|and|with|for|this|that|do|does|any|our|us|me|there|here|get|buy|order|quote|goods|freight)(?=$|[^\p{L}])/iu;

/**
 * One script's two languages, read as MARKS: each language's own words or letters (`uz`, `other`) — never a
 * greeting. Where neither has any, its greetings: they decide a text that is nothing but greetings
 * (`greetingOnly`), and beside other unmarked words they are a GUESS (`guess`), never confident.
 */
function marksOf(
  text: string,
  strong: { uz: (t: string) => boolean; other: (t: string) => boolean },
  greeting: { uz: RegExp; other: RegExp },
  letters: RegExp,
): { uz: boolean; other: boolean; greetingOnly: boolean; guess: 'uz' | 'other' | null; letters: number } {
  const words = text.replace(greeting.uz, ' ').replace(greeting.other, ' ');
  // The letters a line carries beside its greetings (fix pass 4): what `SHORT_LINE` measures — «Assalomu alaykum, cargo
  // price?» is a short English line in an Uzbek conversation, and the greeting's own letters made it a long one.
  const said = count(words, letters);
  const uz = strong.uz(words);
  const other = strong.other(words);
  if (uz || other) return { uz, other, greetingOnly: false, guess: null, letters: said };
  const uzGreet = new RegExp(greeting.uz.source, 'iu').test(text);
  const otherGreet = new RegExp(greeting.other.source, 'iu').test(text);
  const guess = uzGreet === otherGreet ? null : uzGreet ? 'uz' : 'other';
  // No word of either language's own: a greeting speaks only for a text that holds nothing else.
  if (said >= GREETING_ONLY) return { uz: false, other: false, greetingOnly: false, guess, letters: said };
  return { uz: uzGreet, other: otherGreet, greetingOnly: true, guess, letters: said };
}

/**
 * The language a text's greetings alone point to — one language's greeting and not the other's, in its script — or
 * null. What an UNCONFIDENT guess leans on (fix pass 4): the run stores it beside the guess (`memoryFor`), and the
 * gate admits only that language for a reply (auto-gate `languageAdmits`) — «Здравствуйте» over unmarked words is no
 * mark of Russian, and it is no licence for an Uzbek reply either.
 */
export function greetingLean(text: string): AgentLocale | null {
  const script = dominantScript(text);
  const pair =
    script === 'cyrillic'
      ? ([CYRL_GREETING_UZ, CYRL_GREETING_RU, 'uz_cyrl', 'ru'] as const)
      : script === 'latin'
        ? ([LATIN_GREETING_UZ, LATIN_GREETING_EN, 'uz', 'en'] as const)
        : null;
  if (!pair) return null;
  const uz = new RegExp(pair[0].source, 'iu').test(text);
  const other = new RegExp(pair[1].source, 'iu').test(text);
  return uz === other ? null : uz ? pair[2] : pair[3];
}

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
    const m = marksOf(
      text,
      { uz: (t) => UZ_CYRL_LETTERS.test(t) || UZ_CYRL_WORDS.test(t), other: (t) => RU_LETTERS.test(t) || RU_WORDS.test(t) },
      { uz: CYRL_GREETING_UZ, other: CYRL_GREETING_RU },
      CYRILLIC,
    );
    const keep = previous === 'uz_cyrl' || previous === 'ru';
    // A greeting alone never turns the conversation's own Cyrillic language into the other one.
    if (m.greetingOnly && keep && (m.uz ? 'uz_cyrl' : 'ru') !== previous) return { locale: previous, confident: false, script };
    if (m.uz && !m.other) return { locale: 'uz_cyrl', confident: true, script };
    if (m.other && !m.uz) {
      // Russian by its own words — unless the conversation is Uzbek Cyrillic
      // already and this line is too short to say otherwise.
      if (previous === 'uz_cyrl' && m.letters < SHORT_LINE) return { locale: previous, confident: false, script };
      return { locale: 'ru', confident: true, script };
    }
    // Both languages' own words, or no mark of either (0148 fix): the conversation keeps its Cyrillic language;
    // with none, a guess — the greeting's language if one was said — and SAID to be one. «Cyrillic with no Uzbek
    // mark» was «ru, confident», and the auto layer's language clause then refused every correct Uzbek Cyrillic reply.
    if (keep) return { locale: previous, confident: false, script };
    return { locale: m.uz || m.guess === 'uz' ? 'uz_cyrl' : 'ru', confident: false, script };
  }
  if (script === 'latin') {
    const m = marksOf(
      text,
      { uz: (t) => UZ_LATIN_LETTERS.test(t) || UZ_LATIN_WORDS.test(t), other: (t) => EN_WORDS.test(t) },
      { uz: LATIN_GREETING_UZ, other: LATIN_GREETING_EN },
      LATIN,
    );
    if (m.uz && !m.other) return { locale: 'uz', confident: true, script };
    if (m.other && !m.uz) {
      // «Hello», «ok price?» in an Uzbek conversation is an Uzbek customer's
      // loan word, not a switch to English — the Cyrillic rule's twin.
      if (previous === 'uz' && (m.greetingOnly || m.letters < SHORT_LINE)) return { locale: previous, confident: false, script };
      return { locale: 'en', confident: true, script };
    }
    // Both or neither: the conversation keeps its language — a Russian
    // customer's «ok» is still a Russian conversation; with no history,
    // Uzbek, the company's own language and the commoner customer. A Latin
    // conversation keeps its own; a greeting beside unmarked words is a guess
    // of its language for any other («Assalomu alaykum! Qanday yordam…»).
    if (previous === 'uz' || previous === 'en') return { locale: previous, confident: false, script };
    if (m.guess) return { locale: m.guess === 'uz' ? 'uz' : 'en', confident: false, script };
    if (previous) return { locale: previous, confident: false, script };
    return { locale: m.uz ? 'uz' : null, confident: false, script };
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
