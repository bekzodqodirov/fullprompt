/**
 * Where a customer's cargo starts, by the places they NAMED — and the tariff
 * zone that place means (review leak-nit A11).
 *
 * The bot's «Hisoblatish» door asks the seller to press a zone (staff-bot.ts
 * `AI_ZONE_ROUTES`): Yiwu/Guangzhou cargo is «cn» whichever border its truck
 * takes, Kashgar is «kashgar», cargo whose road starts at Horgos is «horgos».
 * The agent's landing used to write «cn» for ANY podklyuch with a fromCity,
 * so a Kashgar or Horgos origin was priced on the wrong column of the AI-VED
 * estimate. Here the same facts give the same zone the buttons would, and
 * anything that names no zone — a bare «Xitoy», Urumqi, two places that
 * disagree — gives none: the VED chooses, nothing is guessed.
 *
 * Pure.
 */

export type OriginZone = 'cn' | 'kashgar' | 'horgos';

interface Place {
  place: string;
  zone: OriginZone | null;
  re: RegExp;
}

// Start-of-word anchors where a short spelling is the tail of another word
// («иву» ends «живу» — I live). «Qashq…» is also the head of Qashqadaryo /
// Қашқадарё — an Uzbek DESTINATION region, the commonest place a Karshi
// customer names — so the Kashgar spelling never runs on into «-adar…».
// «Иу» is the Russian Yiwu, written alone or with an Uzbek case ending
// («Иудан»), and never the start of a longer word.
const PLACES: readonly Place[] = [
  { place: 'Qashqar', zone: 'kashgar', re: /kashg|qashq(?!adar)|кашг|қашқ(?!адар)|喀什/iu },
  { place: 'Horgos', zone: 'horgos', re: /horgo|xorgo|хорго|霍尔果斯/iu },
  { place: 'Urumchi', zone: null, re: /urumch|урумч|乌鲁木齐/iu },
  {
    place: 'Yiwu',
    zone: 'cn',
    re: /(?<!\p{L})(?:yiwu|ivu|иву|иу(?:дан|даги|да|га|нинг)?(?!\p{L}))|义乌/iu,
  },
  { place: 'Guangzhou', zone: 'cn', re: /guangzhou|guanchjou|гуанчжоу|广州/iu },
  { place: 'Foshan', zone: 'cn', re: /foshan|фошань|佛山/iu },
  { place: 'Shenzhen', zone: 'cn', re: /shenzhen|шэньчжэнь|шеньчжень|深圳/iu },
  { place: 'Shanghai', zone: 'cn', re: /shanghai|шанхай|上海/iu },
  { place: 'Ningbo', zone: 'cn', re: /ningbo|нинбо|宁波/iu },
  { place: 'Beijing', zone: 'cn', re: /beijing|pekin|пекин|北京/iu },
];

/**
 * China itself, named with no place in it — in the six languages, with the
 * cases a customer writes it in («Xitoydan», «из Китая», «в Китае»).
 */
const CHINA = /(?<!\p{L})(?:xitoy|hitoy|хитой|кита[йяеюи]|china|chinese)|چین|中国/iu;

/** Every named place in the text, each once, in the list's order. */
export function namedOrigins(text: string | null): { place: string; zone: OriginZone | null }[] {
  const t = text ?? '';
  return PLACES.filter((p) => p.re.test(t)).map(({ place, zone }) => ({ place, zone }));
}

/**
 * The text names a place outside China's coast — a western hub the website
 * does not price (Kashgar, Horgos, Urumchi). The same list as `namedOrigins`,
 * so the truck tool's refusal (`quoteOrigin`) and the landing's zone read one
 * set of spellings (#513: Qashqadaryo was a Kashgar in both until both were
 * fixed).
 */
export function namesWesternOrigin(text: string | null): boolean {
  return namedOrigins(text).some((p) => p.zone !== 'cn');
}

/** The one place the text names, or null — none, or more than one. */
export function namedOrigin(text: string | null): { place: string; zone: OriginZone | null } | null {
  const found = namedOrigins(text);
  return found.length === 1 ? found[0]! : null;
}

/** A podklyuch job's zone from its stated origin, as the bot's buttons would choose it — or null, never a guess. */
export function zoneForOrigin(fromCity: string | null): OriginZone | null {
  const found = namedOrigins(fromCity);
  if (found.length === 0 || found.some((f) => f.zone === null)) return null;
  const zones = new Set(found.map((f) => f.zone));
  return zones.size === 1 ? [...zones][0]! : null;
}

/**
 * Where a truck price starts (his third set «3», 2026-10-24: «agar skladimizga
 * jo'natib bersangiz skladlarimizdan narxi shuncha deb aytsin»):
 *  - `western` — a hub the website does not price (Kashgar, Horgos, Urumchi);
 *  - `warehouse` — every Chinese place named is one of OUR warehouses' cities
 *    (Yiwu, Guangzhou): priced from there, as it always was;
 *  - `our_warehouse` — China named with no place, or a Chinese place where we
 *    have no warehouse (Shenzhen, Shanghai): priced from our warehouses, on the
 *    condition that the cargo is brought to one — the factory leg is extra;
 *  - `unknown` — nothing named: ask.
 * `ours` holds the PLACES our China warehouses stand in (`placesOf`), read
 * from the warehouses table — never a second list here.
 */
export type QuoteOrigin = 'warehouse' | 'our_warehouse' | 'western' | 'unknown';

export function quoteOrigin(text: string | null, ours: ReadonlySet<string>): QuoteOrigin {
  const t = text ?? '';
  if (namesWesternOrigin(t)) return 'western';
  const named = namedOrigins(t);
  if (named.length > 0) return named.every((p) => ours.has(p.place)) ? 'warehouse' : 'our_warehouse';
  return CHINA.test(t) ? 'our_warehouse' : 'unknown';
}

/**
 * Which of the places a customer can name our warehouses stand in — each
 * warehouse row read by the SAME spellings a customer's message is (its name,
 * code and address), so «Yiwu» on the warehouse card and «Ивудан» in the chat
 * are one place.
 */
export function placesOf(rows: readonly { name: string; code?: string | null; address?: string | null }[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    for (const p of namedOrigins([r.name, r.code ?? '', r.address ?? ''].join('\n'))) out.add(p.place);
  }
  return out;
}
