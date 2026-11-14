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
/**
 * Everyday Uzbek Cyrillic words that are not Russian — and (fix pass 6, the hunt #3) the ones an Uzbek on a Russian
 * keyboard writes with none of «ў қ ғ ҳ»: «Иудан Тошкентгача неча пул?», «Мен Иудан юбордим», «Тушундим ака» read as no
 * language, and the guess let a Russian reply go by itself. A place with an Uzbek case on it («Иудан», «Гуанчжоуда»,
 * «Тошкентгача», any «…гача») and the possessive «-имиз/-ингиз» are Uzbek's alone.
 */
const UZ_CYRL_WORDS =
  /(?:^|[^\p{L}])(?:ва|учун|керак|керакми|канча|қанча|неча|пул|бор|борми|нима|қачон|качон|юк|нарх|йўқ|йук|бўлади|булади|буладими|мен|сиз|биз|битта|мумкин|мумкинми|муаммо|савол|эди|экан|келади|келадими|турибди|турибдими|тушундим|юбордим|олдим|келдим|бердим|манга|менга|сизга|бизга|ертага|эртага|бугун|хозир|ҳозир|яхши|тайёр|тайор|каерда|қаерда|каерга|қаерга|нечта|кетади|олади|беради|юборади|жунатади|жўнатади|тушади|етади|чикади|чиқади|кетди|келди|булди|бўлди|олди|борди|тушди|жунатди|жўнатди|юборди|чикди|чиқди|жунатдим|жўнатдим|кетдим|курдим|кўрдим|туладим|тўладим|сотдим|ёздим|жунатиш|жўнатиш|юбориш|олиш|тулаш|тўлаш|келиш|кетиш|кийим\p{L}*|кечак)(?=$|[^\p{L}])|\p{L}{2,}(?:гача|имиз|ингиз|имизни|ингизни|имизга|ингизга)(?=$|[^\p{L}])|(?:^|[^\p{L}])(?:иу|иву|гуанчжоу|шэньчжэн\p{L}*|шенжен|фошан\p{L}*|тошкент|ташкент|хитой)(?:дан|да|даги|га|нинг)(?=$|[^\p{L}])|(?:^|[^\p{L}])(?:нарх\p{L}+|манзил\p{L}*|адрес(?:ни|ини|и|га|дан|да|им\p{L}*|ингиз\p{L}*)|товар(?:ни|ини|и|га|дан|да|им\p{L}*|ингиз\p{L}*)|склад(?:га|да|дан|ни|и|имиз\p{L}*|ингиз\p{L}*)|груз(?:ни|га|дан|да|ингиз\p{L}*)|юк(?:им\p{L}*|ни|ини|и|га|дан|да|ингиз\p{L}*|лар\p{L}*)|пул(?:ни|ини|им\p{L}*|ингиз\p{L}*|дан|га))(?=$|[^\p{L}])/iu;

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
  /(?:^|[^\p{L}])(?:сколько|что|как|это|есть|для|или|если|можно|нужно|надо|хочу|можете|будет|стоит|когда|где|почему|уже|меня|мне|вас|вам|напишите|скиньте|отправьте|пришлите|подскажите|скажите|который|которая|которые|кубов|куба|кубы|кубах|кубами|груза|грузов|грузы|грузом|товара|товаров|товары|цена|цену|цены|ценой|вес|веса|весом|стоимость|стоимости|объём|объем|объёма|объема|доставку|доставки|килограмм|килограммов|почём|почем|пришёл|пришел|пришла|отправляю|отправлю|заберёте|заберете|забрать|сможете)(?=$|[^\p{L}])/iu;
/**
 * Fix pass 6's own Russian words an Uzbek says in passing — «понял», «ясно», «понятно», «интересно», «хотел узнать»,
 * «Китая» (fix pass 7, the check #2/#5): «Хоп ака, понял, ертага юбораман», «Рахмат ака понял» read «ru, confident» —
 * the Uzbek reply was refused, the Russian one went by itself, and «ru» was stored over the chat's «uz_cyrl». They
 * mark Russian only where no Uzbek word, ending, letter — or Uzbek GREETING — stands beside them.
 */
const RU_SOFT =
  /(?:^|[^\p{L}])(?:хотел|хотела|хотим|узнать|интересует|интересно|понял|поняла|понятно|ясно|китая|китае|китаю)(?=$|[^\p{L}])/iu;
/**
 * Russian's short function words — «и», «в», «на», «по», «за», «до», «нет», «еще» — mark Russian only in a text that
 * carries no Uzbek word and no Uzbek word ending (fix pass 6, the hunt #9): an Uzbek on a Russian keyboard mixes them in
 * — «Кийим и обувь бор», «Товар в Гуанчжоуда турибди», «Ака, по карте тулаш мумкинми?» — and each read «ru, confident»:
 * the right Uzbek reply was refused and a Russian one went by itself. Beside an Uzbek ending they lean Uzbek.
 */
const RU_WEAK = /(?:^|[^\p{L}])(?:и|в|на|по|за|до|нет|ещё|еще)(?=$|[^\p{L}])/iu;

/**
 * Russian's everyday adverbs — «сегодня», «сейчас», «потом», «тогда», «тоже», «очень», «только», «здесь» — are a mark of
 * Russian only in a line that carries no Uzbek word ENDING (fix pass 5, the check of pass 3): an Uzbek speaker mixes them
 * into his Cyrillic — «Ака хоп, тогда жунатаман», «Гуанчжоудан юкимни потом жунатаман», «Мебель олиб келасизларми,
 * очень срочно керакмиди» — and pass 3 made each «ru, confident»: the right Uzbek reply was refused and a Russian one
 * went by itself. Beside «-аман», «-асизми», «-ларми», «-миди» they mark nothing, and the line leans Uzbek.
 */
const RU_FILLER = /(?:^|[^\p{L}])(?:сегодня|завтра|вчера|сейчас|потом|тогда|тоже|очень|только|здесь)(?=$|[^\p{L}])/iu;
const UZ_CYRL_ENDING =
  /\p{L}{2,}(?:аман|яман|амиз|ямиз|(?:а|я)сиз(?:лар)?(?:ми)?|ларми|сизми|япман|япмиз|япти|ганман|ганмиз|мо[кқ]чиман|миди|мизми|дими)(?=$|[^\p{L}])/iu;
/** Uzbek's plural on any stem — «Документлар», «кийимлар» — never «доллар»: an ENDING, a lean and never a mark. */
const UZ_CYRL_PLURAL = /\p{L}{3,}(?<!дол)лар(?:ни|га|дан|да|и|ини|им\p{L}*|ингиз\p{L}*|ми)?(?=$|[^\p{L}])/iu;
/**
 * Anything of Uzbek in a Cyrillic text — its letters, its words, its word endings (fix pass 7, the check #6): beside it
 * NO Russian word marks Russian. An Uzbek on a Russian keyboard mixes in whatever Russian he has — «Ака товар когда
 * кетади?», «Ака юкимни когда оласизлар?», «Ака, нархи сколько?», «Документлар есть» — and each read «ru, confident»:
 * the Russian reply went by itself, even in an Uzbek Cyrillic chat, and «ru» was stored over it. A Russian speaker
 * writes none of these; where both languages stand, the text is Uzbek's.
 */
function uzbekCyrillic(t: string): boolean {
  return UZ_CYRL_LETTERS.test(t) || UZ_CYRL_WORDS.test(t) || UZ_CYRL_ENDING.test(t) || UZ_CYRL_PLURAL.test(t);
}
/**
 * The Uzbek a Cyrillic text leans to by its word endings alone (fix pass 5) — never a confident mark: what an
 * unconfident guess LEANS on, beside the greetings (`greetingLean`, run `memoryFor`). Fix pass 7: by anything of Uzbek
 * in it, whatever Russian word rides beside it — no Russian word marks a text that carries Uzbek (`russianMarks`).
 */
export function uzbekEndingLean(text: string): AgentLocale | null {
  const script = dominantScript(text);
  if (script === 'cyrillic') return uzbekCyrillic(text) ? 'uz_cyrl' : null;
  if (script === 'latin') return uzbekLatinLeans(text) ? 'uz' : null;
  return null;
}

/** Russian's own words or letters in a text that carries Uzbek too — both languages stand (fix pass 7). */
function russianWordsBeside(text: string): boolean {
  const t = text.replace(CYRL_GREETING_UZ, ' ').replace(CYRL_GREETING_RU, ' ');
  return uzbekCyrillic(t) && (RU_LETTERS.test(t) || RU_WORDS.test(t));
}

/**
 * Russian by its own words and letters — and none of them where anything of Uzbek stands beside them (fix pass 7, the
 * check #6), nor fix pass 6's softer words where the Uzbek greeting does (the check #2): `whole` is the text WITH its
 * greetings, which `marksOf` has taken out of `t`.
 */
function russianMarks(t: string, whole: string): boolean {
  if (uzbekCyrillic(t)) return false;
  if (RU_LETTERS.test(t) || RU_WORDS.test(t)) return true;
  if (new RegExp(CYRL_GREETING_UZ.source, 'iu').test(whole)) return false;
  return RU_SOFT.test(t) || RU_FILLER.test(t) || RU_WEAK.test(t);
}

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
/**
 * Everyday Uzbek Latin words that are not English — and (fix pass 8, the check #2) colloquial ones neither English nor
 * Russian typed in Latin has: «qanaqa» (the everyday twin of «qanday»), «vaqt», «batafsil». «Xizmat turlari qanaqa?»,
 * «Tarif qanaqa?», «Ish vaqti?», «Batafsil malumot?» read as no language, and the Uzbek reply waited for his ✅.
 */
const UZ_LATIN_WORDS =
  /(?:^|[^\p{L}])(?:qancha|kancha|nechpul|necha|nechchi|kerak|bor|bormi|yoq|yo'q|yuk|yukim|narx|narxi|qayerda|qachon|kachon|keldimi|ketdimi|bo'ladi|boladi|aka|opa|uka|iltimos|mumkin|mumkinmi|qilib|olib|berasiz|bering|kub|kubi|xitoydan|toshkentga|tayyor|ekan|tovar|tovarim|turibdi|turibdimi|xizmati|qilganman|kelasizmi|kelasizlarmi|qanday|yaxshi|tushundim|kiyim\p{L}*|manzil\p{L}*|yubor\p{L}*|jo['‘’ʻ`]?nat\p{L}*|qayer\p{L}*|qanaqa(?:si|lar)?|vaqt\p{L}*|batafsil)(?=$|[^\p{L}])|\p{L}{2,}(?:gacha|imiz|ingiz|imizni|ingizni)(?=$|[^\p{L}])|(?:^|[^\p{L}])(?:ivu|yiwu|guanchjou|guanjou|shenchjen|shenjen|toshkent|xitoy)(?:dan|da|dagi|ga|ning)(?=$|[^\p{L}])/iu;
/**
 * Everyday English words that are not Uzbek — and the function words an English request is made of (fix pass 4): «Hi,
 * I have 3 cbm of clothes in Yiwu» carried no mark once «Hi» was none, and the English reply waited. Never «it» (a
 * dog) or «in» (a den): Uzbek words too.
 */
const EN_WORDS =
  /(?:^|[^\p{L}])(?:the|is|are|what|how|much|cost|shipping|please|when|where|which|my|your|can|you|need|from|i'm|i've|have|has|of|we|want|would|like|ship|send|and|with|for|this|that|do|does|any|our|us|me|there|here|get|buy|quote|freight|rate|per|warehouse|shipment|pickup|kindly|advise)(?=$|[^\p{L}])/iu;
/**
 * The trade's English loan words — «cargo», «delivery», «order» — and «i» / «to» (fix pass 6, the hunt #10): an Uzbek
 * types them in his Latin («kiyim i poyabzal bor», «delivery bor», «order qilganman», «to Toshkent olib kelasizlarmi»),
 * and each read «en, confident» — the right Uzbek reply was refused and an English one went by itself. They mark
 * English only in a text that carries no Uzbek word and no Uzbek ending — nor (fix pass 7, the check #13) an Uzbek
 * greeting, and «price», «goods», «address», «ready» are such loan words too: «Salom, Yiwu dan 2 cbm, 300 kg,
 * price?», «Assalomu alaykum. Goods ready. Address?» read «en, confident», and the English reply went by itself. («cbm»
 * is no mark at all: «5 cbm 800 kg» is every customer's.)
 */
const EN_LOAN = /(?:^|[^\p{L}])(?:cargo|delivery|order|i|to|price|prices|goods|address|ready)(?=$|[^\p{L}])/iu;
/**
 * Uzbek Latin's word endings — a LEAN, never a mark (`uzbekLatinLeans`). Fix pass 8 (the check #2): the possessive
 * plural «-lari» — «Narxlari», «Xizmat turlari», «Tolov turlari?» — never «dollari», Russian's plural typed in Latin.
 */
const UZ_LATIN_ENDING =
  /\p{L}{2,}(?:lar|larmi|mi|dan|ga|gacha|da|dagi|imiz|ingiz|aman|amiz|yapman|ganman|ganmiz|asiz|asizlarmi|ibdi|di|moqchi(?:man|miz)|(?<!dol)lari(?:ni|ga|da|dan)?)(?=$|[^\p{L}])/iu;
/** Uzbek's case endings typed APART from their word (fix pass 7, the check #13): «Yiwu dan», «Tashkent ga», «Ivu da». */
const UZ_LATIN_DETACHED = /\p{L}\s+(?:dan|gacha|ga|da|dagi|ning)(?=$|[^\p{L}])/iu;
/** Russian typed in Latin letters — «skolko», «kogda», «dostavka» — is no Uzbek, whatever its endings («kogda», «doroga»). */
const RU_TRANSLIT =
  /(?:^|[^\p{L}])(?:skolko|skoka|kogda|gde|mne|nado|nuzhno|mozhno|stoit|budet|est|eto|chto|kak|pochem|privet|zdravstvuyte|spasibo|pozhaluysta|hochu|khochu|gruz|gruza|dostavka|dostavku|dostavki)(?=$|[^\p{L}])/iu;
function uzbekLatin(t: string): boolean {
  return UZ_LATIN_WORDS.test(t) || UZ_LATIN_LETTERS.test(t) || UZ_LATIN_ENDING.test(t) || UZ_LATIN_DETACHED.test(t);
}
function englishMarks(t: string, whole: string): boolean {
  if (EN_WORDS.test(t)) return true;
  return EN_LOAN.test(t) && !uzbekLatin(t) && !new RegExp(LATIN_GREETING_UZ.source, 'iu').test(whole);
}
/**
 * A Latin text with no listed word leans Uzbek by its word endings (fix pass 7, the check #3 — the twin of the Cyrillic
 * lean): «Sertifikat kerakmi?», «Qanday ishlaysizlar?», «Mebel ham olasizlarmi?», the seeded knowledge's own «… qanday
 * ochiladi?» read as no language once a guess that leans on nothing admitted no reply. Never beside an English mark,
 * and never in Russian typed in Latin. A LEAN, never a mark: it admits only an Uzbek reply.
 */
function uzbekLatinLeans(text: string): boolean {
  const words = text.replace(LATIN_GREETING_UZ, ' ').replace(LATIN_GREETING_EN, ' ');
  return (UZ_LATIN_ENDING.test(words) || UZ_LATIN_DETACHED.test(words)) && !englishMarks(words, '') && !RU_TRANSLIT.test(words);
}

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
      {
        uz: (t) => UZ_CYRL_LETTERS.test(t) || UZ_CYRL_WORDS.test(t),
        other: (t) => russianMarks(t, text),
      },
      { uz: CYRL_GREETING_UZ, other: CYRL_GREETING_RU },
      CYRILLIC,
    );
    const keep = previous === 'uz_cyrl' || previous === 'ru';
    // A greeting alone never turns the conversation's own Cyrillic language into the other one.
    if (m.greetingOnly && keep && (m.uz ? 'uz_cyrl' : 'ru') !== previous) return { locale: previous, confident: false, script };
    // Russian's own words or letters beside anything of Uzbek (fix pass 7): no mark of Russian (`russianMarks`), and
    // no confident Uzbek either — both languages stand, and the text leans Uzbek.
    const both = russianWordsBeside(text);
    if (m.uz && !m.other && !both) return { locale: 'uz_cyrl', confident: true, script };
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
    // Anything of Uzbek in it is Uzbek's guess, whatever greeting stands beside it (fix pass 7): «Здравствуйте» over
    // «Кийим-кечак жунатаман» is an Uzbek speaker greeting in Russian.
    return { locale: m.uz || uzbekCyrillic(text) || m.guess === 'uz' ? 'uz_cyrl' : 'ru', confident: false, script };
  }
  if (script === 'latin') {
    const m = marksOf(
      text,
      { uz: (t) => UZ_LATIN_LETTERS.test(t) || UZ_LATIN_WORDS.test(t), other: (t) => englishMarks(t, text) },
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
    // An English conversation greeted in English, with nothing of Uzbek beside it, is English (fix pass 5): «Hello,
    // good morning», «Thanks, received» once greetings were no marks held every English reply in an English chat.
    if (previous === 'en' && m.guess === 'other') return { locale: 'en', confident: true, script };
    if (previous === 'uz' || previous === 'en') return { locale: previous, confident: false, script };
    // Uzbek's word endings with no listed word (fix pass 7, the check #3): a guess, and Uzbek's — whatever greeting.
    if (!m.other && uzbekLatinLeans(text)) return { locale: 'uz', confident: false, script };
    if (m.guess) return { locale: m.guess === 'uz' ? 'uz' : 'en', confident: false, script };
    if (previous) return { locale: previous, confident: false, script };
    return { locale: m.uz ? 'uz' : null, confident: false, script };
  }
  return { locale: previous, confident: false, script };
}

/**
 * The language HIS OWN ✅ teaches the chat (fix pass 8, the check #1): a chat whose earlier lines said no language —
 * «GS777», «👍», «5 куб 800 кг», an unmarked Russian line — held every later unmarked line for ever, and his ✅ on the
 * held reply taught it nothing. He reads the reply he approves, and its language is his decision: the reply's own
 * language, or — when he typed the words himself — what those words confidently say. Never where the draft's own
 * reading says the customer spoke a language (`reading`, the run's `customerLocaleOf`, stored with the draft): what the
 * customer SAID outranks his ✅. The caller writes it only where the chat stores nothing (decide's `coalesce`) and only
 * for a PERSON's press — never the machine's, whose reply went because the customer's language was already read. A
 * LEAN, as the run's own memory is: a later line that says its language still decides.
 */
export function approvedLocale(a: {
  reading: { locale: AgentLocale | null; confident: boolean; leans?: boolean } | null | undefined;
  language: string | null;
  ownText: string | null;
}): AgentLocale | null {
  if (a.reading && a.reading.locale !== null && (a.reading.confident || a.reading.leans === true)) return null;
  if (a.ownText !== null) {
    const said = detectLocale(a.ownText);
    return said.confident ? said.locale : null;
  }
  return AGENT_LOCALES.find((l) => l === a.language) ?? null;
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
