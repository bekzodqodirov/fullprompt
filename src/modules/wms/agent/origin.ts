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
// («иву» ends «живу» — I live).
const PLACES: readonly Place[] = [
  { place: 'Qashqar', zone: 'kashgar', re: /kashg|qashq|кашг|қашқ|喀什/iu },
  { place: 'Horgos', zone: 'horgos', re: /horgo|xorgo|хорго|霍尔果斯/iu },
  { place: 'Urumchi', zone: null, re: /urumch|урумч|乌鲁木齐/iu },
  { place: 'Yiwu', zone: 'cn', re: /(?<!\p{L})(?:yiwu|ivu|иву)|义乌/iu },
  { place: 'Guangzhou', zone: 'cn', re: /guangzhou|guanchjou|гуанчжоу|广州/iu },
  { place: 'Foshan', zone: 'cn', re: /foshan|фошань|佛山/iu },
  { place: 'Shenzhen', zone: 'cn', re: /shenzhen|шэньчжэнь|шеньчжень|深圳/iu },
  { place: 'Shanghai', zone: 'cn', re: /shanghai|шанхай|上海/iu },
  { place: 'Ningbo', zone: 'cn', re: /ningbo|нинбо|宁波/iu },
];

/** Every named place in the text, each once, in the list's order. */
export function namedOrigins(text: string | null): { place: string; zone: OriginZone | null }[] {
  const t = text ?? '';
  return PLACES.filter((p) => p.re.test(t)).map(({ place, zone }) => ({ place, zone }));
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
