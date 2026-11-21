/**
 * Where a calculation's cargo GOES — the model names it, the code verifies it is the CUSTOMER's (the lead's ruling,
 * 2026-11-21, after three checks of a word-rule reader).
 *
 * His «T a»: a destination the customer said is read, alone, in Cyrillic or in Russian; a truck job where none is said
 * takes Tashkent, and the VED is told so in words on the job. Three passes built a grammar reader for the first half —
 * the Uzbek dative, «в/до» + a town, «A → B», stories, refusals, stoplists — and every pass fixed shapes and opened
 * others: the last check still found the route reader's far end landing «kelishi», «jo'natish», «yuborish» over a city
 * said beside it, and «Andijonga 3 kub qachon keladi», «Andijon 3 kub», «manzil Andijon», «Andijon viloyati» asked
 * «qaysi shaharga» again. A word rule cannot read Uzbek, Russian and mixed chat; the model can. So the checklist tool
 * takes two inputs from the model — `to_city` (the city) and `to_city_words` (the customer's words that say it, copied
 * exactly) — and the code checks only what a model could get wrong in a way nobody would see:
 *  - the words are the CUSTOMER's: found inside one of his inbound lines since the chat's last landed job (never our
 *    own «Toshkentgacha», never a line of an earlier job, never invented) — normalised for case, the apostrophe as
 *    people type it, whitespace and NFKC, and nothing else: no transliteration, so «Андижан» is found in «Андижан» and
 *    never in «Andijon»;
 *  - the city is IN those words, by its stem — the first four letters, or the whole word when shorter, at the start of
 *    one word of the quote, so the Russian or Uzbek case ending may differ («Andijon» in «Andijonga», «Андижан» in
 *    «Андижана»); a script with no spaces (Chinese) by its first letters anywhere in the quote;
 *  - the city is no place outside Uzbekistan: there the truck table is not the price, so the job does not land and the
 *    checklist asks, as the gate's `foreign_destination` already holds a price there.
 * Accepted, the city lands as the model wrote it, with the quote as the VED's evidence («Manzil mijoz xabaridan: «…»»).
 * Anything else — no city, words not found, a city not in them — lands Tashkent, TAKEN, with «Manzil o‘qilmadi — Toshkent
 * deb olindi, mijoz so‘zlarini tekshiring»: a job that never lands is the defect he reported, and `to_city` drives no
 * price (the prefill and the freight zone read the origin), so a wrong destination is a route line the VED reads
 * beside the customer's own words.
 *
 * What the verifier cannot see is the model's to judge (a word that is no town, a past shipment's city) — the tool's
 * words say what `to_city` is, and the VED reads the quote.
 *
 * Pure.
 */

import { namesForeignPlace } from './destination';
import { chinaMentions } from './origin';

/** The place a truck job takes when the customer's destination was not read (his «T a» (2)) — the table's own end. */
export const ASSUMED_DESTINATION = 'Toshkent';
/**
 * What the VED reads on such a job. «o‘qilmadi», not «aytilmagan»: the same note stands where the customer said a town
 * the check could not verify, so it says what the machine KNOWS — it read nothing — and sends the VED to the
 * customer's words, which the job carries.
 */
export const ASSUMED_DESTINATION_NOTE = 'Manzil o‘qilmadi — Toshkent deb olindi, mijoz so‘zlarini tekshiring';
/** The customer's words a destination was read from, as the VED sees them: about one line of a phone's width. */
export const DESTINATION_EVIDENCE_CHARS = 80;
/** What the VED reads when a destination WAS read: the customer's own words it was read from — a wrong reading shows. */
export function saidDestinationNote(evidence: string): string {
  return `Manzil mijoz xabaridan: «${evidence}»`;
}
/**
 * The one sentence a job's destination is told by — his approval card and the VED's two screens beside the route
 * print the same words. «taxmin» only on a TAKEN destination: a read one is the customer's, an estimate it is not.
 */
export function destinationNote(reading: { taken: true } | { taken: false; evidence: string }): string {
  return reading.taken ? `taxmin: ${ASSUMED_DESTINATION_NOTE}` : saidDestinationNote(reading.evidence);
}

/**
 * The customer's words cut to about `DESTINATION_EVIDENCE_CHARS` around the place at `at` (an offset into `line`) —
 * whitespace folded, so a pasted paragraph is one line — at word boundaries, with «…» where it was cut. The place stays
 * inside the cut: a long line's head is usually a greeting.
 */
export function evidenceOf(line: string, at: number): string {
  const text = line.replace(/\s+/gu, ' ').trim();
  if (text.length <= DESTINATION_EVIDENCE_CHARS) return text;
  // The offset was taken on the raw line; folding only ever shortens what stands before it.
  const placeAt = line.slice(0, Math.max(0, at)).replace(/\s+/gu, ' ').trimStart().length;
  const room = DESTINATION_EVIDENCE_CHARS - 2;
  const from = Math.max(0, Math.min(placeAt - 30, text.length - room));
  const words = [...text.matchAll(/\S+/gu)].map((m) => ({ s: m.index, e: m.index + m[0].length }));
  const kept = words.filter((w) => (w.s >= from && w.e <= from + room) || (w.s <= placeAt && placeAt < w.e));
  const first = kept[0] ?? words[0]!;
  const last = kept.at(-1) ?? first;
  return `${first.s > 0 ? '…' : ''}${text.slice(first.s, last.e)}${last.e < text.length ? '…' : ''}`;
}

/** The apostrophe as people type it in Uzbek Latin — «Qo'qon», «Qo‘qon», «Qoʻqon» are one word. */
const APOSTROPHE = /['‘’ʻʼ`´]/u;

/**
 * The text as the check compares it — NFKC, lower case, one apostrophe, whitespace runs folded to one space, trimmed —
 * with, for each character of the result, where it came from in the NFKC'd source (`from`/`to`), so a quote found in
 * the folded line is cut out of the customer's own text and never shown in the model's copy of it.
 */
function fold(text: string): { text: string; source: string; from: number[]; to: number[] } {
  const source = text.normalize('NFKC');
  let out = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of source) {
    const at = i;
    i += ch.length;
    if (/\s/u.test(ch)) {
      if (out.length > 0 && !out.endsWith(' ')) {
        out += ' ';
        from.push(at);
        to.push(i);
      }
      continue;
    }
    const piece = APOSTROPHE.test(ch) ? "'" : ch.toLowerCase();
    for (const c of piece) {
      out += c;
      from.push(at);
      to.push(i);
    }
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    from.pop();
    to.pop();
  }
  return { text: out, source, from, to };
}

/** A word of folded text — letters and the apostrophe — and the letters alone, which is what a stem is made of. */
const WORD = /[\p{L}']+/gu;
const letters = (word: string) => word.replace(/'/gu, '');
const HAN = /\p{Script=Han}/u;

/** The city's stem: its first word's first four letters, or the whole word when shorter. */
function stemOf(city: string): string {
  const first = letters(fold(city).text.match(WORD)?.[0] ?? '');
  return first.slice(0, 4);
}

/** Where in the folded quote the city stands: a word that starts with its stem — in Chinese, the stem anywhere. */
function cityAt(quote: string, stem: string): number {
  if (HAN.test(stem)) return quote.indexOf(stem);
  for (const m of quote.matchAll(WORD)) if (letters(m[0]).startsWith(stem)) return m.index;
  return -1;
}

/** «O'zbekiston», «Узбекистан» — the table's own country: no city of it, so the table's city is taken with its note. */
const COUNTRY = /^(?:ozbe|uzbe|ўзбе|узбе)/u;

/**
 * Places in Uzbekistan the gate's list (destination.ts `namesForeignPlace`) names as «other than Tashkent» — that list
 * answers the PRICE's question (the table is China → Tashkent, and Andijan is no more Tashkent than Almaty is), and
 * holds the neighbours too. This check asks another one, «is the place outside Uzbekistan», so the places of
 * Uzbekistan the list holds are told apart here, in the spellings it holds them in (Tashkent's region and its towns
 * among them: they are Uzbekistan). A place of Uzbekistan missing here reads as outside and is ASKED — the safe side:
 * a foreign place landed on the Tashkent table is the error this check exists for.
 */
const A = "'?";
const UZBEKISTAN = new RegExp(
  `(?<![\\p{L}])(?:${[
    'andijo?n', 'андижо?н', 'андижан', 'andijan',
    'namangan', 'наманган',
    `farg${A}ona`, 'фарғона', 'фаргона', 'ферган', 'ferg(?:h)?ana', 'fergon',
    'samarqand', 'самарқанд', 'самарканд', 'samarkand',
    'buxoro', 'бухоро', 'бухар', 'bukhara', 'buhoro', 'bukhoro', 'buhara',
    'termiz', 'термиз', 'термез', 'termez',
    'jizzax', 'жиззах', 'джизак', 'jizzakh', 'djizak', 'jizax', 'жизах',
    'guliston', 'гулисто?н', 'гулистан', 'gulistan',
    'sirdaryo', 'сирдарё', 'сырдарь', 'syrdarya',
    'xorazm', 'хоразм', 'хорезм', 'khorezm', 'khorazm', 'horazm',
    'urganch', 'урганч', 'ургенч', 'urgench',
    'nukus', 'нукус',
    `qoraqalpog${A}iston`, 'қорақалпоғисто?н', 'каракалпак', 'karakalpak',
    `qo${A}qon`, 'қўқон', 'коканд', 'kokand', 'quqon', 'ku[kq]on', 'кукон', 'кокон',
    `marg${A}ilon`, 'марғилон', 'маргилон', 'маргилан', 'margilan',
    'surxondaryo', 'сурхондарё', 'сурхандарь', 'surkhandarya',
    'qashqadar', 'қашқадар', 'кашкадар', 'kashkadar',
    'chirchiq', 'чирчиқ', 'чирчик', 'chirchik',
    'angren', 'ангрен',
    'olmaliq', 'олмалиқ', 'алмалык', 'almalyk', 'olmalik', 'олмалик',
    'shahrisabz', 'шаҳрисабз', 'шахрисабз', 'shaxrisabz',
    'гиждувон', `g${A}ijduvon`, 'ғиждувон', 'гиждуван',
    'каттакургон', `kattaqo${A}rg${A}on`, 'каттақўрғон', 'каттакурган',
    'xiva', 'хива', 'khiva', 'hiva',
    'denov', 'денов', 'denau', 'денау',
    'bekobod', 'бекобод', 'bekabad', 'бекабад',
    `yangiyo${A}l`, 'янгийўл', 'янгиюл',
    'ohangaron', 'оҳангарон', 'охангарон', 'ахангаран',
    'nurafshon', 'нурафшон',
    'asaka', 'асака',
    'shahrixon', 'шаҳрихон', 'шахрихан',
    'qorasuv', 'қорасув', 'корасув', 'xonobod', 'хонобод', 'ханабад', `oltinko${A}l`, 'олтинкўл', 'олтинкул', 'алтынкул',
    `paytug${A}`, 'пайтуғ', 'пайтуг', 'izboskan', 'избоскан', `qo${A}rg${A}ontepa`, 'қўрғонтепа', 'кургантепа', 'кургонтепа',
    'quvasoy', 'қувасой', 'кувасай', 'кувасой',
    'rishton', 'риштон', 'риштан',
    'kosonsoy', 'косонсой', 'касансай',
    'urgut', 'ургут',
    'kogon', 'когон', 'каган',
    'zarafshon', 'зарафшон', 'зарафшан',
    'uchquduq', 'учқудуқ', 'учкудук',
    `g${A}uzor`, 'ғузор', 'гузар',
    'sherobod', 'шеробод', 'шерабад',
    'boysun', 'бойсун', 'байсун',
    'yangiyer', 'янгиер',
    'hazorasp', 'ҳазорасп', 'хазарасп',
    `qo${A}ng${A}irot`, 'қўнғирот', 'кунград',
    `to${A}rtko${A}l`, 'тўрткўл', 'турткуль',
    `mo${A}ynoq`, 'мўйноқ', 'муйнак',
    `xo${A}jayli`, 'хўжайли', 'ходжейли',
    // The list's two-faced words, which it counts only in a place's own form — here the place is already said.
    'qarshi', 'қарши', 'карши', 'karshi', 'chust', 'чуст', 'navoi', 'навои', 'marhamat', 'марҳамат', 'мархамат',
    'baliqchi', 'балиқчи', 'балыкчи',
  ].join('|')})|安集延|纳曼干|费尔干纳|撒马尔罕|布哈拉|纳沃伊|卡尔希|铁尔梅兹|吉扎克|乌尔根奇|努库斯|浩罕|花剌子模|希瓦|اندیجان|نمنگان|فرغانه|سمرقند|بخارا|ترمذ|خوقند|خوارزم|جیزخ|خیوه`,
  'u',
);

/**
 * Is the place outside Uzbekistan — China, or a place the gate's list holds that is none of Uzbekistan's? The city is
 * asked with its preposition (`prep`): the list counts a two-faced name only in its grammar («в Ош», «в г. Ош», «to
 * Osh»), and the city alone («Ош») is not. Never the rest of the quote: «Olmaotadan chinozga» names the place the cargo
 * comes FROM.
 */
function outsideUzbekistan(city: string, word: string, prep: string): boolean {
  if (chinaMentions(city).length > 0 || chinaMentions(word).length > 0) return true;
  if (!namesForeignPlace([city, word, `${prep} ${word}`.trim()])) return false;
  return !UZBEKISTAN.test(fold(city).text) && !UZBEKISTAN.test(fold(word).text);
}

/** A preposition, or the town's abbreviation after one, as written before a city: «в», «до», «в г.», «to». */
const PREP = /^(?:в|во|на|до|из|для|to|in|for|г\.?|город\p{L}*)$/u;

/** The prepositions right before position `at` of the folded quote — «в г.» before «ош» — or ''. */
function prepositionBefore(quote: string, at: number): string {
  const tokens = quote.slice(0, at).trim().split(' ');
  const taken: string[] = [];
  while (tokens.length > 0 && taken.length < 2 && PREP.test(tokens.at(-1)!)) taken.unshift(tokens.pop()!);
  return taken.join(' ');
}

/**
 * The customer's lines that are THIS job's — the only lines a quote is looked for in: his inbound ones (never ours —
 * «Toshkentgacha» is our sentence), since the chat's last landed job (review R2 — the cut calc-files copies the job's
 * files by: «Andijonga» for last month's job is no destination of today's). A chain the VED handed back is no cut: the
 * hand-back loop's resubmission is that same job, its destination said before it landed.
 */
export function thisJobLines(
  messages: readonly { direction: string; body: string; sentAt: Date }[],
  openCalcs: readonly { status: string; createdAt: Date }[],
): string[] {
  const landed = openCalcs.filter((c) => c.status !== 'returned').map((c) => c.createdAt.getTime());
  const cut = landed.length > 0 ? Math.max(...landed) : null;
  return messages.filter((m) => m.direction === 'in' && m.body && (cut === null || m.sentAt.getTime() > cut)).map((m) => m.body);
}

/** What the model named, as the checklist tool took it. */
export interface DestinationClaim {
  /** The city, as the model wrote it (`to_city`). */
  toCity: string;
  /** The customer's words that say it, copied (`to_city_words`). */
  words: string;
}

/**
 * The check's answer: `said` — the city lands as written, with the customer's own words; `foreign` — a place outside
 * Uzbekistan, which does not land; `unread` — nothing verified (the truck job takes Tashkent), and why, for the model.
 */
export type DestinationCheck =
  | { kind: 'said'; toCity: string; evidence: string }
  | { kind: 'foreign'; toCity: string }
  | { kind: 'unread'; why: 'none' | 'not_in_lines' | 'not_in_words' | 'country' };

/**
 * The model's destination against the customer's lines (`lines` — his inbound lines that are THIS job's: since the
 * chat's last landed job, never ours).
 */
export function checkDestination(claim: DestinationClaim, lines: readonly string[]): DestinationCheck {
  const toCity = claim.toCity.replace(/\s+/gu, ' ').trim();
  const quote = fold(claim.words).text;
  if (toCity === '' || quote === '') return { kind: 'unread', why: 'none' };
  const stem = stemOf(toCity);
  // A stem of one letter is no city — «A» would match half the words there are; two are a city's whole name in
  // Cyrillic («Ош») and in Chinese («喀山»).
  if (stem.length < 2) return { kind: 'unread', why: 'none' };
  if (COUNTRY.test(stem)) return { kind: 'unread', why: 'country' };
  const at = cityAt(quote, stem);
  if (at < 0) return { kind: 'unread', why: 'not_in_words' };
  for (const line of lines) {
    const f = fold(line);
    const found = f.text.indexOf(quote);
    if (found < 0) continue;
    // The customer's own text, cut out of his line: what the VED reads is never the model's copy.
    const own = f.source.slice(f.from[found]!, f.to[found + quote.length - 1]!);
    const ownAt = f.from[found + at]! - f.from[found]!;
    const word = quote.slice(at).match(WORD)?.[0] ?? '';
    if (outsideUzbekistan(toCity, word, prepositionBefore(quote, at))) return { kind: 'foreign', toCity };
    return { kind: 'said', toCity, evidence: evidenceOf(own, ownAt) };
  }
  return { kind: 'unread', why: 'not_in_lines' };
}

/** A job's destination as the checklist lands it. */
export interface JobDestination {
  toCity: string | null;
  /** Tashkent TAKEN, not read: the VED's note says «Manzil o‘qilmadi …» (`ASSUMED_DESTINATION_NOTE`). */
  assumed: boolean;
  /** The customer's words the city was read from — null when taken or none. */
  evidence: string | null;
  /** A place outside Uzbekistan the model named: not landed, the field stays missing (the checklist asks). */
  foreign: string | null;
  /** Why the model's city was not taken, when it named one — for the model's own retry, never the VED's. */
  refused: 'not_in_lines' | 'not_in_words' | 'country' | null;
}

/**
 * The checklist's destination: the verified city, for any section; a truck job with none verified takes Tashkent
 * (`truck`) — a customs-only job prices no road and takes nothing. A foreign city lands neither.
 */
export function jobDestination(claim: DestinationClaim, lines: readonly string[], truck: boolean): JobDestination {
  const check = checkDestination(claim, lines);
  if (check.kind === 'said') return { toCity: check.toCity, assumed: false, evidence: check.evidence, foreign: null, refused: null };
  if (check.kind === 'foreign') return { toCity: null, assumed: false, evidence: null, foreign: check.toCity, refused: null };
  const refused = check.why === 'none' ? null : check.why;
  return truck
    ? { toCity: ASSUMED_DESTINATION, assumed: true, evidence: null, foreign: null, refused }
    : { toCity: null, assumed: false, evidence: null, foreign: null, refused };
}
