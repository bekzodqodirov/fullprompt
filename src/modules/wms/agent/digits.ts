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
/** Alphabetic names: matched from the start of a word, so «процент» holds no «цен» and «plus» no «us». */
const CURRENCY_NAMES = [
  "(?:aqsh|amerika|us|u\\.s\\.?)\\s*dollar\\p{L}*",
  'dollar\\p{L}*',
  'bucks?(?!\\p{L})',
  'us\\$',
  '(?:usd|uzs|rmb|cny|eur|rub|kzt|afn|irr|gbp)(?!\\p{L})',
  'euro\\p{L}*',
  'y?evro\\p{L}*',
  'yuan\\p{L}*',
  'renminbi',
  'rubl\\p{L}*',
  'ruble\\p{L}*',
  'tenge\\p{L}*',
  "so['‘’ʻ`]m\\p{L}*",
  '(?:sum|som)(?:dan|ga|lik|i)?(?!\\p{L})',
  '(?:ақш|сша)\\s*доллар\\p{L}*',
  'доллар\\p{L}*',
  'долл\\.?',
  'бакс\\p{L}*',
  'у\\.\\s?е\\.?',
  'евро',
  'юан\\p{L}*',
  'рубл\\p{L}*',
  'руб\\.?',
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
/** A price, a payment, a balance — no currency named, still money. */
const PRICE_NAMES = [
  'narx\\p{L}*',
  'нарх\\p{L}*',
  'pul\\p{L}*',
  'пул\\p{L}*',
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
  'стои(?:т|ть|мость)(?!\\p{L})',
  'оплат\\p{L}*',
  'плат[её]ж\\p{L}*',
  'сумм\\p{L}*',
  'долг(?:и|а|ов|у)?(?!\\p{L})',
  'деньг\\p{L}*',
  'денег',
  'price\\p{L}*',
  'cost\\p{L}*',
  'fees?(?!\\p{L})',
  'payment\\p{L}*',
  'pay(?:s|ing)?(?!\\p{L})',
  'charge\\p{L}*',
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
];
const PRICE_HAN = ['价格', '价钱', '报价', '费用', '运费', '付款', '多少钱'];

const alt = (parts: readonly string[]) => parts.join('|');

/** A currency written right after a figure (or after its scale word). Anchored by the caller. */
export const CURRENCY_AFTER_SRC = alt([...SIGNS, ...CURRENCY_NAMES, ...CURRENCY_HAN, ...CURRENCY_HAN_AFTER]);

/**
 * A currency written right BEFORE a figure — «$480», «USD 480», «USD480», «у.е. 480». Anchored at the end by
 * the caller. A bare «US» counts only GLUED («US480», numbers.ts): spaced it is the English «us».
 */
export const CURRENCY_BEFORE_SRC = `${alt(SIGNS)}|(?<![\\p{L}])(?:us\\$|usd|uzs|rmb|cny|eur|euro|rub|kzt|у\\.\\s?е\\.?)`;

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
 * figures in digits anyway.
 */
const WORD_NUMERAL =
  /(?:^|[^\p{L}])(?:ikki|uch|to'rt|tort|besh|olti|yetti|sakkiz|to'qqiz|o'n|yigirma|o'ttiz|qirq|ellik|oltmish|yetmish|sakson|to'qson|yuz|ming|два|три|четыре|пять|шесть|семь|восемь|девять|десять|двадцать|тридцать|сорок|пятьдесят|сто|двести|триста|тысяч[аи]?|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده|بیست|سی|چهل|پنجاه|صد|هزار)(?=$|[^\p{L}])/iu;

/** A money or measure word nearby, in any of the six languages — `MONEY_WORD` widens it to every currency and price word. */
const MONEY_OR_MEASURE =
  /(?:\$|usd|dollar|долл|so'm|sum|сум|сўм|yuan|юан|元|美元|块|دلار|تومان|افغانی|kub|куб|м3|m3|m³|kg|кг|公斤|千克|立方|کیلو|متر)/iu;

export type UnverifiableNumeral = 'other_script_digit' | 'han_numeral' | 'word_numeral';

/**
 * A numeral the checks cannot read, or null. Run on the NORMALISED text.
 * A Chinese or word numeral counts only beside a money/measure word: «一下»
 * («a moment») and «bir» («a/one») are words, not figures.
 */
export function unverifiableNumeral(normalized: string): UnverifiableNumeral | null {
  if (OTHER_DIGIT.test(normalized)) return 'other_script_digit';
  // «narxi besh yuz» names no currency and is still a price spelled out.
  const hasUnit = MONEY_OR_MEASURE.test(normalized) || MONEY_WORD.test(normalized);
  if (hasUnit && HAN_NUMERAL.test(normalized)) return 'han_numeral';
  if (hasUnit && WORD_NUMERAL.test(normalized)) return 'word_numeral';
  return null;
}
