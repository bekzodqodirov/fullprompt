import { CURRENCY_AFTER_SRC, CURRENCY_BEFORE_SRC, MONEY_WORD, normalizeDigits } from './digits';

/**
 * G1 by KIND and SOURCE (review money-1).
 *
 * The first design asked whether a number's VALUE was in a set of «allowed»
 * values — and the set held the persona phone's 998/95/018, the kb's street
 * numbers and the customer's own «90 qilib bering», so any of them could be
 * printed beside «$» as a price and pass. A number is now read with the word
 * beside it: money, a measure, a duration, a date, a count, a percent, or a
 * bare figure. A MONEY number passes only when a MONEY source of this run
 * holds it (the yo'lkira tool's figure, the customer's own balance, the offer
 * he typed); a measure only from a measure source (the customer's message, a
 * tool); and so on. Phones and approved links are taken out WHOLE before any
 * of this, so their digits are never figures.
 *
 * Pure. Every card prints the ledger this builds — each figure beside the
 * source that let it through — so the owner sees what he is approving.
 *
 * The review measured the word-beside rule failing three ways (P1): a
 * currency of more than one word («90 AQSH dollari», «300 US dollars») or one
 * it did not list («480 евро», «480 RMB», «480 у.е.») left the figure bare; a
 * figure GLUED to its currency («USD480», «Jami-480$») was skipped as a code;
 * and a figure whose currency sat elsewhere in the sentence («Narx (dollarda):
 * 480») was bare too — and a bare figure passes on the customer's own «480 kg».
 * So a currency is read in every spelling and glued as well as spaced, a scale
 * word is part of its figure («1,5 mln so'm» is 1 500 000), and in a text that
 * names money ANYWHERE every bare figure is money: in a reply it then needs a
 * money source, in a customer's or a fact's text it is `customer_money` and
 * vouches for nothing.
 */

export type NumberKind = 'money' | 'measure' | 'duration' | 'date' | 'count' | 'percent' | 'plain';

export interface FoundNumber {
  raw: string;
  value: number;
  kind: NumberKind;
  index: number;
}

/**
 * Who said a figure (policy review B3): a tool of this run, an approved kb
 * fact, or the customer. Without it a customer's own «5 kunda kelsinmi?»
 * backed the reply's «Odatda 5 kunda yetib keladi» — his wish, worded as our
 * estimate, passed G1 — and a fact's «15–25 kun» could not be told from his.
 */
export type SourceOrigin = 'tool' | 'kb' | 'customer';

export interface NumberSource {
  value: number;
  /** The kind this source vouches for. A customer's money figure is never a money source (`customer_money`). */
  kind: NumberKind | 'customer_money';
  /** Shown on the card's «🔢 Raqamlar» line. */
  label: string;
  /**
   * Absent reads as the CUSTOMER's — fails closed. Optional only because a
   * memory stored before B3 carries none, and the 💵 draft (calc-loop.ts),
   * whose words are his and never pass `checkAgentReply`, still writes one
   * without it.
   */
  origin?: SourceOrigin;
  /**
   * The road a DURATION is the time of (fix round): the avia tool's and the
   * avia fact's «2–5 kun» are a flight's, the website's and the transit
   * fact's «15–25 kun» a truck's. Every chat's memory carries both seeded
   * facts, so without it «Odatda mashina bilan 5 kunda yetib keladi» was
   * backed by the AVIA fact's five. Absent = said of no road in particular.
   */
  mode?: TravelMode;
}

/** How cargo travels — the three roads a day count can be the time of. */
export type TravelMode = 'air' | 'road' | 'rail';

/**
 * The words that name each road, in the six languages. «Avto» and «авто» are
 * the road's — but not «avtomat», «автор». A truck carries goods that are
 * machines too («kir yuvish mashinasi»); that reads as the road, which can
 * only make a flight's figure unusable, never the reverse.
 */
const MODE_WORDS: Record<TravelMode, RegExp> = {
  air: /(?<![\p{L}])(?:avia\p{L}*|samol[yi]?ot\p{L}*|авиа\p{L}*|самол[её]т\p{L}*|air(?:freight|cargo)?|by\s+air|flights?|plane)(?![\p{L}])|هوایی|هواپیما|空运|航空|飞机/iu,
  road: /(?<![\p{L}])(?:mashina\p{L}*|avto(?![mr])\p{L}*|avtomobil\p{L}*|fura\p{L}*|машин\p{L}*|авто(?![мр])\p{L}*|автомобил\p{L}*|фур[аыуе]\p{L}*|trucks?|trucking|by\s+road|road\s+freight)(?![\p{L}])|کامیون|زمینی|汽运|陆运|卡车|汽车/iu,
  rail: /(?<![\p{L}])(?:temir\s*yo['‘’ʻ`]?l\p{L}*|poyezd\p{L}*|темир\s*йўл\p{L}*|поезд\p{L}*|железн\p{L}*\s+дорог\p{L}*|ж\/д|rail\p{L}*|trains?)(?![\p{L}])|قطار|راه\s*آهن|铁路|火车/iu,
};

/** The one road a text names, or null — none, or more than one. */
export function oneModeIn(text: string): TravelMode | null {
  const named = (Object.keys(MODE_WORDS) as TravelMode[]).filter((m) => MODE_WORDS[m].test(text));
  return named.length === 1 ? named[0]! : null;
}

/** A figure's road: the one its clause names, else its sentence's, else the whole text's — or null. */
function modeAt(text: string, index: number): TravelMode | null {
  const span = (boundary: RegExp): string => {
    let start = 0;
    let end = text.length;
    for (const m of text.matchAll(boundary)) {
      if (m.index + m[0].length <= index) start = m.index + m[0].length;
      else if (m.index >= index) {
        end = m.index;
        break;
      }
    }
    return text.slice(start, end);
  };
  // A comma or a dash between two digits is inside a figure («1,5», «15–25»), not between clauses.
  const clause = /(?<!\d)[,—–]|[,—–](?!\d)|[;:!?؟。！？\n]+|\.(?=\s|$)|\s-\s/gu;
  return oneModeIn(span(clause)) ?? oneModeIn(span(/[!?؟。！？\n]+|\.(?=\s|$)/gu)) ?? oneModeIn(text);
}

export interface LedgerEntry {
  raw: string;
  kind: NumberKind;
  /** The source that let it through, or null — a null is a G1 block. */
  source: string | null;
}

/** A phone in any spelling: an optional +, then ≥ 9 digits with spaces, dashes, dots or brackets between. */
export const PHONE_RE = /\+?\d(?:[\s\-.()]*\d){8,}/gu;

/** Digits only — how two phones are compared. */
export function phoneDigits(raw: string): string {
  return raw.replace(/\D/gu, '');
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9-]+\.(?:uz|ru|com|cn|net|org|io|me|app|ir|af)\/[^\s<>()]*/giu;

export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,!?)»]+$/u, ''));
}

/** «480 $», «480 AQSH dollari», and «500-dollarlik» — Uzbek hangs a case or suffix on a figure with a hyphen. */
const MONEY_AFTER = new RegExp(`^\\s*-?(?:${CURRENCY_AFTER_SRC})`, 'iu');
/** The currency touching the figure, no space: «480$», «480usd» — a glued figure is money, never a code. */
const MONEY_GLUED_AFTER = new RegExp(`^(?:${CURRENCY_AFTER_SRC})`, 'iu');
const MONEY_BEFORE = new RegExp(`(?:${CURRENCY_BEFORE_SRC})\\s*:?\\s*$`, 'iu');
/** The letters glued before a figure are a currency, not a code prefix: «USD480», «RMB480», «US480». */
const MONEY_GLUED_BEFORE = new RegExp(`(?:${CURRENCY_BEFORE_SRC}|(?<![\\p{L}])us)$`, 'iu');
const MEASURE_AFTER =
  /^\s*(?:kg\b|кг\b|kilo\w*|кило\w*|kub\w*|куб\w*|m3\b|м3\b|m³|м³|m2\b|м2\b|tonna\w*|тонн\w*|公斤|千克|吨|立方|کیلو\w*|متر\s*مکعب|کیلوگرم)/iu;
/**
 * The word a day count is written with. A working or a calendar day is a
 * day too (fix round): «5 ish kunida», «через 5 рабочих дней», «in 5
 * business days», «5 sutkada» read as bare figures, a bare figure takes any
 * source — the customer's own «5 kunda kelsinmi?» among them — and G2 saw no
 * duration to judge.
 */
const DURATION_AFTER =
  /^\s*(?:(?:ish|иш)\s+(?:kun\w*|кун\w*)|(?:рабоч|календарн)\p{L}*\s+(?:дн\p{L}*|день|сут\p{L}*)|(?:business|working|calendar)\s+day\w*|个?工作(?:日|天)|kun\w*|кун\w*|день|дн[яейь]\w*|сут\w*|sutka\w*|day\w*|天|日|روز|hafta\w*|ҳафта\w*|недел\w*|week\w*|周|星期|هفته|soat\w*|соат\w*|час\w*|hour\w*|小时|ساعت|oy\b|ой\b|месяц\w*|month\w*|个月|ماه|daqiqa\w*|дақиқа\w*|минут\w*|minute\w*|分钟|دقیقه)/iu;
const COUNT_AFTER =
  /^\s*(?:ta\b|та\b|dona\w*|дона\w*|шт\w*|штук\w*|pcs\b|piece\w*|karobka\w*|коробк\w*|box\w*|carton\w*|件|个|箱|عدد|کارتن|جعبه|mesta\b|мест\w*|joy\b|quti\w*|қути\w*)/iu;
const PERCENT_AFTER = /^\s*(?:%|٪|foiz\w*|фоиз\w*|процент\w*|percent\w*)/iu;
/**
 * A month after a day. Each stem ends where its month does (policy review B4):
 * «2 marta» is TWICE, not the second of March, so «Mashina haftada 2 marta
 * chiqadi» asked for a date source; «5 maydon» is no May, «5 майка» is five
 * T-shirts, «2 separate boxes» no September, and the English stems are words
 * of their own, never the head of «marta», «market», «decimal».
 *
 * The fix round found the same trap three more ways, and the opposite one:
 *  - «mayda» / «майда» is also the Uzbek «small» — «30 mayda quti» is thirty
 *    small boxes, and as a date it was a figure only the company could vouch
 *    for, so the customer's own count could not be repeated back: before a
 *    thing that is counted it is no May;
 *  - the Uzbek Cyrillic «2 марта» is «twice» where the Russian is «of March»:
 *    in a text that writes the Uzbek letters (ў қ ғ ҳ) it is no date, and
 *    «мартаба» never is one;
 *  - «Box 2 may arrive» is the English modal before its verb;
 *  - and the other way, «5-mayigacha», «5-mayni», «5-майигача» (the
 *    possessive and the accusative) and «sentyabr», «oktyabr» (the common
 *    Latin spellings) ARE dates — read as bare figures they took any source.
 */
const MAY_ENDING = '(?:i(?:ga|gacha|dan|da|ning|ni)?|ni|da|dan|ga|gacha|ning)?';
const MAY_ENDING_CYRL = '(?:и(?:га|гача|дан|да|нинг|ни)?|ни|да|дан|га|гача|нинг)?';
/** What «mayda» means «small» before, and what English «may» is a modal before. */
const NOT_MAY_AFTER =
  '(?:-?\\s*(?:chuyda|чуйда)|\\s+(?:quti|karobka|korobka|yuk|tovar|posilka|paket|narsa|detal|qism|buyum|қути|коробк|юк|товар|посилка|пакет|нарса|детал|қисм|буюм)|' +
  '\\s+(?:be|not|arrive|take|need|come|have|get|vary|change|cost|differ|require|depend|reach|leave|also|still|only|already|apply|exceed|include|contain|weigh)(?![\\p{L}]))';
const MONTH_AFTER = new RegExp(
  '^\\s*-?\\s*(?:(?:yanvar|fevral|mart(?!a)|aprel|' +
    `may${MAY_ENDING}(?![\\p{L}])(?!${NOT_MAY_AFTER})|` +
    'iyun|iyul|avgust|sent(?:y)?abr|okt(?:y)?abr|noyabr|dekabr|январ|феврал|март(?!аба)|апрел|' +
    `ма(?:я|й${MAY_ENDING_CYRL})(?![\\p{L}])(?!${NOT_MAY_AFTER})|` +
    'июн|июл|август|сентябр|октябр|ноябр|декабр)|' +
    '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![\\p{L}])|月)',
  'iu',
);
/** The Uzbek Cyrillic «марта» — «times» — after a figure, in a text that writes the Uzbek letters. */
const UZ_CYRL_TIMES = /^\s*марта(?![\p{L}])/iu;
const UZ_CYRL_LETTERS = /[ўқғҳ]/iu;

/** A range: «15-25 kun», «15 dan 25 gacha», «15 до 25». The unit after the second number names both. */
const RANGE_TAIL = /^\s*(?:[-–—~]|dan|до|to|تا|到|至)\s*\d+(?:[.,]\d+)?(?:\s*(?:gacha|гача))?/iu;

/**
 * A scale word after a figure is part of it: «1,5 mln so'm» is 1 500 000 and
 * must not pass on a $1.5 tariff, and «480 ming» is money even with no
 * currency — in this business nobody counts cartons in thousands without
 * saying so («5 ming dona» stays a count). «k» only GLUED («10k», «10к»):
 * spaced it is not how anyone writes it, and «10кг» is a weight.
 */
const SCALES: readonly (readonly [RegExp, number])[] = [
  [/^[kк](?![\p{L}])/iu, 1e3],
  [/^\s*(?:ming(?:dan|ga|lik)?|минг\p{L}*|тыс(?:яч\p{L}*|\.)?|тыщ\p{L}*|thousand\p{L}*|هزار)(?![\p{L}])/iu, 1e3],
  [/^\s*(?:million\p{L}*|миллион\p{L}*|mln\.?|млн\.?|میلیون)(?![\p{L}])/iu, 1e6],
  [/^\s*(?:mlrd\.?|milliard\p{L}*|billion\p{L}*|миллиард\p{L}*|млрд\.?)(?![\p{L}])/iu, 1e9],
  // Han has no word edges: «2千元» is 2 000 yuan, «3万» 30 000.
  [/^\s*百万/u, 1e6],
  [/^\s*亿/u, 1e8],
  [/^\s*万/u, 1e4],
  // …but «千克» is a kilogram and «千米» a kilometre: there 千 is the unit's, not a thousand (fix round:
  // «500千克» read as 500 000 of money, and a Chinese customer's weight stopped vouching for itself).
  [/^\s*千(?![克米瓦伏])/u, 1e3],
];

/**
 * «стоит 480», «будет стоить 480» — the price verb right before a bare figure. Not a money word for the
 * whole text: «стоит» is also «stands», and «Машина стоит на границе, в очереди 15» is a status line.
 */
const PRICE_VERB_BEFORE =
  /(?<![\p{L}])(?:сто(?:ит|ят|ить|ило|ила|или|ил)|обойд[её]тся|обойдутся)\s+(?:(?:всего|около|примерно|только|лишь)\s+)?$/iu;

/**
 * Figures whose FORM says what they are, so a money word elsewhere in the text never makes them money:
 * an Uzbek ordinal glued to its noun («3-ko'chada», «2-omborda», «15-uy» — but not a case ending on a
 * cardinal, «480-ga»), and an hour of the day after «soat» («soat 9 dan 18 gacha»). Before this a fact
 * «To'lov naqd, ombor 3-ko'chada» read as a price and the kb refused it.
 */
// Latin only: a Russian «480-ти долларов» hangs a CARDINAL's case on the hyphen, and must stay money.
const ORDINAL_AFTER = /^-(?!(?:ga|da|dan|ni|ning|gacha|cha|lik|dek|ta|tadan|tasi|tagacha)(?![\p{L}]))[a-z]/iu;
const HOUR_BEFORE = /(?<![\p{L}])(?:soat|соат|ساعت)\s*(?:\d{1,2}(?:[.:]\d{2})?\s*(?:dan|дан|-|–|—|تا)\s*)?$/iu;

/** A figure as written: thousands by space, comma or dot groups of three, decimals by dot or comma. */
const NUMBER_RE = /\d{1,3}(?:[ ,. ]\d{3})+(?![\d])(?:[.,]\d+)?|\d+(?:[.,]\d+)?/gu;
/** dd.mm(.yyyy) with a two-digit month — the spelling every date the system prints uses («dd.MM»). */
const DATE_RE = /(?<!\d)(\d{1,2})[./](\d{2})(?:[./](\d{2,4}))?(?!\d)/gu;
const TIME_RE = /(?<!\d)\d{1,2}:\d{2}(?!\d)/gu;

/** «1 200», «1,200», «1.200» → 1200; «1,5» → 1.5; «330.50» → 330.5. */
export function parseFigure(raw: string): number {
  const s = raw.replace(/ /gu, ' ');
  // Groups of exactly three after a separator are thousands.
  if (/^\d{1,3}(?:[ ,.]\d{3})+$/u.test(s)) return Number(s.replace(/[ ,.]/gu, ''));
  const grouped = /^(\d{1,3}(?:[ ,.]\d{3})+)([.,]\d+)$/u.exec(s);
  if (grouped) return Number(`${grouped[1]!.replace(/[ ,.]/gu, '')}.${grouped[2]!.slice(1)}`);
  return Number(s.replace(',', '.'));
}

interface Reading {
  kind: NumberKind;
  /** 1, or the scale word's factor. */
  scale: number;
  /** The scale word as written right after the figure («mln»), for the ledger's `raw`; '' when none or after a range. */
  scaleText: string;
}

/** The word beside a figure — before it, after it, after its range and its scale word. */
function readAt(text: string, start: number, end: number): Reading {
  let tail = text.slice(end, end + 48);
  const range = RANGE_TAIL.exec(tail);
  if (range) tail = tail.slice(range[0].length);
  let scale = 1;
  let scaleText = '';
  for (const [re, factor] of SCALES) {
    const m = re.exec(tail);
    if (!m) continue;
    scale = factor;
    if (!range) scaleText = m[0];
    tail = tail.slice(m[0].length);
    break;
  }
  const at = (kind: NumberKind): Reading => ({ kind, scale, scaleText });
  if (MONEY_BEFORE.test(text.slice(Math.max(0, start - 12), start))) return at('money');
  if (PERCENT_AFTER.test(tail)) return at('percent');
  if (MONEY_AFTER.test(tail)) return at('money');
  if (MEASURE_AFTER.test(tail)) return at('measure');
  if (DURATION_AFTER.test(tail)) return at('duration');
  if (MONTH_AFTER.test(tail) && !(UZ_CYRL_TIMES.test(tail) && UZ_CYRL_LETTERS.test(text))) return at('date');
  if (COUNT_AFTER.test(tail)) return at('count');
  // «480 ming», «1,5 mln» with no unit: a scaled figure is money.
  return at(scale === 1 ? 'plain' : 'money');
}

function kindAt(text: string, start: number, end: number): NumberKind {
  return readAt(text, start, end).kind;
}

/** The text as the figures are read: digits folded, the given strings, links and phones blanked out. */
function blanked(text: string, removeWhole: readonly string[]): string {
  let t = normalizeDigits(text);
  for (const r of removeWhole) {
    const whole = r ? normalizeDigits(r) : '';
    if (whole) t = t.split(whole).join(' '.repeat(whole.length));
  }
  for (const u of urlsIn(t)) t = t.split(u).join(' '.repeat(u.length));
  return t.replace(PHONE_RE, (m) => ' '.repeat(m.length));
}

/** Whether a text names money anywhere — read after the phones and links are out: «gsrlogistics.uz/narxlar» names none. */
export function namesMoney(text: string): boolean {
  return MONEY_WORD.test(blanked(text, []));
}

/**
 * Every figure in a text, with its kind. `removeWhole` are strings taken out
 * before anything is read (the persona phone, an approved link) — whole, so
 * their digits are never figures. Phones are always taken out; the caller
 * judges them separately (G6). `moneyContext` says money was named around
 * this text, not in it — a customer's earlier «Narxi qancha?» (customerSources).
 */
export function extractNumbers(
  text: string,
  removeWhole: readonly string[] = [],
  opts: { moneyContext?: boolean } = {},
): FoundNumber[] {
  const t = blanked(text, removeWhole);
  const moneyText = opts.moneyContext === true || MONEY_WORD.test(t);
  const out: FoundNumber[] = [];
  const taken: [number, number][] = [];
  for (const m of t.matchAll(DATE_RE)) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    // «1.50 kg», «12.50 $» are figures with a unit, not the first of May.
    if (kindAt(t, m.index, m.index + m[0].length) !== 'plain') continue;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      out.push({ raw: m[0], value: day * 100 + month, kind: 'date', index: m.index });
      taken.push([m.index, m.index + m[0].length]);
    }
  }
  // A clock is a time of day whatever the text says — never upgraded to money below.
  for (const m of t.matchAll(TIME_RE)) {
    if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue;
    out.push({ raw: m[0], value: Number(m[0].replace(':', '.')), kind: 'plain', index: m.index });
    taken.push([m.index, m.index + m[0].length]);
  }
  for (const m of t.matchAll(NUMBER_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (taken.some(([a, b]) => start < b && end > a)) continue;
    // A digit glued to letters is part of a code («GS777», «B-000124»), not a figure — G6 judges codes.
    // Unless the letters ARE a currency, or a currency is glued on the other side: «USD480», «Jami-480$».
    const prev = t[start - 1];
    const after = t.slice(end, end + 24);
    const glued =
      MONEY_GLUED_AFTER.test(after) || (prev !== undefined && MONEY_GLUED_BEFORE.test(t.slice(Math.max(0, start - 12), start)));
    if (!glued && prev !== undefined && /[\p{L}]/u.test(prev) && !/[\p{Script=Han}]/u.test(prev)) continue;
    if (prev === '-' && /[\p{L}]/u.test(t[start - 2] ?? '') && !glued && !MONEY_AFTER.test(after)) continue;
    const read = readAt(t, start, end);
    const value = parseFigure(m[0]) * read.scale;
    if (!Number.isFinite(value)) continue;
    const before = t.slice(Math.max(0, start - 24), start);
    const fixed = ORDINAL_AFTER.test(after) || HOUR_BEFORE.test(before);
    const priced = PRICE_VERB_BEFORE.test(before);
    // In a text that names money anywhere, a bare figure is money (P1): «Narx (dollarda): 480».
    const kind: NumberKind =
      glued || (read.kind === 'plain' && !fixed && (moneyText || priced)) ? 'money' : read.kind;
    out.push({ raw: `${m[0]}${read.scaleText}`.trimEnd(), value, kind, index: start });
  }
  return out.sort((a, b) => a.index - b.index);
}

function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

/**
 * A price, a day count or a day in a reply is the COMPANY's word (B3): only a
 * tool of this run or an approved fact may vouch for it. The customer's own
 * «5 kunda kelsinmi?» is his wish, and «Odatda 5 kunda yetib keladi» on it
 * would be our estimate made of his number; a date is the same claim in
 * another shape, and G2 reads no dates. His kilos, cubes and cartons are his
 * to have repeated back.
 */
const COMPANY_KINDS: ReadonlySet<NumberKind> = new Set(['money', 'duration', 'date']);
const companySaid = (s: NumberSource) => s.origin === 'tool' || s.origin === 'kb';

/**
 * Which source lets a figure through, or null. A money figure needs a money
 * source and nothing else will do; every other kind takes a source of its
 * own kind, and a bare figure takes any source but the customer's money.
 */
export function sourceFor(
  found: FoundNumber,
  sources: readonly NumberSource[],
  mode: TravelMode | null = null,
): NumberSource | null {
  const fits = (s: NumberSource) => {
    if (!sameValue(s.value, found.value)) return false;
    if (s.kind === 'customer_money') return false;
    if (COMPANY_KINDS.has(found.kind) && !companySaid(s)) return false;
    // A day count said of one road is never vouched for by another road's: a truck's «5 kunda» on the
    // flight's five is a promise nobody made.
    if (found.kind === 'duration' && mode !== null && s.mode !== undefined && s.mode !== mode) return false;
    if (found.kind === 'money') return s.kind === 'money';
    if (found.kind === 'plain') return true;
    // A measure can be stated as a bare count of the same thing and vice versa.
    if (found.kind === 'count') return s.kind === 'count' || s.kind === 'measure' || s.kind === 'plain';
    return s.kind === found.kind || s.kind === 'plain';
  };
  return sources.find(fits) ?? null;
}

/**
 * The ledger for one text: each figure beside the source that let it through.
 * A day count takes the road its clause, its sentence or the text names, and
 * when the text names none, `askedMode` — the one road the customer asked
 * about: «Mashinada 5 kunda kelsinmi?» → «Odatda 5 kunda yetib keladi» is
 * the truck's time.
 */
export function numberLedger(
  text: string,
  sources: readonly NumberSource[],
  removeWhole: readonly string[] = [],
  askedMode: TravelMode | null = null,
): LedgerEntry[] {
  const t = blanked(text, removeWhole);
  return extractNumbers(text, removeWhole).map((f) => ({
    raw: f.raw,
    kind: f.kind,
    source: sourceFor(f, sources, f.kind === 'duration' ? (modeAt(t, f.index) ?? askedMode) : null)?.label ?? null,
  }));
}

/**
 * Sources from text the CUSTOMER wrote: every figure of theirs vouches for
 * itself as a measure, a count, a duration — but a money figure of theirs
 * («90$ qilib bering», «90 AQSH dollari», a bare «90» in a conversation that
 * asks the price) is a request, never a price we may repeat as ours, and never
 * a bare-number source either: «Mayli, 90 bo'ladi» agrees to it just the same.
 */
export function customerSources(texts: readonly { text: string; label: string }[]): NumberSource[] {
  // Bargaining spans messages: «Narxi qancha?», then «90 bo'lsa olaman». So money named in ANY of the
  // texts (the context window, AGENT_LIMITS.contextMessages) makes every bare figure in all of them money.
  const moneyContext = texts.some((t) => namesMoney(t.text));
  const out: NumberSource[] = [];
  for (const { text, label } of texts) {
    for (const f of extractNumbers(text, [], { moneyContext })) {
      out.push({ value: f.value, kind: f.kind === 'money' ? 'customer_money' : f.kind, label, origin: 'customer' });
    }
  }
  return out;
}

/**
 * Sources from ONE approved kb fact (B2). Each fact is read alone: the
 * payment fact names money, and read joined with the rest it made every bare
 * figure of every other fact — a street number, an hour — `customer_money`,
 * so the reply could not repeat the address the owner approved. A money
 * figure of a fact is still never a money source (money-9).
 */
export function factSources(text: string, label: string): NumberSource[] {
  const t = blanked(text, []);
  return extractNumbers(text).map((f): NumberSource => {
    // The road a fact's day count is the time of — its own clause's, sentence's or the fact's.
    const mode = f.kind === 'duration' ? modeAt(t, f.index) : null;
    return {
      value: f.value,
      kind: f.kind === 'money' ? 'customer_money' : f.kind,
      label,
      origin: 'kb',
      ...(mode ? { mode } : {}),
    };
  });
}
