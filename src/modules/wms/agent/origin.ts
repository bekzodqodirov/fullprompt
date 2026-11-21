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
  /**
   * Spellings whose CASE is the reading — matched without the `i` flag, beside `re`: «You dan» is Yiwu, «you dan»
   * is English (the review of his «T a», N4: «Are you Dan?», «Hey you dan»).
   */
  cased?: RegExp;
  /** A province, not a city: «Zhejiang» on a warehouse's address is where it stands, never where a customer's cargo starts. */
  province?: true;
}

// Start-of-word anchors where a short spelling is the tail of another word
// («иву» ends «живу» — I live). «Qashq…» is also the head of Qashqadaryo /
// Қашқадарё — an Uzbek DESTINATION region, the commonest place a Karshi
// customer names — so the Kashgar spelling never runs on into «-adar…».
// «Иу» is the Russian Yiwu, written alone or with an Uzbek case ending
// («Иудан»), and never the start of a longer word.
//
// The coast is listed wide (fix round): a Chinese city missing here read as
// «nothing named», so «Dongguandan Toshkentga» was refused as «qayerdan
// jo'natilishi aytilmagan» — the customer asked where his cargo comes from —
// and a podklyuch job from it landed with no zone and no factory-leg note.
// Each place is written as customers write it: Latin (the Uzbek spellings
// too), Russian, Chinese, Persian.
const L = '(?<![\\p{L}])';
const cn = (place: string, spellings: string, province?: true): Place => ({
  place,
  zone: 'cn',
  re: new RegExp(spellings, 'iu'),
  ...(province ? { province } : {}),
});
const PLACES: readonly Place[] = [
  { place: 'Qashqar', zone: 'kashgar', re: /kashg|qashq(?!adar)|кашг|қашқ(?!адар)|喀什|کاشغر/iu },
  { place: 'Horgos', zone: 'horgos', re: /horgo|xorgo|хорго|霍尔果斯|خورگوس/iu },
  { place: 'Urumchi', zone: null, re: /urumch|урумч|乌鲁木齐|اورومچی/iu },
  {
    place: 'Yiwu',
    zone: 'cn',
    // «ایوو» as well as «ییوو» (fix pass 6): the Persian customers write both, and the avia rule read only one.
    // «You» is how some customers spell Yiwu (the 2026-11-15 live chat: «"You" shahrini aniqlab bera olmadim») — and
    // the commonest word of English, so ONLY in a place's own form: glued to its ending («Youdan», «Youdagi») — no
    // English glues one — or written apart with its capital as a name has it (`cased`).
    re: /(?<!\p{L})(?:yiwu|ivu|иву|иу(?:дан|даги|да|га|нинг)?(?!\p{L})|you(?:dan|dagi)(?!\p{L}))|义乌|ییوو|ایوو/iu,
    // «You dan», «You shahri»: the capital «You» and the Uzbek ending written small — English writes the pronoun
    // small inside a sentence («Hey you dan», «Did you shahar?») and a man's name big («Are you Dan?»). Not after the
    // words that end an English phrase in «You» («Thank You», «See You»).
    cased: /(?<![\p{L}])(?<!(?:[Tt]hank|[Tt]hanks|[Ss]ee|[Ll]ove|[Mm]iss|[Bb]less|[Ww]ith|[Ff]or|[Tt]o)\s+)You\s+(?:dan|sha[hx](?:ri|ar)(?:dan|dagi|da|ga|ning)?)(?![\p{L}])/u,
  },
  cn('Guangzhou', 'guangzhou|guanchjou|guanjou|гуанчжоу|广州|گوانگژو'),
  cn('Foshan', 'foshan|фошань|佛山|فوشان'),
  cn('Shenzhen', 'shenzhen|shenchjen|shenjen|шэньчжэнь|шеньчжень|深圳|شنژن'),
  cn('Shanghai', 'shanghai|shanxay|shanxai|шанхай|上海|شانگهای'),
  cn('Ningbo', 'ningbo|нинбо|宁波|نینگبو'),
  cn('Beijing', `beijing|${L}pekin|${L}пекин|北京|پکن`),
  cn('Dongguan', 'dongguan|dunguan|donguan|дунгуань|东莞|دونگوان'),
  cn('Hangzhou', 'hangzhou|xanchjou|hanchjou|ханчжоу|杭州|هانگژو'),
  cn('Jinhua', 'jinhua|цзиньхуа|金华|جینهوا'),
  cn('Wenzhou', 'wenzhou|venchjou|вэньчжоу|венчжоу|温州'),
  cn('Xiamen', 'xiamen|сямынь|сямэнь|厦门|شیامن'),
  cn('Qingdao', 'qingdao|tsindao|циндао|青岛|چینگدائو'),
  cn('Tianjin', 'tianjin|тяньцзинь|天津|تیانجین'),
  cn('Suzhou', 'suzhou|сучжоу|苏州'),
  cn('Quanzhou', 'quanzhou|цюаньчжоу|泉州'),
  cn('Shantou', 'shantou|шаньтоу|汕头'),
  cn('Zhongshan', 'zhongshan|чжуншань|中山'),
  cn('Linyi', `${L}linyi|${L}линьи|临沂`),
  cn('Baigou', 'baigou|байгоу|白沟'),
  cn('Chengdu', 'chengdu|чэнду|成都'),
  cn('Chongqing', 'chongqing|чунцин|重庆'),
  cn('Wuhan', `${L}wuhan|${L}ухань|武汉`),
  cn('Zhengzhou', 'zhengzhou|чжэнчжоу|郑州'),
  cn('Nanjing', `nanjing|${L}нанкин|南京`),
  cn('Hong Kong', 'hong\\s*kong|gonkong|гонконг|香港|هنگ\\s*کنگ'),
  cn('Guangdong', 'guangdong|guandun|гуандун|广东|گوانگدونگ', true),
  cn('Zhejiang', 'zhejiang|чжэцзян|浙江', true),
  cn('Fujian', 'fujian|фуцзянь|福建', true),
  cn('Jiangsu', 'jiangsu|цзянсу|江苏', true),
  cn('Shandong', 'shandong|шаньдун|山东', true),
];

/**
 * China itself, named with no place in it — in the six languages, with the
 * cases a customer writes it in («Xitoydan», «из Китая», «в Китае»).
 */
const CHINA = /(?<!\p{L})(?:xitoy|hitoy|хитой|кита[йяеюи]|china|chinese)|چین|中国/iu;

/**
 * Where each named place stands in the text — EVERY mention, as written (the Yiwu spelling takes its Uzbek case
 * ending with it: «Иуга»). For a reader that asks what the text says ABOUT the place: run.ts `sendsToChina` tells
 * «Guanchjouga» from «Guanchjoudan», and a reply may say both.
 */
export function originMentions(text: string | null): { place: string; index: number; match: string }[] {
  const t = text ?? '';
  return PLACES.flatMap((p) =>
    readersOf(p).flatMap((re) =>
      [...t.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))].map((m) => ({ place: p.place, index: m.index, match: m[0] })),
    ),
  );
}

/** A place's spellings: its own, and the ones whose case is the reading. */
function readersOf(p: Place): RegExp[] {
  return p.cased ? [p.re, p.cased] : [p.re];
}

/**
 * Where the text names China itself or a Chinese place — every mention, as written: what the destination reader
 * (destination.ts) looks AFTER for the place the cargo goes to («Yiwudan X-ga», «из Китая в X»).
 */
export function chinaMentions(text: string | null): { index: number; match: string }[] {
  const t = text ?? '';
  return [
    ...originMentions(t).map(({ index, match }) => ({ index, match })),
    ...[...t.matchAll(new RegExp(CHINA.source, 'giu'))].map((m) => ({ index: m.index, match: m[0] })),
  ].sort((a, b) => a.index - b.index);
}

/** Every named place in the text, each once, in the list's order. */
export function namedOrigins(text: string | null): { place: string; zone: OriginZone | null }[] {
  const t = text ?? '';
  return PLACES.filter((p) => readersOf(p).some((re) => re.test(t))).map(({ place, zone }) => ({ place, zone }));
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

/**
 * The text names Kashgar (stage 1a J24, his «HOZIRCHA qashqarda yuk qabul qilmaymiz»): cargo is not received there for
 * now, so a truck job that names it is neither priced nor sent to the VED — whatever else the text names beside it,
 * because a job that may start there is one the company does not take. Horgos and Urumchi stay `namesWesternOrigin`'s.
 */
export function namesKashgar(text: string | null): boolean {
  return namedOrigins(text).some((p) => p.zone === 'kashgar');
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
  const provinces = new Set(PLACES.filter((p) => p.province).map((p) => p.place));
  const out = new Set<string>();
  for (const r of rows) {
    for (const p of namedOrigins([r.name, r.code ?? '', r.address ?? ''].join('\n'))) {
      // «Yiwu, Zhejiang» stands in Yiwu: a customer's «Zhejiangdan» names a province, priced from our warehouse.
      if (!provinces.has(p.place)) out.add(p.place);
    }
  }
  return out;
}
