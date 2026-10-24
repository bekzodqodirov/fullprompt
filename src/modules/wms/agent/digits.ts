/**
 * One spelling of a digit before any check reads a number (review leak-7).
 *
 * JavaScript's `\d` is ASCII even under the `u` flag, NFKC folds full-width
 * digits but has no mapping for Persian ۰-۹ or Arabic-Indic ٠-٩, and his
 * Afghan and Iranian customers write in exactly those. Measured against the
 * shipped scrubber: «GS۷۷۷», «GS٧٧٧» and «+۹۹۸ ۹۰ ۱۲۳ ۴۵ ۶۷» came back
 * untouched — another customer's code and a phone number straight past G6,
 * and «۱۵۰ دلار» (an invented $150) straight past G1. So every policy check
 * runs on `normalizeDigits(text)`, and a numeral this file cannot turn into
 * ASCII is not guessed at: it is reported, and the policy blocks the draft.
 *
 * The review measured the next layer down (P1): «⁴⁸⁰ $» and «④⑧⓪ $» passed
 * with an EMPTY ledger, because a superscript or a circled digit is not
 * `\p{Nd}` — so nothing read it AND nothing called it unreadable — and
 * «ＵＳＤ480» kept full-width letters glued to the figure, which read as a code.
 * So the whole text is compatibility-folded (NFKC) as well: a numeral that
 * folds to plain digits IS those digits, every other one (½, Ⅳ, ⓫) is left
 * as it was and reported.
 */

const PERSIAN = 0x06f0; // ۰
const ARABIC_INDIC = 0x0660; // ٠

const NUMERAL = /\p{N}/u;
const PLAIN_DIGITS = /^[0-9]+$/u;

/**
 * Persian and Arabic-Indic digits → ASCII (NFKC has no mapping for them);
 * every other character compatibility-folded — full-width, superscript,
 * circled and mathematical digits, full-width Latin, «㎏», «﷼» — except `№`,
 * which NFKC turns into the two LETTERS «No» that would then weld to the
 * figure they number (calc/channel-post.ts states the same exception).
 */
export function normalizeDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) out += ch;
    else if (code >= PERSIAN && code <= PERSIAN + 9) out += String(code - PERSIAN);
    else if (code >= ARABIC_INDIC && code <= ARABIC_INDIC + 9) out += String(code - ARABIC_INDIC);
    // The Arabic decimal and thousands separators read as ASCII ones.
    else if (code === 0x066b) out += '.';
    else if (code === 0x066c) out += ',';
    else if (ch === '№') out += ch;
    else {
      const folded = ch.normalize('NFKC');
      // «½» folds to «1⁄2» and «⑽» to «(10)» — a numeral is taken only as plain digits, or not at all.
      out += NUMERAL.test(ch) && !PLAIN_DIGITS.test(folded) ? ch : folded;
    }
  }
  // Per-character folding leaves a decomposed letter decomposed; compose it back.
  return out.normalize('NFC');
}

/**
 * The words that make a figure MONEY, in the six languages (P1).
 *
 * The shipped classifier knew a currency only as the one word right beside a
 * figure — «$», «dollar», «so'm» — so «90 AQSH dollari», «300 US dollars»,
 * «480 евро», «480 RMB», «480 у.е.» and «Narx (dollarda): 480» all read as a
 * bare number, and a bare number passes on the customer's own «480 kg». Here
 * because both readers ask them: numbers.ts (which kind a figure is) and the
 * word-numeral check below (is a spelled-out number beside money).
 */
const SIGNS = ['\\$', '€', '¥', '£', '₽', '₸', '₺', '؋'];
/**
 * Alphabetic names: matched from the start of a word, so «процент» holds no «цен» and «plus» no «us» —
 * and a name that is also the start of an ordinary word ends where the currency does: «рубашки» holds
 * no «руб», «европаллеты» and «Yevropa» no euro (the fix round measured each turning a carton count
 * into money). Misspellings people actually send are names too: «dollor», «долар», «USDT».
 */
const CURRENCY_NAMES = [
  "(?:aqsh|amerika|us|u\\.s\\.?)\\s*dollar\\p{L}*",
  'dollar\\p{L}*',
  'dollor\\p{L}*',
  'bucks?(?!\\p{L})',
  'us\\$',
  '(?:usdt?|uzs|rmb|cny|eur|rub|kzt|afn|irr|gbp)(?!\\p{L})',
  'euros?(?!\\p{L})',
  'y?evro(?:ga|da|dan|ni|ning|lar\\p{L}*)?(?!\\p{L})',
  'yuan\\p{L}*',
  'renminbi',
  'rubl\\p{L}*',
  'ruble\\p{L}*',
  'tenge\\p{L}*',
  "so['‘’ʻ`]m\\p{L}*",
  '(?:sum|som)(?:dan|ga|lik|i)?(?!\\p{L})',
  '(?:ақш|сша)\\s*доллар\\p{L}*',
  'доллар\\p{L}*',
  'долар\\p{L}*',
  'долл?ор\\p{L}*',
  'долл\\.?',
  'бакс\\p{L}*',
  'у\\.\\s?е\\.?',
  'евро(?!\\p{L})',
  'юан\\p{L}*',
  'рубл\\p{L}*',
  'руб(?:\\.|(?!\\p{L}))',
  'тенге',
  'сўм\\p{L}*',
  'сум(?:а|ов|ы|ах|ам|ми|дан|га)?(?!\\p{L})',
  'сом(?:а|ов|ы)?(?!\\p{L})',
  'دلار',
  'تومان',
  'افغانی',
  'ریال',
  'یوان',
  'یورو',
];
/** Han has no word edges: these are matched anywhere. */
const CURRENCY_HAN = ['美元', '美金', '人民币', '欧元', '卢布', '坚戈'];
/** …and these only right after a figure: «单元» is a unit and «一块» a piece. */
const CURRENCY_HAN_AFTER = ['元', '块'];
/**
 * A price, a payment, a balance — no currency named, still money. A per-unit price is one too: «kilosiga
 * 17», «kubiga 160», «за кило 17», «per kg 17» name no currency and are the avia rate and the truck rate
 * themselves. «pul» ends with its own case endings — «Pulat» is a customer and «pullover» a good — and
 * Latin «summa» is the Cyrillic «сумм» the list always had.
 */
const PRICE_NAMES = [
  'narx\\p{L}*',
  'нарх\\p{L}*',
  'pul(?:lar)?(?:im|ingiz|ing|i)?(?:ni|ga|da|dan|ning)?(?:siz|lik)?(?!\\p{L})',
  'пул(?:лар)?(?:им|ингиз|инг|и)?(?:ни|га|да|дан|нинг)?(?:сиз|лик)?(?!\\p{L})',
  'summa(?:si|ga|da|dan|ni|ning|lar\\p{L}*)?(?!\\p{L})',
  'kilo(?:si)?ga(?!\\p{L})',
  'kub(?:i)?ga(?!\\p{L})',
  'кило(?:си)?га(?!\\p{L})',
  'куб(?:и)?га(?!\\p{L})',
  'за\\s+(?:кило\\p{L}*|кг|куб\\p{L}*|тонн\\p{L}*|м3|м³)',
  'per\\s+(?:kg|kilo\\p{L}*|cbm|m3|m³|cube|cubic\\s+met\\p{L}*|ton\\p{L}*)',
  "to['‘’ʻ`]?lov\\p{L}*",
  'тўлов\\p{L}*',
  'qiymat\\p{L}*',
  'қиймат\\p{L}*',
  "yo['‘’ʻ`]?lkira\\p{L}*",
  'йўлкира\\p{L}*',
  'tarif\\p{L}*',
  'тариф\\p{L}*',
  'balans\\p{L}*',
  'баланс\\p{L}*',
  'qarz\\p{L}*',
  'қарз\\p{L}*',
  'цен[аеуыой]\\p{L}*',
  'цен(?!\\p{L})',
  'стоимост\\p{L}*',
  // «Сколько стоит?» asks the price; a bare «стоит» is also «stands» (numbers.ts reads «стоит 480» itself).
  'сколько\\s+(?:\\p{L}+\\s+)?сто(?:ит|ят|ить|ило)(?!\\p{L})',
  'оплат\\p{L}*',
  'плат[её]ж\\p{L}*',
  'сумм\\p{L}*',
  'долг(?:и|а|ов|у)?(?!\\p{L})',
  'деньг\\p{L}*',
  'денег',
  'price\\p{L}*',
  'cost(?:s|ing|ed)?(?!\\p{L})',
  'fees?(?!\\p{L})',
  'payment\\p{L}*',
  'pay(?:s|ing)?(?!\\p{L})',
  'charge[sd]?(?!\\p{L})',
  'tariff\\p{L}*',
  'balance\\p{L}*',
  'debt\\p{L}*',
  'money',
  'قیمت',
  'هزینه',
  'پول',
  'پرداخت',
  'کرایه',
  'نرخ',
  'تعرفه',
  'بدهی',
  'کیلویی',
];
const PRICE_HAN = ['价格', '价钱', '报价', '费用', '运费', '付款', '多少钱', '每公斤', '每千克', '每方', '每立方'];

const alt = (parts: readonly string[]) => parts.join('|');

/** A currency written right after a figure (or after its scale word). Anchored by the caller. */
export const CURRENCY_AFTER_SRC = alt([...SIGNS, ...CURRENCY_NAMES, ...CURRENCY_HAN, ...CURRENCY_HAN_AFTER]);

/**
 * A currency written right BEFORE a figure — «$480», «USD 480», «USD480», «у.е. 480». Anchored at the end by
 * the caller. A bare «US» counts only GLUED («US480», numbers.ts): spaced it is the English «us».
 */
export const CURRENCY_BEFORE_SRC = `${alt(SIGNS)}|(?<![\\p{L}])(?:us\\$|usdt?|uzs|rmb|cny|eur|euro|rub|kzt|у\\.\\s?е\\.?)`;

/** Money named anywhere in a text: a currency or a price word. */
export const MONEY_WORD = new RegExp(
  `${alt(SIGNS)}|${alt([...CURRENCY_HAN, ...PRICE_HAN])}|(?<![\\p{L}])(?:${alt([...CURRENCY_NAMES, ...PRICE_NAMES])})`,
  'iu',
);

/** A numeral NFKC could not make plain digits of, in any script — nothing here can read it. */
const OTHER_DIGIT = /(?![0-9〇])\p{N}/u;

/** Chinese numerals: a run of them is a number nobody here can verify. */
const HAN_NUMERAL = /[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]{1,}/u;

/**
 * Word numerals in the six languages, beside a money or measure word, are a
 * number spelled out — «yuz dollar», «сто долларов», «صد دلار», «二百美元».
 * Not a whole number parser: the point is to notice that a figure is there.
 * «One» is left out in every language — «bir kub», «один раз», «one box» are
 * the indefinite article as often as a count, and the reply is told to write
 * figures in digits anyway. Persian «نه» is left out too: it is «no» far more
 * often than «nine», and counts only right before a unit (`NINE_FA`).
 */
const NUMERAL_WORDS =
  "ikki|uch|to['‘’ʻ`]?rt|besh|olti|yetti|sakkiz|to['‘’ʻ`]?qqiz|o['‘’ʻ`]n|yigirma|o['‘’ʻ`]ttiz|qirq|ellik|oltmish|yetmish|sakson|to['‘’ʻ`]?qson|yuz|ming|два|три|четыре|пять|шесть|семь|восемь|девять|десять|двадцать|тридцать|сорок|пятьдесят|сто|двести|триста|тысяч[аи]?|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand|دو|سه|چهار|پنج|شش|هفت|هشت|ده|بیست|سی|چهل|پنجاه|صد|هزار";
const WORD_NUMERAL = new RegExp(`(?:^|[^\\p{L}])(?:${NUMERAL_WORDS})(?=$|[^\\p{L}])`, 'iu');
const NINE_FA = /(?<![\p{L}])نه\s+(?:روز|هفته|ماه|ساعت|دلار|تومان|افغانی|کیلو|متر)/u;

/** A money or measure word nearby, in any of the six languages — the shipped list, read across the whole text. */
const MONEY_OR_MEASURE =
  /(?:\$|usd|dollar|долл|so'm|sum|сум|сўм|yuan|юан|元|美元|块|دلار|تومان|افغانی|kub|куб|м3|m3|m³|kg|кг|公斤|千克|立方|کیلو|متر)/iu;

/**
 * A duration written without a digit (fix round): «bir haftada», «ikki kunda», «через неделю», «три дня»,
 * «in two days», «within a week», «دو روز», «两天». No digit means nothing reads it as a figure, so G1
 * could not ask its source and G2's day rule never saw a day count — «Yukingiz bir haftada yetib keladi»
 * passed both. Here «bir» / «один» / «a» DO count: beside a unit of time they are a count of it, not
 * an article. A unit alone needs its preposition — «на этой неделе» and «har kuni» are no duration.
 */
const UZ_NUM =
  "bir|ikki|uch|to['‘’ʻ`]?rt|besh|olti|yetti|sakkiz|to['‘’ʻ`]?qqiz|o['‘’ʻ`]n|yigirma|o['‘’ʻ`]ttiz|necha|bir\\s+necha";
const UZ_CYRL_NUM = 'бир|икки|уч|тўрт|беш|олти|етти|саккиз|тўққиз|ўн|йигирма|ўттиз|неча';
const RU_NUM =
  'од(?:ин|ну|ни)|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|пар[уы]|несколько|полтор[аы]|двадцать|тридцать';
const EN_NUM = 'one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|a\\s+couple\\s+of|couple\\s+of|a\\s+few|few|several';
const FA_NUM = 'یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|چند';
const HAN_DURATION = '[一二两三四五六七八九十几半]+个?(?:工作日|天|日|周|星期|月|小时)';
export const SPELLED_DURATION_SRC = [
  `(?<![\\p{L}])(?:${UZ_NUM})(?:[-–\\s]+(?:${UZ_NUM}))*\\s+(?:ish\\s+)?(?:kun|hafta|oy|soat|daqiqa|sutka)(?:lar)?(?:i(?:da|ga|dan|ni|ning|gacha)?|da|ga|dan|ni|ning|gacha|lik|cha)?(?![\\p{L}])`,
  `(?<![\\p{L}])(?:${UZ_CYRL_NUM})(?:[-–\\s]+(?:${UZ_CYRL_NUM}))*\\s+(?:иш\\s+)?(?:кун|ҳафта|ой|соат|дақиқа)(?:лар)?(?:и(?:да|га|дан|ни|нинг|гача)?|да|га|дан|ни|нинг|гача|лик|ча)?(?![\\p{L}])`,
  `(?<![\\p{L}])(?:${RU_NUM})(?:[-–\\s]+(?:${RU_NUM}))*\\s+(?:(?:рабоч|календарн)\\p{L}*\\s+)?(?:дн(?:я|ей)|день|сут(?:ки|ок)|недел[иьяю]|месяц(?:а|ев)?|час(?:а|ов)?)(?![\\p{L}])`,
  '(?<![\\p{L}])(?:через|в\\s+течение|в\\s+пределах)\\s+(?:недел[юи]|месяц[а]?|сутки|суток|день|дня|час[а]?)(?![\\p{L}])',
  `(?<![\\p{L}])(?:${EN_NUM})(?:[-–\\s]+(?:or\\s+)?(?:${EN_NUM}))*\\s+(?:(?:business|working|calendar)\\s+)?(?:days?|weeks?|months?|hours?)(?![\\p{L}])`,
  '(?<![\\p{L}])(?:in|within)\\s+(?:a|an)\\s+(?:day|week|month|hour)(?![\\p{L}])',
  `(?<![\\p{L}])(?:${FA_NUM})\\s+(?:روز|هفته|ماه|ساعت)`,
  HAN_DURATION,
].join('|');
const SPELLED_DURATION = new RegExp(SPELLED_DURATION_SRC, 'iu');
const HAN_SPELLED_DURATION = new RegExp(HAN_DURATION, 'u');

/** A Chinese numeral run right beside money: «价格是三百», «三百美金» — `MONEY_OR_MEASURE` has «元» and «块» already. */
const HAN_RUN = '[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]+';
const HAN_BESIDE_MONEY = new RegExp(
  `(?:${alt(PRICE_HAN)})(?:是|为|：|:)?\\s*${HAN_RUN}|${HAN_RUN}\\s*(?:${alt(CURRENCY_HAN)})`,
  'u',
);

/** A text's words, as the word-numeral check reads its neighbours. */
const TOKEN = /[\p{L}\p{M}'‘’ʻ`.\-]+|[$€¥£₽₸₺؋]/gu;
const NUMERAL_TOKEN = new RegExp(`^(?:bir[-–])?(?:${NUMERAL_WORDS})(?:[-–](?:${NUMERAL_WORDS}))*[.,]?$`, 'iu');
/** Words that stand between a price word and its figure without changing whose figure it is: «narxi esa besh yuz». */
const COPULA = /^(?:is|are|was|will|be|of|это|будет|составит|составляет|esa|edi|bo['‘’ʻ`]?ladi|است|هست)$/iu;

/**
 * A word numeral with a price word RIGHT beside it — the word before its run (past one copula) or the two
 * after. The package read the price words across the whole text, so «Narxni aytish uchun ikki narsa
 * kerak», «The price depends on two things», «Для расчёта цены нужно три вещи» — a count of things in a
 * sentence about price — were each refused as a spelled-out figure (fix round).
 */
function numeralBesideMoney(normalized: string): boolean {
  const tokens = normalized.match(TOKEN) ?? [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!NUMERAL_TOKEN.test(tokens[i]!)) continue;
    let j = i;
    while (j + 1 < tokens.length && NUMERAL_TOKEN.test(tokens[j + 1]!)) j += 1;
    let b = i - 1;
    if (b >= 0 && COPULA.test(tokens[b]!)) b -= 1;
    if ((b >= 0 && MONEY_WORD.test(tokens[b]!)) || MONEY_WORD.test(tokens.slice(j + 1, j + 3).join(' '))) return true;
    i = j;
  }
  return false;
}

export type UnverifiableNumeral = 'other_script_digit' | 'han_numeral' | 'word_numeral';

/**
 * A numeral the checks cannot read, or null. Run on the NORMALISED text.
 * A Chinese or word numeral counts only beside a money, measure or time
 * word: «一下» («a moment») and «bir» («a/one») are words, not figures.
 */
export function unverifiableNumeral(normalized: string): UnverifiableNumeral | null {
  if (OTHER_DIGIT.test(normalized)) return 'other_script_digit';
  const nearby = MONEY_OR_MEASURE.test(normalized);
  if ((nearby && HAN_NUMERAL.test(normalized)) || HAN_BESIDE_MONEY.test(normalized)) return 'han_numeral';
  if (HAN_SPELLED_DURATION.test(normalized)) return 'han_numeral';
  // «narxi besh yuz» names no currency and is still a price spelled out.
  if ((nearby && WORD_NUMERAL.test(normalized)) || numeralBesideMoney(normalized)) return 'word_numeral';
  if (NINE_FA.test(normalized) || SPELLED_DURATION.test(normalized)) return 'word_numeral';
  return null;
}
