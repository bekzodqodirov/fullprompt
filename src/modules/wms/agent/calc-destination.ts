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
 *    regions and towns, the neighbours, farther places), asked of the matched words alone and never edited for this;
 *  - China — origin.ts `chinaMentions`, the places a route starts from: «Xitoyga» is where cargo comes FROM in every
 *    chat this company has, so the route reader's «Toshkentdan Xitoyga» is no destination either.
 *
 * The grammar: the Uzbek dative and «-gacha» (glued, after a space or a hyphen, «Toshkent shahriga»), the Russian
 * «в/во/на» with the accusative and «до» with the genitive (never «в Ташкенте» — that is where somebody IS), English
 * «to», the Chinese «到/运到/…塔什干» and the Persian «تا/به تاشکند», and a route's dash or arrow after a China place
 * («Иу — Ташкент», «Yiwu-Toshkent»). «-dan» is an origin and «-da» a location: neither is a destination. A place
 * followed by «emas»/«не» was refused, not chosen. The NEWEST destination wins: the last one in the newest line that
 * names one.
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
const WORD = new RegExp(`[\\p{L}${APOS}]+`, 'gu');

/** Tashkent's own stems: Uzbek Latin, Uzbek Cyrillic, Russian, English. */
const TASHKENT_STEM = /^(?:to[sš]hkent|tashkent|тошкент|ташкент)$/iu;
/** «Toshkent shahriga» — the place is the word before the town noun. */
const TOWN_NOUN = /^(?:sha[hx]ri|sha[hx]ar|viloyati|tumani|ша[ҳх]ри|ша[ҳх]ар|вилояти|тумани)$/iu;
/** «Toshkent ga», «Toshkent-ga»: the ending written apart. */
const LONE_ENDING = /^(?:gacha|ga|гача|га)$/iu;
/** «… emas», «… эмас»: the place right before it was refused. */
const REFUSED_AFTER = /^(?:emas|эмас)$/iu;
const RU_TO = /^(?:в|во|на|до)$/iu;
/** «в г. Ташкент», «до города Андижана». */
const RU_TOWN = /^(?:г|гор|город|города)$/iu;
/** Chinese and Persian «to Tashkent» — no word boundaries to tokenise by; the whole phrase is the reading. */
const SCRIPT_TASHKENT = [/(?:到|至|运到|运往|送到|发到|发往|寄到)\s*塔什干/gu, /(?:تا|به)\s*تاشکند/gu];
/** A route written with a dash or an arrow right after a China place: «Иу — Ташкент», «Yiwu->Toshkent». */
const ROUTE_TAIL = new RegExp(`^\\s*(?:[-–—]+>?|→|=>)\\s*([\\p{L}${APOS}]+)`, 'u');

interface Hit {
  at: number;
  place: string;
}

/**
 * The Uzbek dative of a word: «Toshkentga» → «Toshkent», «Chirchiqqa» → «Chirchiq», «Termizgacha» → «Termiz». «-ka»
 * and «-qa» only where Uzbek writes them, after a «k» or a «q»: «Asaka» is a town, never «Asa» + «-ka».
 */
function dativeStem(word: string): string | null {
  const m = /^(.+?)(gacha|kacha|qacha|ga|ka|qa|гача|кача|қача|га|ка|қа)$/iu.exec(word);
  if (!m) return null;
  const [, stem, ending] = m as unknown as [string, string, string];
  const first = ending[0]!.toLowerCase();
  if ((first === 'k' || first === 'к') && !/[kк]$/iu.test(stem)) return null;
  if ((first === 'q' || first === 'қ') && !/[qқ]$/iu.test(stem)) return null;
  return stem.length >= 2 ? stem : null;
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

/** Every destination in one line, by position. */
function hitsIn(line: string): Hit[] {
  const text = line.normalize('NFKC');
  const words = [...text.matchAll(WORD)].map((m) => ({ w: m[0], at: m.index }));
  const hits: Hit[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const { w, at } = words[i]!;
    const lower = w.toLowerCase();
    const next = words[i + 1]?.w ?? '';
    const prev = words[i - 1]?.w ?? '';
    // The Uzbek dative: on the word itself, on «shahriga» after the place, or written apart («Toshkent ga»).
    if (LONE_ENDING.test(w) && i > 0 && !TOWN_NOUN.test(prev)) {
      // «Toshkent ga» / «Toshkent-ga»: the place is the word before.
      const place = acceptedPlace(prev, `${prev}${lower}`);
      if (place && !REFUSED_AFTER.test(next)) hits.push({ at: words[i - 1]!.at, place });
      continue;
    }
    const stem = dativeStem(w);
    if (stem) {
      const town = TOWN_NOUN.test(stem) && i > 0 ? words[i - 1]! : null;
      const placeWord = town ? town.w : stem;
      const phrase = town ? `${town.w} ${w}` : w;
      const place = acceptedPlace(placeWord, phrase);
      if (place && !REFUSED_AFTER.test(next)) hits.push({ at: town ? town.at : at, place });
      continue;
    }
    // Russian: «в/во/на» + the accusative, «до» + the genitive, «г.»/«город» between them allowed.
    if (RU_TO.test(w) && !/^не$/iu.test(prev)) {
      let j = i + 1;
      if (RU_TOWN.test(words[j]?.w ?? '')) j += 1;
      const target = words[j];
      if (!target) continue;
      const prep = lower;
      const t = target.w;
      // «в Ташкенте», «в Андижане» — where somebody IS, not where the cargo goes.
      if (prep !== 'до' && /[еи]$/iu.test(t)) continue;
      const stemRu = /^ташкента?$/iu.test(t) ? 'ташкент' : russianName(t, prep);
      const place = acceptedPlace(stemRu, `${prep} ${t}`);
      if (place) hits.push({ at: target.at, place });
      continue;
    }
    // English: «to Tashkent», «to Almaty».
    if (lower === 'to' && words[i + 1]) {
      const t = words[i + 1]!.w;
      const place = acceptedPlace(t, `to ${t}`);
      if (place) hits.push({ at: words[i + 1]!.at, place });
    }
  }
  for (const re of SCRIPT_TASHKENT) {
    for (const m of text.matchAll(re)) hits.push({ at: m.index, place: ASSUMED_DESTINATION });
  }
  // A route's other end, after a dash or an arrow following a China place.
  for (const c of chinaMentions(text)) {
    const tail = ROUTE_TAIL.exec(text.slice(c.index + c.match.length));
    if (!tail) continue;
    const word = tail[1]!;
    const place = TASHKENT_STEM.test(word)
      ? ASSUMED_DESTINATION
      : namesForeignPlace([text.slice(c.index, c.index + c.match.length + tail[0].length)])
        ? placeName(word)
        : null;
    if (place) hits.push({ at: c.index + c.match.length + tail.index + tail[0].length - word.length, place });
  }
  // A line that is the place and nothing else — «Toshkent», «Андижан», «Toshkent shahri» — answers «qaysi shaharga?».
  // Inside a longer line a bare place is an address, a sender, a story («г. Ташкент, ул. …»): never read there.
  const named = words.filter((x) => !TOWN_NOUN.test(x.w));
  if (hits.length === 0 && named.length === 1 && words.length <= 2 && !/\d/u.test(text)) {
    const only = named[0]!;
    const place = acceptedPlace(only.w, only.w);
    if (place) hits.push({ at: only.at, place });
  }
  return hits.sort((a, b) => a.at - b.at);
}

/** The destination one line names — the last one in it — or null. */
export function destinationIn(line: string): string | null {
  return hitsIn(line).at(-1)?.place ?? null;
}

/** The newest destination the customer's lines name, oldest line first — or null when none names one. */
export function newestDestination(lines: readonly string[]): string | null {
  let out: string | null = null;
  for (const line of lines) out = destinationIn(line) ?? out;
  return out;
}

/**
 * The checklist's destination for a TRUCK job (his «T a»): what the lines name (this reader's reading first, then the
 * route reader's — `routeTo`, per line, as the checklist always read it), the newest winning; none said → Tashkent,
 * `assumed`, unless the customer named any place other than Tashkent anywhere (`namesForeignPlace`) — a named foreign
 * destination is never defaulted: it is left missing, and the gate's `foreign_destination` speaks for it.
 */
export function truckDestination(
  lines: readonly string[],
  routeTo: (line: string) => string | null,
): { toCity: string | null; assumed: boolean } {
  let toCity: string | null = null;
  for (const line of lines) {
    const read = destinationIn(line) ?? routeTo(line);
    // A China place from the route reader («Toshkentdan Xitoyga» reads «Xitoy») is never where the cargo goes.
    if (read && chinaMentions(read).length === 0) toCity = read;
  }
  if (toCity) return { toCity, assumed: false };
  if (namesForeignPlace(lines)) return { toCity: null, assumed: false };
  return { toCity: ASSUMED_DESTINATION, assumed: true };
}
