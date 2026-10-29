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
 *
 * One spelling of the Uzbek apostrophe too (incident 2026-10-29): the seed
 * writes «vaʼda», «maʼlumot» with U+02BC, NFKC leaves it alone, and every
 * rule here spells the apostrophe «['‘’ʻ`]». So the kb's own disclaimer «bu
 * taxmin, vaʼda emas» was no disclaimer, and «muammo boʼlmaydi» — a guarantee
 * — was no guarantee: the same letter misread both ways. U+02BC is read as
 * the ASCII «'» the rules were written for. So are the other marks people
 * type for it (review): the backtick, the acute «´» (which NFKC turns into a
 * SPACE and a combining accent, cutting «to´laysiz» in two), the prime «′»
 * and «ʹ» — «Hech qanday muammo bo`lmaydi», «Pulni keyin to´laysiz», «Sug`urta
 * ham qilib beramiz» passed as no guarantee, no credit, no free insurance,
 * and the reply is told to write as the customer writes. «ʻ» (U+02BB, «oʻ»,
 * «gʻ») and «‘ ’» are in every class already, and are left as written.
 */

const PERSIAN = 0x06f0; // ۰
const ARABIC_INDIC = 0x0660; // ٠

const NUMERAL = /\p{N}/u;
/** U+02BC «ʼ» (the seed's), «`», «´», «′», «ʹ». */
const APOSTROPHES: ReadonlySet<number> = new Set([0x02bc, 0x60, 0xb4, 0x2032, 0x02b9]);
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
    // «vaʼda», «bo`lmaydi», «to´laysiz» are «va'da», «bo'lmaydi», «to'laysiz»: every apostrophe people type,
    // read as the one the rules spell — before NFKC, which makes a space of «´».
    if (APOSTROPHES.has(code)) out += "'";
    else if (code < 0x80) out += ch;
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
  '(?:usdt?|uzs|rmb|cny|eur|rub|kzt|afn|irr|gbp|tjs|tmt|aed|inr|jpy|uah)(?!\\p{L})',
  // The neighbours' currencies (fix round): «330 somoni», «330 manat», «330 dirham» named no currency anybody
  // listed, so the figure was read in DOLLARS and the tool's 330 $ vouched for it — the card printing «330 $»
  // beside a body his Tajik customer reads in somoni. Each is its own code here, which no tool source carries.
  'somoni\\p{L}*',
  'сомони\\p{L}*',
  'manat\\p{L}*',
  'манат\\p{L}*',
  'dirham\\p{L}*',
  'дирхам\\p{L}*',
  'lira(?:s|si|ga|da|dan|ni)?(?!\\p{L})',
  'лир(?:а|ы|у|ах)(?!\\p{L})',
  'rupee\\p{L}*',
  'rupiy\\p{L}*',
  'рупи\\p{L}*',
  'yen(?!\\p{L})',
  'iyena\\p{L}*',
  'иен\\p{L}*',
  'йен(?:а|ы|ов)?(?!\\p{L})',
  'гривн\\p{L}*',
  'hryvn\\p{L}*',
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
  'منات',
  'روپیه',
  'لیر(?:ه|ا)?',
];
/** Han has no word edges: these are matched anywhere. */
const CURRENCY_HAN = ['美元', '美金', '人民币', '欧元', '卢布', '坚戈', '日元', '卢比', '里拉', '迪拉姆', '索莫尼', '马纳特'];
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

/**
 * Which currency a figure is in (final review K16). G1 compared a figure's
 * VALUE and KIND, so the yo'lkira tool's 330 dollars vouched for «330元»,
 * «330 so'm», «330 рублей», «۳۳۰ تومان» — a seventh of the price to a Chinese
 * supplier, the card's «🔢 Raqamlar» printing a bare «330 (pul)» and the
 * Uzbek gloss under it the model's own words. Every money source of a tool is
 * in dollars today; a figure now carries the currency its spelling names, and
 * the two must agree.
 */
export type Currency =
  | 'USD'
  | 'USDT'
  | 'CNY'
  | 'UZS'
  | 'RUB'
  | 'EUR'
  | 'KZT'
  | 'AFN'
  | 'IRR'
  | 'GBP'
  | 'TRY'
  | 'TJS'
  | 'TMT'
  | 'AED'
  | 'INR'
  | 'JPY'
  | 'UAH';

/**
 * A currency spelling to its code, tried in order: «美元» and «欧元» hold «元»
 * and are asked before the yuan, «USDT» before the dollar. «сом» / «som» are
 * the Uzbek so'm as his customers write it — so «сомони», which starts with
 * it, is asked first, as «日元» is before the yuan.
 */
const CURRENCY_CODES: readonly (readonly [RegExp, Currency])[] = [
  [/usdt/iu, 'USDT'],
  [/\$|(?:^|[^\p{L}])us|usd|dollar|dollor|bucks?|доллар|долар|долл|бакс|у\.\s?е|美元|美金|دلار/iu, 'USD'],
  [/somoni|сомони|tjs|索莫尼/iu, 'TJS'],
  [/manat|манат|tmt|منات|马纳特/iu, 'TMT'],
  [/dirham|дирхам|aed|迪拉姆/iu, 'AED'],
  [/rupee|rupiy|рупи|inr|روپیه|卢比/iu, 'INR'],
  [/(?:^|[^\p{L}])yen|iyena|иен|йен|jpy|日元/iu, 'JPY'],
  [/гривн|hryvn|uah/iu, 'UAH'],
  [/₺|lira|лир|لیر|里拉/iu, 'TRY'],
  [/€|eur|euro|evro|евро|欧元|یورو/iu, 'EUR'],
  [/₽|rub|рубл|руб|卢布/iu, 'RUB'],
  [/₸|kzt|tenge|тенге|坚戈/iu, 'KZT'],
  [/¥|rmb|cny|yuan|renminbi|юан|人民币|元|块|یوان/iu, 'CNY'],
  [/uzs|so['‘’ʻ`]m|сўм|(?:^|[^\p{L}])(?:sum|som)|сум|сом/iu, 'UZS'],
  [/؋|afn|افغانی/iu, 'AFN'],
  [/irr|تومان|ریال/iu, 'IRR'],
  [/£|gbp/iu, 'GBP'],
];

/** The code of a currency spelling, or null — a spelling nothing here names reads as no currency anybody quoted. */
export function currencyOf(token: string): Currency | null {
  const t = token.trim();
  if (t === '') return null;
  return CURRENCY_CODES.find(([re]) => re.test(t))?.[1] ?? null;
}

/**
 * Every currency a text names, wherever — «元» and «块» only right after a
 * figure (alone «单元» is a unit and «一块» a piece). Read when a bare figure
 * is money because the TEXT names money: «Narx (yuanda): 480» is 480 yuan.
 */
const CURRENCY_ANYWHERE = new RegExp(
  `${alt(SIGNS)}|${alt(CURRENCY_HAN)}|(?<=\\d\\s?)(?:${alt(CURRENCY_HAN_AFTER)})|(?<![\\p{L}])(?:${alt(CURRENCY_NAMES)})`,
  'giu',
);

export function currenciesNamed(text: string): Set<Currency | null> {
  return new Set([...text.matchAll(CURRENCY_ANYWHERE)].map((m) => currencyOf(m[0])));
}

/** How the card names a currency — beside the figure on «🔢 Raqamlar». */
export const CURRENCY_LABEL: Record<Currency, string> = {
  USD: '$',
  USDT: 'USDT',
  CNY: 'yuan',
  UZS: 'so‘m',
  RUB: 'rubl',
  EUR: 'yevro',
  KZT: 'tenge',
  AFN: 'afg‘oni',
  IRR: 'rial/tumon',
  GBP: 'funt',
  TRY: 'lira',
  TJS: 'somoni',
  TMT: 'manat',
  AED: 'dirham',
  INR: 'rupiya',
  JPY: 'iyena',
  UAH: 'grivna',
};

/** A numeral NFKC could not make plain digits of, in any script — nothing here can read it. */
const OTHER_DIGIT = /(?![0-9〇])\p{N}/u;

/** Chinese numerals: a run of them is a number nobody here can verify. */
const HAN_NUMERAL = /[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]{1,}/u;

/**
 * Word numerals in the six languages, beside a money, measure or time word,
 * are a number spelled out — «yuz dollar», «besh kub», «ikki hafta», «сто
 * долларов», «صد دلار». Not a whole number parser: the point is to notice
 * that a figure is there. «One» is left out in every language — «bir kub»,
 * «один раз», «one box» are the indefinite article as often as a count, and
 * the reply is told to write figures in digits anyway. Persian «نه» is left
 * out too: it is «no» far more often than «nine», and counts only right
 * before a unit (`NINE_FA`).
 *
 * Uzbek in Cyrillic was missing whole, and Russian had no teens, no «две»,
 * no hundreds past three and no case forms (review): «Нархи беш юз доллар
 * бўлади», «Ҳар куб учун икки юз доллар», «Авиа — семнадцать долларов за
 * килограмм» were prices spelled out that nothing read.
 */
const NUMERAL_WORDS = [
  "ikki|uch|to['‘’ʻ`]?rt|besh|olti|yetti|sakkiz|to['‘’ʻ`]?qqiz|o['‘’ʻ`]n|yigirma|o['‘’ʻ`]ttiz|qirq|ellik|oltmish|yetmish|sakson|to['‘’ʻ`]?qson|yuz|ming",
  'икки|уч|тўрт|беш|олти|етти|саккиз|тўққиз|ўн|йигирма|ўттиз|қирқ|эллик|олтмиш|етмиш|саксон|тўқсон|юз|минг',
  'два|две|двух|три|тр[её]х|четыре|четыр[её]х|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|десяти',
  'одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать',
  'двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто',
  'сто|двести|двухсот|триста|тр[её]хсот|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот|тысяч\\p{L}*',
  'two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen',
  'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand',
  'دو|سه|چهار|پنج|شش|هفت|هشت|ده|یازده|دوازده|سیزده|چهارده|پانزده|شانزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|صد|هزار',
].join('|');

/**
 * The numerals that are a FIGURE in any reply (third review): hundreds and thousands, tens and teens. A price
 * is never two or three dollars — the flight is 17 a kilo, the truck from 110 a cube — so a spelled price is
 * one of these, and «ikki», «три», «two» alone are as often kinds, warehouses and questions as counts. The
 * teens English and Persian lacked (thirteen-nineteen, sixty-ninety, یازده-نوزده) passed as no numeral at all:
 * «Air freight is seventeen dollars a kilo» named a currency beside a word nothing read. Persian «ده» stays a
 * small count: it is «village» as well as ten.
 */
const SCALE_WORD =
  /^(?:yuz|ming|юз|минг|сто|двести|двухсот|триста|тр[её]хсот|четыреста|пятьсот|шестьсот|семьсот|восемьсот|девятьсот|тысяч\p{L}*|hundred|thousand|صد|هزار)$/iu;
const TENS_WORD = new RegExp(
  `^(?:${[
    "o['‘’ʻ`]n|yigirma|o['‘’ʻ`]ttiz|qirq|ellik|oltmish|yetmish|sakson|to['‘’ʻ`]?qson",
    'ўн|йигирма|ўттиз|қирқ|эллик|олтмиш|етмиш|саксон|тўқсон',
    'десять|десяти|одиннадцать|двенадцать|тринадцать|четырнадцать|пятнадцать|шестнадцать|семнадцать|восемнадцать|девятнадцать',
    'двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто',
    'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety',
    'یازده|دوازده|سیزده|چهارده|پانزده|شانزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود',
  ].join('|')})$`,
  'iu',
);
/** A bare scale word standing alone — «ming», «сто», «тысяча», «hundred»: a figure in a reply that prices, a word in one that does not. */
const LONE_SCALE = /^(?:ming|минг|сто|тысяч\p{L}*|hundred|thousand|صد|هزار)$/iu;
/** «Yuz» alone is also a FACE — «yuz kremi», a face cream, is goods — and «yuz bermoq» is to happen: only its neighbours make it a figure. */
const LONE_FACE = /^(?:yuz|юз)$/iu;
const NINE_FA = /(?<![\p{L}])نه\s+(?:روز|هفته|ماه|ساعت|دلار|تومان|افغانی|کیلو|متر)/u;

/** A money or measure word nearby, in any of the six languages — the shipped list, read across the whole text (Chinese numerals only). */
const MONEY_OR_MEASURE =
  /(?:\$|usd|dollar|долл|so'm|sum|сум|сўм|yuan|юан|元|美元|块|دلار|تومان|افغانی|kub|куб|м3|m3|m³|kg|кг|公斤|千克|立方|کیلو|متر)/iu;

/**
 * A duration written without a digit (fix round): «bir haftada», «ikki kunda», «через неделю», «три дня»,
 * «in two days», «within a week», «دو روز», «两天». No digit means nothing reads it as a figure, so G1
 * could not ask its source and G2's day rule never saw a day count — «Yukingiz bir haftada yetib keladi»
 * passed both. Here «bir» / «один» / «a» DO count: beside a unit of time they are a count of it, not
 * an article. A unit alone needs its preposition — «на этой неделе» and «har kuni» are no duration.
 *
 * Two lists (incident 2026-10-29). The VAGUE and the asking quantifiers — «necha», «bir necha», «неча»,
 * «несколько», «пару», «a few», «several», «چند», «几» — state no count, so G1 has no figure in them to
 * ask a source for: «Yuk necha kunda kelishi yo'nalishga bog'liq», «Narxni bir necha daqiqada hisoblab
 * beraman», «Расчёт займёт несколько дней» each lost their ✅ as a spelled-out number. G2 reads the
 * other list, the whole one (`SPELLED_DURATION_SRC`, policy.ts): «bir necha kunda yetib keladi» is still a
 * dispatch promise, however vague its count.
 */
const UZ_NUM_DEFINITE =
  "bir|ikki|uch|to['‘’ʻ`]?rt|besh|olti|yetti|sakkiz|to['‘’ʻ`]?qqiz|o['‘’ʻ`]n|yigirma|o['‘’ʻ`]ttiz";
const UZ_CYRL_NUM_DEFINITE = 'бир|икки|уч|тўрт|беш|олти|етти|саккиз|тўққиз|ўн|йигирма|ўттиз';
const RU_NUM_DEFINITE =
  'од(?:ин|ну|ни|ного|ной)|два|две|двух|три|тр[её]х|четыре|четыр[её]х|пять|пяти|шесть|шести|семь|семи|восемь|восьми|девять|девяти|десять|десяти';
const RU_NUM_TENS = 'двадцать|тридцать';
const EN_NUM_DEFINITE = 'one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty';
const FA_NUM_DEFINITE = 'یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده';
const HAN_DIGITS = '一二两三四五六七八九十半';
const HAN_ANY = '一二两三四五六七八九十几半';
const HAN_UNIT = '个?(?:工作日|天|日|周|星期|月|小时)';

function spelledDurationSrc(vague: boolean): string {
  const uz = vague ? `${UZ_NUM_DEFINITE}|necha|bir\\s+necha` : UZ_NUM_DEFINITE;
  const uzCyrl = vague ? `${UZ_CYRL_NUM_DEFINITE}|неча` : UZ_CYRL_NUM_DEFINITE;
  // «Отправим груз в течение нескольких дней» is the vague count in its genitive (review).
  const ru = vague
    ? `${RU_NUM_DEFINITE}|пар[уыа]|нескольк\\p{L}*|полтор[аы]|${RU_NUM_TENS}`
    : `${RU_NUM_DEFINITE}|полтор[аы]|${RU_NUM_TENS}`;
  const en = vague ? `${EN_NUM_DEFINITE}|a\\s+couple\\s+of|couple\\s+of|a\\s+few|few|several` : EN_NUM_DEFINITE;
  const fa = vague ? `${FA_NUM_DEFINITE}|چند` : FA_NUM_DEFINITE;
  // A run that holds a numeral of its own: «十几天» is ten-odd days, «几天» how many (or a few).
  const han = vague ? `[${HAN_ANY}]+${HAN_UNIT}` : `[${HAN_ANY}]*[${HAN_DIGITS}][${HAN_ANY}]*${HAN_UNIT}`;
  return [
    `(?<![\\p{L}])(?:${uz})(?:[-–\\s]+(?:${uz}))*\\s+(?:ish\\s+)?(?:kun|hafta|oy|soat|daqiqa|sutka)(?:lar)?(?:i(?:da|ga|dan|ni|ning|gacha)?|da|ga|dan|ni|ning|gacha|lik|cha)?(?![\\p{L}])`,
    `(?<![\\p{L}])(?:${uzCyrl})(?:[-–\\s]+(?:${uzCyrl}))*\\s+(?:иш\\s+)?(?:кун|ҳафта|ой|соат|дақиқа)(?:лар)?(?:и(?:да|га|дан|ни|нинг|гача)?|да|га|дан|ни|нинг|гача|лик|ча)?(?![\\p{L}])`,
    `(?<![\\p{L}])(?:${ru})(?:[-–\\s]+(?:${ru}))*\\s+(?:(?:рабоч|календарн)\\p{L}*\\s+)?(?:дн(?:я|ей)|день|сут(?:ки|ок)|недел[иьяю]|месяц(?:а|ев)?|час(?:а|ов)?)(?![\\p{L}])`,
    '(?<![\\p{L}])(?:через|в\\s+течение|в\\s+пределах)\\s+(?:недел[юи]|месяц[а]?|сутки|суток|день|дня|час[а]?)(?![\\p{L}])',
    `(?<![\\p{L}])(?:${en})(?:[-–\\s]+(?:or\\s+)?(?:${en}))*\\s+(?:(?:business|working|calendar)\\s+)?(?:days?|weeks?|months?|hours?)(?![\\p{L}])`,
    '(?<![\\p{L}])(?:in|within)\\s+(?:a|an)\\s+(?:day|week|month|hour)(?![\\p{L}])',
    `(?<![\\p{L}])(?:${fa})\\s+(?:روز|هفته|ماه|ساعت)`,
    han,
  ].join('|');
}

/** Every spelled duration, the vague and the asking ones included — what G2 judges as a promise. */
export const SPELLED_DURATION_SRC = spelledDurationSrc(true);
/** …and the ones that state a count — what G1 refuses as a figure it cannot source. */
const SPELLED_DURATION = new RegExp(spelledDurationSrc(false), 'iu');
const HAN_SPELLED_DURATION = new RegExp(`[${HAN_ANY}]*[${HAN_DIGITS}][${HAN_ANY}]*${HAN_UNIT}`, 'u');

/**
 * A spelled duration whose count ASKS (P5): «necha kunda», «неча кун», «چند روز», «几天» — never «bir
 * necha» (a few), which states a count, however vague. Read on the text of one `SPELLED_DURATION_SRC` match.
 */
export const ASKING_DURATION = /^(?:necha|неча|چند)\s|^几/iu;

/**
 * A spelled duration (one `SPELLED_DURATION_SRC` match) whose count is VAGUE — «bir necha kun», «несколько
 * дней», «a couple of days» — neither a count G1 refuses as a figure, nor a question (second review: where the
 * cargo comes in it, policy.ts refuses it all the same, `vagueTravelTime`).
 */
export function vagueDuration(match: string): boolean {
  return !SPELLED_DURATION.test(match) && !ASKING_DURATION.test(match);
}

/** A Chinese numeral run right beside money: «价格是三百», «三百美金» — `MONEY_OR_MEASURE` has «元» and «块» already. */
const HAN_RUN = '[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]+';
const HAN_BESIDE_MONEY = new RegExp(
  `(?:${alt(PRICE_HAN)})(?:是|为|：|:)?\\s*${HAN_RUN}|${HAN_RUN}\\s*(?:${alt(CURRENCY_HAN)})`,
  'u',
);

/** A text's words, as the word-numeral check reads its neighbours — a comma is a token, «m³» (folded «m3») one word. */
const TOKEN = /[\p{L}\p{M}'‘’ʻ`.\-]+(?:[23](?!\d))?|[$€¥£₽₸₺؋]|[,，]/gu;
const NUMERAL_TOKEN = new RegExp(`^(?:bir[-–])?(?:${NUMERAL_WORDS})(?:[-–](?:${NUMERAL_WORDS}))*[.,]?$`, 'iu');
/** «besh yarim», «два с половиной» — the half that goes on a spelled figure. */
const HALF_TOKEN = /^(?:yarim|ярим|половин\p{L}*|half)[.,]?$/iu;
/**
 * Words that stand between a price word and its figure without changing whose figure it is: «narxi esa besh
 * yuz», and a hedge — «Narxi taxminan uch yuz bo'ladi» is a price spelled out all the same.
 */
const COPULA =
  /^(?:is|are|was|will|be|of|about|around|approximately|roughly|это|будет|составит|составляет|примерно|около|esa|edi|bo['‘’ʻ`]?ladi|taxminan|тахминан|است|هست|حدود\p{L}*|تقریبا\p{L}*)$/iu;
/** The classifier between a count and its thing — «uch ta karobka»; on its own it names nothing counted. */
const CLASSIFIER = /^(?:ta|та|tadan|тадан)[.,]?$/iu;
/** A per-unit word between a unit and its price: «kub uchun ikki yuz», «kg ga o'n yetti», «kub hisobida uch». */
const PER_TOKEN = /^(?:uchun|учун|ga|га|hisobida|hisobda|ҳисобида|ҳисобда|за|per|each|for|по)[.,]?$/iu;

/**
 * What a spelled numeral counts when it counts no figure (review): a thanks — «Ming rahmat» — and kinds,
 * ways, options, things, questions — «ikki xil yo'l», «uch narsa», «два варианта», «two options». Read on
 * the word right after the run; such a run is no figure, whatever stands beside it.
 */
const NOT_A_FIGURE = new RegExp(
  `^(?:${[
    'rahmat\\p{L}*',
    'raxmat\\p{L}*',
    'раҳмат\\p{L}*',
    'рахмат\\p{L}*',
    'благодарност\\p{L}*',
    'спасибо',
    'xil\\p{L}*',
    'хил\\p{L}*',
    "yo['‘’ʻ`]?l(?:i|ni|dan|da|ga|lar\\p{L}*)?",
    'йўл(?:и|ни|дан|да|га|лар\\p{L}*)?',
    'variant\\p{L}*',
    'вариант\\p{L}*',
    'usul\\p{L}*',
    'усул\\p{L}*',
    'narsa\\p{L}*',
    'нарса\\p{L}*',
    'savol\\p{L}*',
    'савол\\p{L}*',
    'turdagi',
    'турдаги',
    'вид(?:а|ов)?',
    'способ\\p{L}*',
    'вопрос\\p{L}*',
    'kinds?',
    'types?',
    'ways?',
    'options?',
    'things?',
    'questions?',
    'choices?',
    'راه\\p{L}*',
    'نوع',
  ].join('|')})[.,:]?$`,
  'iu',
);
/** The only words that free a hundred or a thousand: a thanks — «Ming rahmat», «Тысяча благодарностей», «a thousand thanks». */
const TIMES = /^(?:marta|bor|марта|бор|раз|times)[.,]?$/iu;
const THANKS = /^(?:rahmat\p{L}*|raxmat\p{L}*|раҳмат\p{L}*|рахмат\p{L}*|благодарност\p{L}*|спасибо|thanks?)[.,:!]?$/iu;

/** A per-unit price anywhere in a sentence: «kub uchun», «kilosiga», «за один куб», «per kg». */
const MEASURE_UNIT = '(?:kub\\p{L}*|куб\\p{L}*|kg|кг|kilo\\p{L}*|кило\\p{L}*|cbm|m3|м3|tonn\\p{L}*|тонн\\p{L}*|tons?)';
const PER_UNIT_PRICE = new RegExp(
  `(?<![\\p{L}])(?:${MEASURE_UNIT}\\s*(?:uchun|учун|ga|га)|kub(?:i)?ga|kilo(?:si)?ga|куб(?:и)?га|кило(?:си)?га|за\\s+(?:(?:один|одну|1)\\s+)?${MEASURE_UNIT}|(?:per|each|every|a)\\s+${MEASURE_UNIT})(?![\\p{L}])`,
  'iu',
);
/** A currency named anywhere in a sentence — the test of `CURRENCY_ANYWHERE`, once. */
const CURRENCY_NAMED = new RegExp(CURRENCY_ANYWHERE.source, 'iu');

/** What cargo is weighed or sized in — the measure half of `MONEY_OR_MEASURE`, spelled as a whole token's; the first of `UNIT_TOKEN`'s units. */
const MEASURE_UNITS = [
  'kub\\p{L}*',
  'куб\\p{L}*',
  'kg',
  'кг',
  'kilo\\p{L}*',
  'кило\\p{L}*',
  'gramm?\\p{L}*',
  'грамм?\\p{L}*',
  'tonn\\p{L}*',
  'тонн\\p{L}*',
  'tons?',
  'metr\\p{L}*',
  'метр\\p{L}*',
  'met(?:er|re)s?',
  'm[23]',
  'м[23]',
  'cbm',
  'cub(?:e|es|ic)',
  'kilograms?',
  'کیلو\\p{L}*',
  'متر',
];
/**
 * The unit a spelled figure is a count OF (incident 2026-10-29) — a measure, a time, a percent, a thing
 * cargo comes in — as one whole token. Cubes, kilos and tonnes; days, weeks, months, hours, minutes; the
 * cartons, pieces and places of `COUNT_UNIT` (numbers.ts) that are cargo's own, never «xil» («ikki xil
 * yo'l» is two kinds of road) nor a bare «ta» («ikki ta narsa» is two things).
 */
const UNIT_TOKEN = new RegExp(
  `^(?:${[
    ...MEASURE_UNITS,
    'kun\\p{L}*',
    'кун\\p{L}*',
    'hafta\\p{L}*',
    'ҳафта\\p{L}*',
    'oy(?:da|ga|dan|ni|ning|lik|cha|i\\p{L}*|lar\\p{L}*)?',
    'ой(?:да|га|дан|ни|нинг|лик|ча|и\\p{L}*|лар\\p{L}*)?',
    'soat\\p{L}*',
    'соат\\p{L}*',
    'daqiqa\\p{L}*',
    'дақиқа\\p{L}*',
    'sutka\\p{L}*',
    'дн(?:я|ей|ям|ях)',
    'день',
    'сут(?:ки|ок)',
    'недел\\p{L}*',
    'месяц\\p{L}*',
    'час(?:а|ов)?',
    'минут\\p{L}*',
    'days?',
    'weeks?',
    'months?',
    'hours?',
    'minutes?',
    'foiz\\p{L}*',
    'фоиз\\p{L}*',
    'процент\\p{L}*',
    'percent',
    'karobka\\p{L}*',
    'korobka\\p{L}*',
    'quti\\p{L}*',
    'қути\\p{L}*',
    'коробк\\p{L}*',
    'коробок',
    'dona\\p{L}*',
    'дона\\p{L}*',
    'шт\\p{L}*',
    'штук\\p{L}*',
    'mesta',
    'мест\\p{L}*',
    'box(?:es)?',
    'cartons?',
    'pieces?',
    'pcs',
    'pallet\\p{L}*',
    'паллет\\p{L}*',
    'poddon\\p{L}*',
    'поддон\\p{L}*',
    'روز',
    'هفته',
    'ماه',
    'ساعت',
    'دقیقه',
    'کارتن',
    'جعبه',
  ].join('|')})[.,]?$`,
  'iu',
);

/**
 * A word numeral RIGHT beside what it counts: a price word before its run (past one copula) or in the two
 * after; or a unit — a measure, a time, a percent, a carton (`UNIT_TOKEN`) — the token before the run or
 * the one after it (past a classifier «ta»). The package read the price words across the whole text, so
 * «Narxni aytish uchun ikki narsa kerak» was a spelled-out figure (fix round); and it read a measure word
 * across the whole text too, so «Ming rahmat! … necha kub va necha kg?», «Ikki xil yo'l bor: … kg», «Bizda
 * uch xil xizmat bor … kub» — a thanks, two kinds, three services, in a reply that asks for the cubes —
 * each lost their ✅ (incident 2026-10-29). «besh kub», «yuz dollar», «ikki hafta», «uch ta karobka», «три
 * куба» still block.
 *
 * The review found that neighbour test too narrow on both sides. A rate is written «Har kub uchun ikki yuz»,
 * «Yo'lkira kub uchun taxminan uch yuz», «kg ga o'n yetti», «За куб примерно триста» — a per-unit word and
 * a hedge between the unit and its price — and «Narxi esa, besh yuz» puts a comma between the price word and
 * its figure; each passed as no figure at all. So a unit counts past a per-unit word and a copula, a price
 * word past one comma; and a run in the same SENTENCE as a currency or a per-unit price — «Hammasi bo'lib
 * taxminan ikki ming, dollar hisobida», «Доставка за один куб обойдётся в триста» — is a price spelled out
 * wherever its commas fall. Only the words AFTER the run stop at a comma: «Ming rahmat, narxni…» is a thanks.
 * A run that counts kinds, ways or things, or thanks (`NOT_A_FIGURE`), is no figure beside anything.
 */
function numeralBesideUnit(normalized: string): boolean {
  return normalized.split(SENTENCE_BREAK).some(beside);
}

/**
 * Where a word stops being a numeral's neighbour: a sentence's end. «Ming rahmat! Narxni aytishim uchun…»
 * read «rahmat Narxni» as the two words after «ming», and a thanks became a price spelled out. A comma is
 * a token of its own (`TOKEN`): what comes AFTER a run stops at it, a price word before it does not.
 */
const SENTENCE_BREAK = /[!?؟。！？\n;；]+|\.(?=\s|$)/u;
const isComma = (token: string) => token === ',' || token === '，';

/**
 * Each spelled run of a statement's tokens that may be a figure, as [first, last]: its numerals and their
 * «yarim», never a run that counts kinds, ways, things or thanks (`NOT_A_FIGURE`).
 */
function* figureRuns(tokens: readonly string[]): Generator<[number, number]> {
  for (let i = 0; i < tokens.length; i += 1) {
    if (!NUMERAL_TOKEN.test(tokens[i]!)) continue;
    let j = i;
    while (j + 1 < tokens.length && (NUMERAL_TOKEN.test(tokens[j + 1]!) || HALF_TOKEN.test(tokens[j + 1]!))) j += 1;
    const after = tokens[j + 1];
    if (after === undefined || !NOT_A_FIGURE.test(after)) yield [i, j];
    i = j;
  }
}

function beside(sentence: string): boolean {
  const tokens = sentence.match(TOKEN) ?? [];
  const priced = CURRENCY_NAMED.test(sentence) || PER_UNIT_PRICE.test(sentence);
  for (const [i, j] of figureRuns(tokens)) {
    const after = tokens[j + 1];
    if (priced) return true;
    // A price word before the run — past two copulas and one comma: «narxi esa besh yuz», «Narxi esa, besh yuz».
    let b = i - 1;
    let commas = 0;
    while (b >= 0 && b >= i - 3) {
      if (isComma(tokens[b]!)) commas += 1;
      else if (!COPULA.test(tokens[b]!)) break;
      if (commas > 1) break;
      b -= 1;
    }
    if (b >= 0 && MONEY_WORD.test(tokens[b]!)) return true;
    // …or in the two words after it, inside its clause.
    const two = tokens.slice(j + 1, j + 3);
    const cut = two.findIndex(isComma);
    if (MONEY_WORD.test((cut === -1 ? two : two.slice(0, cut)).join(' '))) return true;
    // A unit right before the run — past a per-unit word and a copula: «kub uchun taxminan uch yuz».
    let u = i - 1;
    while (u >= 0 && u >= i - 3 && (COPULA.test(tokens[u]!) || PER_TOKEN.test(tokens[u]!))) u -= 1;
    if (u >= 0 && UNIT_TOKEN.test(tokens[u]!)) return true;
    // …or right after it, past a classifier «ta».
    const next = after !== undefined && CLASSIFIER.test(after) ? tokens[j + 2] : after;
    if (next !== undefined && UNIT_TOKEN.test(next)) return true;
  }
  return false;
}

/**
 * …and the door the neighbour test stands BESIDE. The package's rule was the whole reply: a word numeral
 * anywhere in a text that names money or a measure anywhere. The incident narrowed it to the numeral's own
 * neighbours, and the second review measured prices spelled out passing on the gap — a noun between the unit and
 * its price («3 kub yukingiz uchun besh yuz atrofida bo'ladi»), a total with no unit, the price word on the
 * heading above, the currency a sentence back. It put the old door back in two widths, keyed on the WORDS around
 * the numeral, and the third review measured both widths wrong. Narrow: the same price passed once the measure
 * stood after it, a sentence earlier, or above a heading that does not end in «:» («Taxminan ming ikki yuz
 * chiqadi, 3 kub yukingiz uchun», «Ваши 3 куба посчитал. Получится около тысячи двухсот», «Narx\nming ikki yuz»),
 * and with no money word at all on every tree («Avto bilan ming ikki yuz atrofida, avia bilan esa besh yuz»).
 * Wide: the greetings lost their ✅ on a currency or a measure beside a COUNT — «Narxni dollarda aytaman. Uch
 * omborimizdan qaysi biriga yetkazasiz?», «Мне нужно всего две вещи», «Yukingiz necha kub, necha kg va uch
 * omborimizdan…».
 *
 * So the door is keyed on the NUMERAL itself. A hundred, a thousand, a ten or a teen (`SCALE_WORD`, `TENS_WORD`)
 * is a figure in ANY reply, as its digits would be — the reply is told to write figures in digits, and «ming ikki
 * yuz» in this chat is a price or a count nothing vouches for; only a thanks frees it («Ming rahmat», «Тысяча
 * благодарностей»). A bare «ming», «сто», «тысяча», «hundred» standing alone is a figure where the reply names
 * money or a measure, as the package had it; a bare «yuz» only beside what it counts (`LONE_FACE`). A small count
 * — two to nine — is what greetings count, kinds and warehouses and questions, and only `numeralBesideUnit`
 * judges it.
 */
function numeralInPricedReply(normalized: string): boolean {
  const priced = CURRENCY_NAMED.test(normalized) || MONEY_OR_MEASURE.test(normalized) || MONEY_WORD.test(normalized);
  for (const sentence of normalized.split(SENTENCE_BREAK)) {
    const tokens = sentence.match(TOKEN) ?? [];
    for (let i = 0; i < tokens.length; i += 1) {
      if (!NUMERAL_TOKEN.test(tokens[i]!)) continue;
      let j = i;
      while (j + 1 < tokens.length && (NUMERAL_TOKEN.test(tokens[j + 1]!) || HALF_TOKEN.test(tokens[j + 1]!))) j += 1;
      const run = tokens.slice(i, j + 1);
      const after = tokens[j + 1];
      i = j;
      // «Ming rahmat», and «Ming marta rahmat», «ming bor rahmat», «тысячу раз спасибо» — a thousand times thanks.
      const thanked = after !== undefined && (THANKS.test(after) || (TIMES.test(after) && THANKS.test(tokens[j + 2] ?? '')));
      if (thanked) continue;
      const parts = run.flatMap((t) => t.replace(/[.,]$/u, '').split(/[-–]/u)).filter((w) => w !== '' && !/^bir$/iu.test(w));
      const large = parts.some((w) => SCALE_WORD.test(w) || TENS_WORD.test(w));
      if (!large) continue;
      if (parts.length === 1 && LONE_FACE.test(parts[0]!)) continue;
      if (parts.length === 1 && LONE_SCALE.test(parts[0]!) && !priced) continue;
      return true;
    }
  }
  return false;
}

/**
 * «Bir daqiqa», «бир дақиқа» opening a sentence is «one moment», not a time we give (review): «Bir daqiqa,
 * hozir aniqlab beraman» lost its ✅ as a spelled-out duration, while «Одну минуту» never did. Only standing
 * alone — at a sentence's head, followed by its comma or «kuting» / «hozir»: «Bir daqiqada hisoblab
 * beraman» is a time all the same.
 */
const ONE_MOMENT =
  /(?<=(?:^|[.!?\n])\s*)(?:bir|бир)\s+(?:daqiqa|soniya|minut|дақиқа|сония|минут)(?=\s*[,!.…—–-]|\s+(?:kuting|кутинг|hozir|ҳозир|iltimos|илтимос)(?![\p{L}]))/giu;

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
  // «narxi besh yuz» names no currency and is still a price spelled out; «besh kub» a measure.
  if (numeralBesideUnit(normalized) || numeralInPricedReply(normalized)) return 'word_numeral';
  if (NINE_FA.test(normalized) || SPELLED_DURATION.test(normalized.replace(ONE_MOMENT, ' '))) return 'word_numeral';
  return null;
}
