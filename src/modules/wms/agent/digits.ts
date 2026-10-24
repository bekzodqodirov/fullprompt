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
 */

const PERSIAN = 0x06f0; // ۰
const ARABIC_INDIC = 0x0660; // ٠
const FULL_WIDTH = 0xff10; // ０

/** Persian, Arabic-Indic and full-width digits → ASCII; every other character untouched. */
export function normalizeDigits(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= PERSIAN && code <= PERSIAN + 9) out += String(code - PERSIAN);
    else if (code >= ARABIC_INDIC && code <= ARABIC_INDIC + 9) out += String(code - ARABIC_INDIC);
    else if (code >= FULL_WIDTH && code <= FULL_WIDTH + 9) out += String(code - FULL_WIDTH);
    // The Arabic decimal and thousands separators read as ASCII ones.
    else if (code === 0x066b) out += '.';
    else if (code === 0x066c) out += ',';
    else out += ch;
  }
  return out;
}

/** A decimal digit in some OTHER script (Devanagari, Bengali, Thai …) — nothing here can read it. */
const OTHER_DIGIT = /(?![0-9])\p{Nd}/u;

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

/** A money or measure word nearby, in any of the six languages. */
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
  const hasUnit = MONEY_OR_MEASURE.test(normalized);
  if (hasUnit && HAN_NUMERAL.test(normalized)) return 'han_numeral';
  if (hasUnit && WORD_NUMERAL.test(normalized)) return 'word_numeral';
  return null;
}
