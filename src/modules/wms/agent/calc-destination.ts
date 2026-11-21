/**
 * Where a calculation's cargo GOES, as the customer said it — the AI's checklist's own reading (his «T a», 2026-11-21).
 *
 * The checklist read the destination only through the staff intake's route reader (calc/intake-manual `readRoute`),
 * which wants «A → B» or «Adan Bga» in Latin inside ONE message. «Toshkentga» on its own, «Тошкентга», «в Ташкент»,
 * «до Ташкента», «Иудан Тошкентга» and «из Иу в Ташкент» read as nothing, so a truck job asked «qaysi shaharga» for
 * ever and never reached the VED. His answer: (1) a destination named alone, in Cyrillic or in Russian is READ; (2) a
 * truck job where none is said takes Tashkent, and the VED is told so in words on the job (`ASSUMED_DESTINATION_NOTE`).
 *
 * A destination is a PLACE in a destination's grammar — never a word in that grammar alone. destination.ts's own
 * comment records why: «<word>ga» is an open lexicon («sotuvga», «firmangizga», «yangi yilgacha»), and every grammar
 * reader built on the slot read ordinary words as places. So the place is checked by vocabulary the code already has,
 * none of it restated here:
 *  - Tashkent — the table's own end, the one spelling the whole estimate path says («Toshkentgacha», auto-money
 *    `TO_TASHKENT`); restated as a STEM here, its grammar being this reader's;
 *  - every other city, region and country — destination.ts `namesForeignPlace`, the gate's list (Uzbekistan's other
 *    regions and towns, the neighbours, farther places), asked of the matched words alone;
 *  - China — origin.ts `chinaMentions`, the places a route starts from: «Xitoyga» is where cargo comes FROM in every
 *    chat this company has, so the route reader's «Toshkentdan Xitoyga» is no destination either.
 *
 * The grammar: the Uzbek dative and «-gacha» (glued, after a space or a hyphen, «Toshkent shahriga»), the Russian
 * «в/во/на» with the accusative and «до» with the genitive (never «в Ташкенте» — that is where somebody IS — and never
 * an adjective, «на Андижанском базаре»), English «to», the Chinese «到/运到/…塔什干» and the Persian «تا/به تاشکند»,
 * and a route's dashes or arrows after a China place, to its LAST place («Иу — Ташкент», «Yiwu - Toshkent - Andijon»).
 * «-dan» is an origin and «-da» a location: neither is a destination. The NEWEST destination wins: the last one in
 * the newest line that names one.
 *
 * The review of the build (2026-11-21) found the default taking Tashkent where the customer had said something else —
 * each a regression on the «qaysi shaharga» the checklist asked before. So a line reads NOTHING, and the default is
 * not taken, when the customer:
 *  - refused Tashkent («Toshkentga emas», «… kerak emas», «В Ташкент не надо», «Toshkent emas») — `refusesTashkent`;
 *  - named two destinations in one line («Toshkentga yoki Samarqandga») — a guess either way;
 *  - told of a status, an earlier shipment or his own trip («Andijonga qachon keladi?», «o'tgan safar», «прошлый раз»,
 *    «ketyapman») — `STORY`: no destination of THIS cargo;
 *  - said a destination in its grammar on a town no list holds («В Новосибирск», «Yuk Novosibirskka», a line that is
 *    one dative word) or Tashkent's REGION — `unreadDestination`;
 *  - or asked our own price sentence back («Bu Toshkentgacha narxmi? Men Andijondaman») — a Tashkent read only in the
 *    grammar our estimate uses («-gacha», «до», «to», «到», «تا») yields to any other place he named.
 * A false «no default» costs one «qaysi shaharga», the question every one of these chats got before; a false default
 * lands a city nobody named on the VED's job.
 *
 * Pure.
 */

import { namesForeignPlace } from './destination';
import { chinaMentions } from './origin';

/** The place a truck job takes when the customer named none (his «T a» (2)) — the table's own end. */
export const ASSUMED_DESTINATION = 'Toshkent';
/** What the VED reads on such a job, in his words. */
export const ASSUMED_DESTINATION_NOTE = 'Manzil aytilmagan — Toshkent deb olindi.';

/** An apostrophe as people type it in Uzbek Latin — inside a word («Qo'qon»), never a separator. */
const APOS = "'‘’ʻʼ`´";
const A = `[${APOS}]?`;
const WORD = new RegExp(`[\\p{L}${APOS}]+`, 'gu');

/** Tashkent's own stems: Uzbek Latin, Uzbek Cyrillic, Russian, English. */
const TASHKENT_STEM = /^(?:to[sš]hkent|tashkent|тошкент|ташкент)$/iu;
/** Tashkent with any ending — what a refusal is said about («Toshkentga», «Ташкента», «Toshkentda»). */
const TASHKENT_ANY = /^(?:to[sš]hkent|tashkent|тошкент|ташкент)\p{L}*$/iu;
/** «Toshkent shahriga» — the place is the word before the town noun. */
const TOWN_NOUN = /^(?:sha[hx]ri|sha[hx]ar|viloyati|tumani|ша[ҳх]ри|ша[ҳх]ар|вилояти|тумани)$/iu;
/** The CITY's own noun — the only one a lone «Toshkent …» line may carry and still be the city. */
const CITY_NOUN = /^(?:sha[hx]ri|sha[hx]ar|ша[ҳх]ри|ша[ҳх]ар)$/iu;
/** «Toshkent viloyati», «Ташкентская область»: the REGION, whose towns are not the table's Tashkent (review N2). */
const TASHKENT_REGION =
  /(?<!\p{L})(?:to[sš]hkent|tashkent|тошкент|ташкент)\p{L}*\s+(?:viloyat|tuman|вилоят|туман|област|обл|region|district)|ташкентск\p{L}*\s+(?:обл|район)/iu;
/** «Toshkent ga», «Toshkent-ga»: the ending written apart. */
const LONE_ENDING = /^(?:gacha|ga|гача|га)$/iu;
/** «… emas», «… kerakmas», «… нет»: the place right before it was refused. */
const NEG_AFTER = /^(?:emas|эмас|emasmi|эмасми|kerakmas|керакмас|kerakmasmi|керакмасми|нет)$/iu;
/** «… kerak emas», «… надо не …»: a refusal carried by «need» one word on (review R1b). */
const NEED = /^(?:kerak|керак|надо|нужно|нужен|нужна)$/iu;
const NOT = /^(?:не|not)$/iu;
const RU_TO = /^(?:в|во|на|до)$/iu;
/** «в г. Ташкент», «до города Андижана». */
const RU_TOWN = /^(?:г|гор|город|города)$/iu;
/** «на Андижанском базаре», «в Ташкентскую область» — an adjective after the preposition is no town (review R6). */
const RU_ADJECTIVE = /(?:ск(?:ий|ая|ое|ом|ой|ого|ому|им|их|ую|ие)|ом|ой|ым|ых|их|ем)$/iu;
/** Chinese and Persian «to Tashkent» — no word boundaries to tokenise by; the whole phrase is the reading. */
const SCRIPT_TASHKENT = [/(?:到|至|运到|运往|送到|发到|发往|寄到)\s*塔什干/gu, /(?:تا|به)\s*تاشکند/gu];
/** A route written with a dash or an arrow right after a China place: «Иу — Ташкент», «Yiwu->Toshkent». */
const ROUTE_TAIL = new RegExp(`^\\s*(?:[-–—]+>?|→|=>)\\s*([\\p{L}${APOS}]+)`, 'u');
const HAN = /\p{Script=Han}/u;

/**
 * A line that tells of something other than THIS cargo's road (review R2, F6, N1): a status question about cargo on
 * the way, an earlier shipment, the customer's own trip. No destination is read in it by either reader — a place it
 * names still keeps the default off (`namesForeignPlace` reads every line), so a story about Tashkent costs nothing and
 * a story about Andijan asks «qaysi shaharga» as before T.
 */
const STORY = new RegExp(
  [
    // Uzbek Latin.
    'qachon\\s+(?:kel|yet)',
    '(?<!\\p{L})(?:yetib\\s+)?keld[iy]\\p{L}*',
    '(?<!\\p{L})yetdi\\p{L}*',
    `o${A}tgan\\s+(?:safar|sefar|gal|marta|oy|hafta|yil)`,
    '(?<!\\p{L})(?:oldingi|avvalgi|ilgarigi|ilgari)(?!\\p{L})',
    '\\p{L}{2,}(?:gan|kan|qan)\\s+edi\\p{L}*',
    '\\p{L}{2,}(?:gan|kan|qan)di[mkz]\\p{L}*',
    '(?<!\\p{L})(?:ketyap|ketayap|ketaman|boraman|boryap|borayap|bordim|borib\\s+kel)',
    // Uzbek Cyrillic.
    'қачон\\s+(?:кел|ет)',
    '(?<!\\p{L})(?:етиб\\s+)?келд[иы]\\p{L}*',
    '(?<!\\p{L})етди\\p{L}*',
    'ўтган\\s+(?:сафар|гал|марта|ой|ҳафта|йил)',
    '(?<!\\p{L})(?:олдинги|аввалги|илгариги|илгари)(?!\\p{L})',
    '\\p{L}{2,}(?:ган|кан|қан)\\s+эди\\p{L}*',
    '\\p{L}{2,}(?:ган|кан|қан)ди[мкз]\\p{L}*',
    '(?<!\\p{L})(?:кетяп|кетаяп|кетаман|бораман|боряп|бордим|бориб\\s+кел)',
    // Russian.
    'когда\\s+(?:прид|прибуд|приед|будет|дойд|доед)',
    '(?<!\\p{L})(?:пришл|пришёл|пришел|прибыл|доехал|дош[её]л|дошл)\\p{L}*',
    'прошл\\p{L}*\\s+раз',
    '(?<!\\p{L})(?:ранее|раньше)(?!\\p{L})',
    '(?<!\\p{L})(?:отправлял|отправил|посылал|возил)\\p{L}*',
    '(?<!\\p{L})(?:еду|поеду|езжу|ездил)(?!\\p{L})',
    // English.
    'last\\s+time',
    '(?<!\\p{L})previous(?!\\p{L})',
    'when\\s+will',
    '(?<!\\p{L})arrived(?!\\p{L})',
    "i['’]?m\\s+going|i\\s+am\\s+going|i\\s+went",
    // Chinese.
    '上次|以前|之前|什么时候到|到了吗|已经到',
  ].join('|'),
  'iu',
);

/** «men», «bizga», «Sizga» — the customer or us, never a town. */
const PRONOUN = new RegExp(`^(?:men|sen|biz|siz|ular|u|o${A}z\\p{L}*|мен|сен|биз|сиз|улар|у|ўз\\p{L}*)(?:lar|лар)?$`, 'iu');
/** «Jumagacha», «Dekabrgacha» — a day or a month, written capitalised as often as not. */
const TIME_WORD =
  /^(?:dushanba|seshanba|chorshanba|payshanba|juma|shanba|yakshanba|yanvar|fevral|mart|aprel|may|iyun|iyul|avgust|sent[y]?abr|okt[y]?abr|noyabr|dekabr|душанба|сешанба|чоршанба|пайшанба|жума|шанба|якшанба|январ|феврал|март|апрел|май|июн|июл|август|сентябр|октябр|ноябр|декабр)$/iu;
/** «До Нового года», «до Пятницы» — a time after «до», capitalised as often as not. */
const RU_TIME =
  /^(?:нов(?:ого|ый|ым|ому|ой|ая|ую)|понедельник\p{L}*|вторник\p{L}*|сред\p{L}*|четверг\p{L}*|пятниц\p{L}*|суббот\p{L}*|воскресень\p{L}*|январ\p{L}*|феврал\p{L}*|март\p{L}*|апрел\p{L}*|ма[йя]|июн\p{L}*|июл\p{L}*|август\p{L}*|сентябр\p{L}*|октябр\p{L}*|ноябр\p{L}*|декабр\p{L}*|конц\p{L}*|начал\p{L}*)$/iu;
/**
 * Capitalised and no town: a messenger or a marketplace («WeChatga», «в Телеграм»), and Uzbekistan itself — the
 * table's own country, where «O'zbekistonga» names no city and the table's city is taken with its note.
 */
const NOT_A_TOWN = new RegExp(
  `^(?:we-?chat|telegram|whats-?app|vatsap|watsap|instagram|insta|imo|alibaba|taobao|pinduoduo|wildberries|ozon|uzum|телеграм|ватсап|вотсап|инстаграм|вичат|имо|o${A}zbekiston|uzbekistan|ўзбекистон|узбекистон|узбекистан)\\p{L}*$`,
  'iu',
);
/** «в Ваш склад», «to You» — a polite pronoun is capitalised and is no town. */
const POLITE = /^(?:ваш\p{L}*|вас|вам|вами|вы|нас|нам|мне|меня|you|me|us|him|her|them|it|my|our|your|his|their)$/iu;
/** A place's case and demonym endings — «Andijondan», «Samarqanddanman», «Andijonlikman», «Москвада», «Андижане». */
const ENDINGS = /^(?:dagi|dan|da|lik|lar|man|miz|ning|niki|ni|даги|дан|да|лик|лар|ман|миз|нинг|ники|ни|е|ом|ой|ым|ем)+$/iu;

interface Hit {
  at: number;
  place: string;
  /** Refused right where it is said («Toshkentga emas», «не в Ташкент»): it is no destination. */
  refused: boolean;
  /** Tashkent in the grammar our own estimate sentence uses («-gacha», «до», «to», «到», «تا») — maybe our words back. */
  echo: boolean;
}

/**
 * The Uzbek dative of a word: «Toshkentga» → «Toshkent», «Chirchiqqa» → «Chirchiq», «Termizgacha» → «Termiz». «-ka»
 * and «-qa» only where Uzbek writes them, after a «k» or a «q»: «Asaka» is a town, never «Asa» + «-ka».
 */
function dative(word: string): { stem: string; gacha: boolean } | null {
  const m = /^(.+?)(gacha|kacha|qacha|ga|ka|qa|гача|кача|қача|га|ка|қа)$/iu.exec(word);
  if (!m) return null;
  const [, stem, ending] = m as unknown as [string, string, string];
  const first = ending[0]!.toLowerCase();
  if ((first === 'k' || first === 'к') && !/[kк]$/iu.test(stem)) return null;
  if ((first === 'q' || first === 'қ') && !/[qқ]$/iu.test(stem)) return null;
  return stem.length >= 2 ? { stem, gacha: /ча$|cha$/iu.test(ending) } : null;
}

/** «Toshkent» for every spelling of Tashkent; the place as written (its first letter up) for any other place. */
function placeName(stem: string): string {
  if (TASHKENT_STEM.test(stem)) return ASSUMED_DESTINATION;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/**
 * A place, read as a destination when it is Tashkent, or a place the gate's own list names in exactly the words the
 * grammar matched (`phrase` — «Andijonga», «до Андижана», «to Almaty»). That list holds no Chinese place, so «Xitoyga»,
 * «Yiwuga», «Guanchjouga» — where cargo starts in every chat this company has — are read as nothing.
 */
function acceptedPlace(stem: string, phrase: string): string | null {
  if (TASHKENT_STEM.test(stem)) return ASSUMED_DESTINATION;
  return namesForeignPlace([phrase]) ? placeName(stem) : null;
}

/**
 * «до Андижана» → «Андижан»: the Russian genitive of a town ending in a consonant takes «-а». Any other form is kept
 * as written — the VED reads it, and a wrong cut would be worse than a case ending.
 */
function russianName(word: string, prep: string): string {
  if (prep === 'до' && /[бвгджзклмнпрстфхцчшщ]а$/iu.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Is the place ending at word `i` refused by what follows it — «Toshkentga emas», «Toshkentga kerak emas», «В Ташкент
 * не надо»? «не» right before a preposition negates the place AFTER it («В Ташкент, не в Алматы» chooses Tashkent).
 */
function refusedAfter(words: readonly string[], i: number): boolean {
  const n1 = words[i + 1] ?? '';
  const n2 = words[i + 2] ?? '';
  if (NEG_AFTER.test(n1)) return true;
  if (/^не$/iu.test(n1) && !RU_TO.test(n2)) return true;
  return NEED.test(n1) && (NEG_AFTER.test(n2) || /^(?:emas|эмас|не)$/iu.test(n2));
}

/** The words of a line with where each starts. */
function wordsOf(text: string): { w: string; at: number }[] {
  return [...text.matchAll(WORD)].map((m) => ({ w: m[0], at: m.index }));
}

/** Every destination in one line, by position — refused ones included, marked. */
function hitsIn(line: string): Hit[] {
  const text = line.normalize('NFKC');
  const words = wordsOf(text);
  const plain = words.map((x) => x.w);
  const hits: Hit[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const { w, at } = words[i]!;
    const lower = w.toLowerCase();
    const prev = words[i - 1]?.w ?? '';
    // The Uzbek dative: on the word itself, on «shahriga» after the place, or written apart («Toshkent ga»).
    if (LONE_ENDING.test(w) && i > 0 && !TOWN_NOUN.test(prev)) {
      // «Toshkent ga» / «Toshkent-ga»: the place is the word before.
      const place = acceptedPlace(prev, `${prev}${lower}`);
      if (place) hits.push({ at: words[i - 1]!.at, place, refused: refusedAfter(plain, i), echo: /cha$|ча$/iu.test(w) });
      continue;
    }
    const d = dative(w);
    if (d) {
      const town = TOWN_NOUN.test(d.stem) && i > 0 ? words[i - 1]! : null;
      // «Toshkent viloyatiga» is Tashkent's REGION — not the city the table ends in.
      if (town && TASHKENT_STEM.test(town.w) && !CITY_NOUN.test(d.stem)) continue;
      const placeWord = town ? town.w : d.stem;
      const phrase = town ? `${town.w} ${w}` : w;
      const place = acceptedPlace(placeWord, phrase);
      if (place) hits.push({ at: town ? town.at : at, place, refused: refusedAfter(plain, i), echo: d.gacha });
      continue;
    }
    // Russian: «в/во/на» + the accusative, «до» + the genitive, «г.»/«город» between them allowed.
    if (RU_TO.test(w)) {
      let j = i + 1;
      if (RU_TOWN.test(words[j]?.w ?? '')) j += 1;
      const target = words[j];
      if (!target) continue;
      const prep = lower;
      const t = target.w;
      // «в Ташкенте», «в Андижане» — where somebody IS, not where the cargo goes; an adjective is no town.
      if (prep !== 'до' && /[еи]$/iu.test(t)) continue;
      if (RU_ADJECTIVE.test(t)) continue;
      const stemRu = /^ташкента?$/iu.test(t) ? 'ташкент' : russianName(t, prep);
      const place = acceptedPlace(stemRu, `${prep} ${t}`);
      if (place) hits.push({ at: target.at, place, refused: NOT.test(prev) || refusedAfter(plain, j), echo: prep === 'до' });
      continue;
    }
    // English: «to Tashkent», «to Almaty».
    if (lower === 'to' && words[i + 1]) {
      const t = words[i + 1]!.w;
      const place = acceptedPlace(t, `to ${t}`);
      if (place) hits.push({ at: words[i + 1]!.at, place, refused: NOT.test(prev) || refusedAfter(plain, i + 1), echo: true });
    }
  }
  for (const re of SCRIPT_TASHKENT) {
    for (const m of text.matchAll(re)) hits.push({ at: m.index, place: ASSUMED_DESTINATION, refused: false, echo: true });
  }
  // A route's other end, after a dash or an arrow following a China place — followed through every further dash to
  // its LAST place (review N2: «Yiwu - Toshkent - Andijon» ends in Andijan).
  for (const c of chinaMentions(text)) {
    let offset = c.index + c.match.length;
    let found: { word: string; at: number } | null = null;
    for (;;) {
      const tail = ROUTE_TAIL.exec(text.slice(offset));
      if (!tail) break;
      const word = tail[1]!;
      const wordAt = offset + tail.index + tail[0].length - word.length;
      offset += tail.index + tail[0].length;
      if (TASHKENT_STEM.test(word) || namesForeignPlace([`${c.match} - ${word}`])) found = { word, at: wordAt };
    }
    if (found) hits.push({ at: found.at, place: placeName(found.word), refused: false, echo: false });
  }
  // A line that is the place and nothing else — «Toshkent», «Андижан», «Toshkent shahri» — answers «qaysi shaharga?».
  // Inside a longer line a bare place is an address, a sender, a story («г. Ташкент, ул. …»): never read there. Never
  // a word that is a place WITH an ending — «Andijondan», «Andijonlikman», «Москвада» (review R5) — nor a Chinese line,
  // which has no spaces and is one «word» whole («从安集延发货»).
  if (hits.length === 0 && words.length <= 2 && !/\d/u.test(text)) {
    const named = words.filter((x) => !TOWN_NOUN.test(x.w));
    const only = named[0];
    if (
      named.length === 1 &&
      only &&
      words.every((x) => x === only || CITY_NOUN.test(x.w)) &&
      !HAN.test(only.w) &&
      !placeWithEnding(only.w)
    ) {
      const place = acceptedPlace(only.w, only.w);
      if (place) hits.push({ at: only.at, place, refused: false, echo: false });
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

/** Is the word a place followed by case or demonym endings («Andijondan», «Samarqanddanman», «Андижане»)? */
function placeWithEnding(word: string): boolean {
  for (let cut = 2; cut < word.length; cut += 1) {
    const stem = word.slice(0, cut);
    if (ENDINGS.test(word.slice(cut)) && (TASHKENT_STEM.test(stem) || namesForeignPlace([stem]))) return true;
  }
  return false;
}

interface LineReading {
  /** The destination the line names, or null. */
  place: string | null;
  /** That destination is Tashkent in our own estimate sentence's grammar. */
  echo: boolean;
  /** Two destinations in one line (review R4): no reading, and an older line's reading does not stand over it. */
  ambiguous: boolean;
  /** A status, an earlier shipment, a trip (review R2): no reading by either reader. */
  story: boolean;
  /** The line held any destination, refused ones included — the route reader is not asked about it. */
  any: boolean;
}

function readLine(line: string): LineReading {
  if (STORY.test(line.normalize('NFKC'))) return { place: null, echo: false, ambiguous: false, story: true, any: false };
  const hits = hitsIn(line);
  const said = hits.filter((h) => !h.refused);
  const places = new Set(said.map((h) => h.place));
  if (places.size >= 2) return { place: null, echo: false, ambiguous: true, story: false, any: true };
  const last = said.at(-1);
  return { place: last?.place ?? null, echo: last?.echo === true, ambiguous: false, story: false, any: hits.length > 0 };
}

/** The destination one line names — the one place it names — or null (none, two, refused, or a story). */
export function destinationIn(line: string): string | null {
  return readLine(line).place;
}

/** The newest destination the customer's lines name, oldest line first — or null when none names one. */
export function newestDestination(lines: readonly string[]): string | null {
  let out: string | null = null;
  for (const line of lines) {
    const r = readLine(line);
    if (r.story) continue;
    out = r.ambiguous ? null : (r.place ?? out);
  }
  return out;
}

/**
 * Did the customer refuse Tashkent anywhere in the line (review R1) — «Toshkentga emas», «Toshkent emas», «Toshkentga
 * kerak emas», «Не в Ташкент», «В Ташкент не надо», «not to Tashkent»? «Toshkentdan emas» refuses an ORIGIN and says
 * nothing of where the cargo goes.
 */
export function refusesTashkent(line: string): boolean {
  const words = wordsOf(line.normalize('NFKC')).map((x) => x.w);
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    if (!TASHKENT_ANY.test(w) || /(?:dan|дан|из)$/iu.test(w)) continue;
    let end = i;
    if (LONE_ENDING.test(words[i + 1] ?? '') || TOWN_NOUN.test(words[i + 1] ?? '') || /^(?:sha[hx]r|ша[ҳх]р)\p{L}*$/iu.test(words[i + 1] ?? '')) end = i + 1;
    if (refusedAfter(words, end)) return true;
    const p1 = words[i - 1] ?? '';
    const p2 = words[i - 2] ?? '';
    const p3 = words[i - 3] ?? '';
    if (NOT.test(p1)) return true;
    if ((RU_TO.test(p1) || /^to$/iu.test(p1)) && NOT.test(p2)) return true;
    if (RU_TOWN.test(p1) && RU_TO.test(p2) && NOT.test(p3)) return true;
  }
  return false;
}

/**
 * Does the line say a destination in a destination's grammar on a word no reader here holds as a place (review R3) —
 * «В Новосибирск», «До Екатеринбурга», «to Novosibirsk», «Yuk Novosibirskka», a line that is one dative word, «Kitob
 * shahriga» — or name Tashkent's region? The customer said where the cargo goes and this reader cannot read it: the
 * Tashkent default would put a city on the job that he did not say. Capitalised words only inside a longer line — the
 * one thing that tells a town from «sotuvga» in the middle of a sentence; a pronoun, a day or a month is never one.
 */
export function unreadDestination(line: string): boolean {
  const text = line.normalize('NFKC');
  if (TASHKENT_REGION.test(text)) return true;
  const words = wordsOf(text).map((x) => x.w);
  const capital = (w: string) => /^\p{Lu}/u.test(w);
  const known = (stem: string, phrase: string) =>
    acceptedPlace(stem, phrase) !== null || chinaMentions(stem).length > 0 || chinaMentions(phrase).length > 0;
  // «Kitob shahriga» is one place said alone: the town noun, bare or in the dative, is no second word.
  const townWord = (x: string) => TOWN_NOUN.test(x) || TOWN_NOUN.test(dative(x)?.stem ?? '');
  const alone = words.filter((x) => !townWord(x)).length === 1;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    const prev = words[i - 1] ?? '';
    if (RU_TO.test(w)) {
      let j = i + 1;
      if (RU_TOWN.test(words[j] ?? '')) j += 1;
      const t = words[j];
      // A Cyrillic town only: «в Telegram», «на WhatsApp» are where people write, and a time is no town.
      if (!t || NOT.test(prev) || !capital(t) || POLITE.test(t) || RU_TIME.test(t) || NOT_A_TOWN.test(t) || !/^\p{Script=Cyrillic}/u.test(t)) continue;
      if (w.toLowerCase() !== 'до' && /[еи]$/iu.test(t)) continue;
      if (RU_ADJECTIVE.test(t)) continue;
      const stemRu = /^ташкента?$/iu.test(t) ? 'ташкент' : russianName(t, w.toLowerCase());
      if (!known(stemRu, `${w.toLowerCase()} ${t}`)) return true;
      continue;
    }
    if (w.toLowerCase() === 'to') {
      const t = words[i + 1];
      if (t && capital(t) && !POLITE.test(t) && !NOT_A_TOWN.test(t) && !known(t, `to ${t}`)) return true;
      continue;
    }
    if (LONE_ENDING.test(w) && i > 0) {
      if (capital(prev) && !PRONOUN.test(prev) && !TIME_WORD.test(prev) && !NOT_A_TOWN.test(prev) && !known(prev, `${prev}${w}`)) return true;
      continue;
    }
    const d = dative(w);
    if (!d) continue;
    const town = TOWN_NOUN.test(d.stem) && i > 0 ? prev : null;
    const placeWord = town ?? d.stem;
    if (PRONOUN.test(placeWord) || TIME_WORD.test(placeWord) || TOWN_NOUN.test(placeWord) || NOT_A_TOWN.test(placeWord)) continue;
    if (known(placeWord, town ? `${town} ${w}` : w)) continue;
    const first = i === (town ? 1 : 0);
    if (alone || (capital(placeWord) && !first)) return true;
  }
  return false;
}

/**
 * The checklist's destination for a TRUCK job (his «T a»): what the lines name (this reader's reading first, then the
 * route reader's — `routeTo`, per line, as the checklist always read it), the newest winning; none said → Tashkent,
 * `assumed`, unless the customer named any place other than Tashkent, refused Tashkent, named two, or said a
 * destination nobody here can read — then nothing is defaulted: it is left missing and the city is asked.
 *
 * `earlier`: the chat's lines before its last landed job (review R2 — the cut calc-files reads the job's files by). They
 * are never read as THIS job's destination, but every place, refusal and unread destination in them still keeps the
 * default off: a destination said for the last job is asked again, never silently swapped for Tashkent.
 *
 * The route reader's far end is taken only where it is a place (review R7): Tashkent, a listed place, or a word the
 * customer capitalised — «Xitoydan menga», «Ivudan skladga», «sotuvga» name no place, and the job takes Tashkent with
 * its note. Its far end in China («Toshkentdan Xitoyga», review F3) is no road this table prices: asked.
 */
export function truckDestination(
  lines: readonly string[],
  routeTo: (line: string) => string | null,
  earlier: readonly string[] = [],
): { toCity: string | null; assumed: boolean } {
  let toCity: string | null = null;
  let echo = false;
  let doubt = false;
  for (const line of lines) {
    const r = readLine(line);
    if (r.story) continue;
    if (r.ambiguous) {
      toCity = null;
      echo = false;
      doubt = true;
      continue;
    }
    if (r.place) {
      toCity = r.place;
      echo = r.echo;
      continue;
    }
    if (r.any) continue;
    const routed = routePlace(routeTo(line));
    if (routed === 'china') doubt = true;
    else if (routed) {
      toCity = routed;
      echo = false;
    }
  }
  const all = [...earlier, ...lines];
  const otherPlace = namesForeignPlace(all) || all.some(unreadDestination);
  // Our own «Toshkentgacha» asked back beside his own city (review F1): the city is his to say, never ours.
  if (toCity === ASSUMED_DESTINATION && echo && otherPlace) toCity = null;
  if (toCity) return { toCity, assumed: false };
  if (doubt || otherPlace || all.some(refusesTashkent)) return { toCity: null, assumed: false };
  return { toCity: ASSUMED_DESTINATION, assumed: true };
}

/** The route reader's far end as a destination: the place, `'china'` for a China end, or null for no place. */
function routePlace(value: string | null): string | 'china' | null {
  const v = value?.trim() ?? '';
  if (v === '') return null;
  if (chinaMentions(v).length > 0) return 'china';
  if (TASHKENT_STEM.test(v)) return ASSUMED_DESTINATION;
  if (NOT_A_TOWN.test(v)) return null;
  return namesForeignPlace([v]) || /^\p{Lu}/u.test(v) ? v : null;
}
