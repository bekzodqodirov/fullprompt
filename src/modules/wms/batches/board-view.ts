import { countryKey } from './country-key';
import { cumulativeLengths, type RouteDef } from '../tracking/engine';
import { zoneOfLeg, zoneOfWarehouse, type RoadZone } from '../tracking/place';

/**
 * The batch board's arithmetic — which column, which section, which stop on
 * the road strip, what the filters keep (docs/PARTIYA-DOSKASI.md §3, his 1A
 * 2a 3a 9b). Pure: no database, no clock, no words, so every judgement is a
 * table test and the page only draws.
 *
 * The board is built from CARDS — a truck (`batch`) or a factory trip
 * (`trip`, 9b: in the column it matches, with its badge) — that the reader
 * (`board.ts`) has already placed: every truck on the road carries the place
 * `placeTruck` gave it, and nothing here estimates anything.
 */

/**
 * The road is TWO columns (his 2026-10-21: «yolda deganini xitoy ichidagi va
 * tashqisi alohida column qilishimiz kerak — hargoz va qashqarga
 * ketayotganlar va ulardan boshqa joyga ketayotganlarini»): `inland` = a trip
 * whose destination is in China (Kashgar, Horgos, any other Chinese
 * warehouse — `roadColumnOf`), `outbound` = every other trip on the road
 * (Uzbekistan, an Uzbek internal leg, anything else).
 */
export const BOARD_COLUMNS = ['forming', 'loading', 'inland', 'outbound', 'arrived'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const ROAD_COLUMNS = ['inland', 'outbound'] as const;
export type RoadColumn = (typeof ROAD_COLUMNS)[number];

export const isRoadColumn = (column: BoardColumn): column is RoadColumn =>
  (ROAD_COLUMNS as readonly string[]).includes(column);

/** Where a truck or a factory trip is going decides its road column: China → `inland`, anything else → `outbound`. */
export function roadColumnOf(destCountry: string | null | undefined): RoadColumn {
  return countryKey(destCountry) === 'CN' ? 'inland' : 'outbound';
}

/**
 * The phone's tabs (below `xl`): the board's columns, the two road columns
 * under ONE «Yo'lda» tab, each half under its own heading — five tabs on a
 * 360 px phone cut «Shakllanmoqda» mid-word.
 */
export const BOARD_TABS = ['forming', 'loading', 'road', 'arrived'] as const;
export type BoardTab = (typeof BOARD_TABS)[number];

export const tabOf = (column: BoardColumn): BoardTab => (isRoadColumn(column) ? 'road' : column);

/** A tab's number: every card its columns hold — the road tab is inland plus outbound. */
export function tabCounts(columns: readonly { key: BoardColumn; count: number }[]): Record<BoardTab, number> {
  const out: Record<BoardTab, number> = { forming: 0, loading: 0, road: 0, arrived: 0 };
  for (const column of columns) out[tabOf(column.key)] += column.count;
  return out;
}

/** A place, or «Joyi aniq emas». */
export type BoardPlace = RoadZone | 'unknown';

/**
 * A section inside a column: a place, or — in the `inland` column — the
 * destination warehouse the trip is heading for (`to:<warehouse id>`, his
 * «hargoz va qashqarga ketayotganlar»: every card in that column is inside
 * China, so a place section would be one heading over everything).
 */
export type BoardSection = BoardPlace | `to:${string}`;

export const toSection = (warehouseId: string): BoardSection => `to:${warehouseId}`;

/**
 * The sections each column offers, in road order; `inland` groups by
 * destination (`destination`). A warehouse is never «in transit»
 * (`zoneOfWarehouse` has no such answer), so only the outbound road has that
 * section; every place column has the catch-all, or a truck from a warehouse
 * with an unexpected country would vanish from the board.
 */
export const COLUMN_SECTIONS: Record<BoardColumn, readonly BoardPlace[] | 'destination'> = {
  forming: ['cn', 'border', 'uz', 'unknown'],
  loading: ['cn', 'border', 'uz', 'unknown'],
  inland: 'destination',
  outbound: ['cn', 'border', 'transit', 'uz', 'unknown'],
  arrived: ['cn', 'border', 'uz', 'unknown'],
};

/** The road strip (2a): one stop per place a truck can be. */
export const STRIP_STOPS = [
  'forming',
  'loading',
  'road_cn',
  'road_border',
  'road_transit',
  'road_uz',
  'road_unknown',
  'arrived',
] as const;
export type StripStop = (typeof STRIP_STOPS)[number];

/** `?yonalish=`: the corridor, named by the legs it drives. */
export const ROUTE_FILTERS = ['irkeshtam', 'horgos', 'ichki'] as const;
export type RouteFilter = (typeof ROUTE_FILTERS)[number];

export const CARD_WARNINGS = ['count', 'overdue', 'stuck', 'stale'] as const;
/**
 * What a card warns about (`?ogoh=1`): a QR-siz lot nobody counted
 * (`count`), a truck past its schedule (`overdue`), one standing unloaded at
 * its gate (`stuck`), a factory trip arrived and still open (`stale`).
 */
export type CardWarning = (typeof CARD_WARNINGS)[number];

/** What the board needs of a card to place, filter and order it. */
export interface CardPlacement {
  key: string;
  code: string;
  column: BoardColumn;
  section: BoardSection;
  /**
   * Where the card IS — the strip's stop. On the outbound road it is the
   * section; on the inland road the section is the destination, and the
   * place is still `placeTruck`'s.
   */
  place: BoardPlace;
  /** The destination's name and whether it is a border hub — the inland column's headings and their order. */
  destName: string;
  destHub: boolean;
  /** On the road: which third country, for the strip's «Qirg'iziston N · Qozog'iston N». */
  transitLeg: 'kg' | 'kz' | null;
  /** The warehouses `?sklad=` matches: a truck's two ends, a trip's destination. */
  warehouseIds: string[];
  route: RouteFilter | null;
  internal: boolean;
  warnings: CardWarning[];
  /** Ascending within a section; ties by code. */
  order: number;
}

export interface BoardFilters {
  sklad: string | null;
  yonalish: RouteFilter | null;
  ogoh: boolean;
  joy: StripStop | null;
}

/** First value or nothing: `?q=a&q=b` arrives as an array (the old page's 500). */
const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * The URL's filters, every value validated (#514): a warehouse only from the
 * viewer's own options — a uuid of a warehouse they may not see is dropped,
 * never echoed back as a chip — and the rest from their closed lists.
 */
export function readBoardFilters(
  params: Record<string, string | string[] | undefined>,
  warehouseOptions: readonly string[],
): BoardFilters {
  const sklad = first(params.sklad);
  const yonalish = first(params.yonalish);
  const joy = first(params.joy);
  return {
    sklad: sklad && warehouseOptions.includes(sklad) ? sklad : null,
    yonalish: (ROUTE_FILTERS as readonly string[]).includes(yonalish ?? '') ? (yonalish as RouteFilter) : null,
    ogoh: first(params.ogoh) === '1',
    joy: (STRIP_STOPS as readonly string[]).includes(joy ?? '') ? (joy as StripStop) : null,
  };
}

/**
 * The strip stop a card stands at — its PLACE, in either road column: the
 * strip is the road as a line, and a Yiwu → Tashkent truck still in China
 * stands at «Xitoy ichida» beside the Yiwu → Kashgar ones.
 */
export function stopOf(card: Pick<CardPlacement, 'column' | 'place'>): StripStop {
  if (card.column === 'forming' || card.column === 'loading' || card.column === 'arrived') return card.column;
  return card.place === 'unknown' ? 'road_unknown' : (`road_${card.place}` as StripStop);
}

/**
 * Which column a stop opens when nothing stands at it (a stop that is still
 * the active filter after its last truck moved on). With something there,
 * the board opens the first column holding it — «Xitoy ichida» holds inland
 * AND outbound trucks.
 */
export function columnOfStop(stop: StripStop): BoardColumn {
  if (stop === 'road_cn') return 'inland';
  return stop.startsWith('road_') ? 'outbound' : (stop as BoardColumn);
}

/** A warehouse-standing card's section: its warehouse's place, or the catch-all. */
export function warehouseSection(country: string | null, type: string | null): BoardPlace {
  return zoneOfWarehouse(country, type) ?? 'unknown';
}

/**
 * A factory trip ON THE ROAD is inside the country of its destination: a
 * factory truck drives a Chinese road to our warehouse and never stands in a
 * border queue, so a trip heading for Kashgar is «Xitoy ichida», not
 * «Chegarada» (the board's review, D12). Planned and arrived trips stand at
 * their destination and take its place.
 */
export function tripRoadSection(destCountry: string | null): BoardPlace {
  const c = countryKey(destCountry);
  return c === 'UZ' ? 'uz' : c === 'CN' ? 'cn' : 'unknown';
}

/**
 * The corridor a truck drives, by the legs of its road and never by «the
 * border leg has no post» — the Irkeshtam queue is «one line» away from
 * getting a post (map-data.ts), and a negative rule would drop every Kashgar
 * truck from its own filter that day.
 */
export function routeFilterOf(route: RouteDef | null): RouteFilter | null {
  if (!route) return null;
  if (route.segments.some((s) => s.key === 'kg')) return 'irkeshtam';
  if (route.segments.some((s) => s.key === 'kz')) return 'horgos';
  return null;
}

export interface BoardSectionView<T> {
  key: BoardSection;
  /** A destination section's warehouse name; a place section is named by the page. */
  destName: string | null;
  cards: T[];
}

export interface BoardColumnView<T> {
  key: BoardColumn;
  count: number;
  sections: BoardSectionView<T>[];
}

export interface StripView {
  stop: StripStop;
  count: number;
  /** Only on `road_transit`: how many of them in each third country. */
  kg: number;
  kz: number;
}

export interface BoardView<T> {
  columns: BoardColumnView<T>[];
  strip: StripView[];
  /** Cards the filters (all but `joy`) keep — the strip counts these. */
  total: number;
  /** The column a phone opens on: the strip's stop's, else the first with a card. */
  activeColumn: BoardColumn;
}

/**
 * Filter, count and lay out. The strip counts with every filter but `joy`
 * — a tap must not turn every other stop into a zero — from the SAME cards
 * the columns draw (#513), so a stop's number is the cards it opens.
 */
export function assembleBoard<T extends CardPlacement>(cards: T[], filters: BoardFilters): BoardView<T> {
  const kept = cards.filter(
    (c) =>
      (!filters.sklad || c.warehouseIds.includes(filters.sklad)) &&
      (!filters.yonalish ||
        (filters.yonalish === 'ichki' ? c.internal : c.route === filters.yonalish)) &&
      (!filters.ogoh || c.warnings.length > 0),
  );
  const strip: StripView[] = STRIP_STOPS.map((stop) => {
    const at = kept.filter((c) => stopOf(c) === stop);
    return {
      stop,
      count: at.length,
      kg: at.filter((c) => c.transitLeg === 'kg').length,
      kz: at.filter((c) => c.transitLeg === 'kz').length,
    };
  });
  const shown = filters.joy ? kept.filter((c) => stopOf(c) === filters.joy) : kept;
  const byOrder = (a: T, b: T) => a.order - b.order || a.code.localeCompare(b.code);
  const columns = BOARD_COLUMNS.map((key) => {
    const inColumn = shown.filter((c) => c.column === key);
    const offered = COLUMN_SECTIONS[key];
    return {
      key,
      count: inColumn.length,
      sections:
        offered === 'destination'
          ? destinationSections(inColumn, byOrder)
          : offered
              .map((section) => ({
                key: section as BoardSection,
                destName: null,
                cards: inColumn.filter((c) => c.section === section).sort(byOrder),
              }))
              .filter((s) => s.cards.length > 0),
    };
  });
  // The first column holding what is shown: a strip tap on «Xitoy ichida»
  // may hold inland and outbound trucks both, and a tap that leaves the
  // phone on an empty tab is a tap that did nothing.
  const firstWithCards = columns.find((c) => c.count > 0)?.key;
  const activeColumn = filters.joy
    ? (firstWithCards ?? columnOfStop(filters.joy))
    : (firstWithCards ?? 'forming');
  return { columns, strip, total: kept.length, activeColumn };
}

/**
 * The inland column's sections: one per destination, the border hubs first
 * (Kashgar, Horgos — what he named), then by name. Every destination with a
 * card gets its heading, so a new Chinese warehouse needs no code.
 */
function destinationSections<T extends CardPlacement>(
  cards: T[],
  byOrder: (a: T, b: T) => number,
): BoardSectionView<T>[] {
  const groups = new Map<BoardSection, T[]>();
  for (const card of cards) groups.set(card.section, [...(groups.get(card.section) ?? []), card]);
  return [...groups.entries()]
    .map(([key, list]) => ({ key, destName: list[0]!.destName, hub: list[0]!.destHub, cards: list.sort(byOrder) }))
    .sort((a, b) => Number(b.hub) - Number(a.hub) || a.destName.localeCompare(b.destName) || a.key.localeCompare(b.key))
    .map(({ key, destName, cards: list }) => ({ key, destName, cards: list }));
}

/** One stretch of a road's bar: a place and where it starts and ends, 0..1 of the length. */
export interface RoadBand {
  zone: RoadZone | null;
  from: number;
  to: number;
}

/**
 * The bar under a truck on the road, split into its route's places BY
 * DISTANCE (4a) — the same length the % is a share of. A queue has no
 * length, so it is a notch at its post rather than a band of its own: drawn
 * as a band it would be zero pixels wide and the «Chegarada» colour would
 * never appear (the board's review, D10). Consecutive legs in one place merge.
 */
export function roadBands(route: RouteDef): { bands: RoadBand[]; notches: number[] } {
  const cum = cumulativeLengths(route.points);
  const total = cum[cum.length - 1] ?? 0;
  if (total <= 0) return { bands: [], notches: [] };
  const bands: RoadBand[] = [];
  const notches: number[] = [];
  for (const seg of route.segments) {
    const from = cum[seg.span[0]]! / total;
    const to = cum[seg.span[1]]! / total;
    if (seg.span[0] === seg.span[1]) {
      notches.push(from);
      continue;
    }
    const zone = zoneOfLeg(seg.key);
    const last = bands[bands.length - 1];
    if (last && last.zone === zone && Math.abs(last.to - from) < 1e-9) last.to = to;
    else bands.push({ zone, from, to });
  }
  return { bands, notches };
}

/** A count with its two measures — the board's own copy of `LoadMeasure`'s shape (this file stays pure). */
export interface CargoMeasure {
  boxes: number;
  kg: number;
  m3: number;
}

/**
 * The ONE box count a truck card prints (docs/PARTIYA-DOSKASI.md §3, 7a),
 * decided here so every branch is a table test — the review found two of
 * the card's fixes guarded by nothing that could fail.
 *
 * - forming: the plan; loading: what is aboard of the plan, «hammasi
 *   yuklandi» when it is all aboard;
 * - a quick truck (no `load_plans` row names it) has no plan: everything on
 *   the pointer IS the scanned cargo, so «a / b» would read «1 / 1 · hammasi
 *   yuklandi» from its first carton with fifty on the floor — it says what
 *   was scanned, with nothing to divide it by;
 * - on the road: what RODE; at the gate: «a / b» off, and the measures are
 *   the whole truck's, named as such («jami») — the m³ that came off is not
 *   known per carton here, and a bare «12 m³» beside «10 / 40» reads as the
 *   ten's (the review).
 */
export type CargoLine =
  | { kind: 'planNone' }
  | { kind: 'loadedNoPlan'; loaded: CargoMeasure }
  | { kind: 'plan'; planned: CargoMeasure }
  | { kind: 'loaded'; loaded: CargoMeasure; planned: CargoMeasure; all: boolean }
  | { kind: 'rode'; rode: CargoMeasure }
  | { kind: 'unloaded'; off: number; rode: CargoMeasure };

export function cargoLineOf(card: {
  status: string;
  hasPlan: boolean;
  load: { loaded: CargoMeasure; planned: CargoMeasure } | null;
  rode: CargoMeasure | null;
  awaitingUnload: number | null;
}): CargoLine | null {
  if (card.status === 'forming' || card.status === 'loading') {
    const load = card.load;
    if (!card.hasPlan) {
      return load && load.loaded.boxes > 0 ? { kind: 'loadedNoPlan', loaded: load.loaded } : { kind: 'planNone' };
    }
    if (!load || load.planned.boxes === 0) return { kind: 'planNone' };
    if (card.status === 'forming') return { kind: 'plan', planned: load.planned };
    return { kind: 'loaded', loaded: load.loaded, planned: load.planned, all: load.loaded.boxes === load.planned.boxes };
  }
  if (!card.rode) return null;
  if (card.status !== 'arrived') return { kind: 'rode', rode: card.rode };
  return { kind: 'unloaded', off: Math.max(0, card.rode.boxes - (card.awaitingUnload ?? 0)), rode: card.rode };
}

/**
 * «0.13 m³ · 25 kg» — ONE spelling for every card on the board (the plan,
 * what rode, what was unloaded, a trip): cubes first, as his 7a reads
 * («necha kub necha kg»), two places of m³ and whole kilos. The first version
 * borrowed the truck header's `cargoLine` («kg · m³») for some lines and wrote
 * «m³ · kg» in others, so the two figures swapped places between columns.
 */
export function measureLine(m3: number, kg: number): string {
  return `${Math.round(m3 * 100) / 100} m³ · ${Math.round(kg)} kg`;
}

/** «14.10» in Tashkent — the office's clock (R5), locale-free like every printed date here. */
export function boardDay(at: Date | string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Tashkent',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}.${get('month')}`;
}

/**
 * «12–14.10» (one month), «30.09–02.10» (two), «14.10» (one day) — the first
 * and the last carton (his 6c). Never a locale's own range: ru prints
 * «12.10», uz «12/10», en and zh «10/12» (measured), and a loading date that
 * reads month-first in two of the four languages is a wrong date.
 */
export function boardRange(firstAt: Date | string, lastAt: Date | string): string {
  const a = boardDay(firstAt);
  const b = boardDay(lastAt);
  if (a === b) return a;
  const [ad, am] = a.split('.');
  const [, bm] = b.split('.');
  return am === bm ? `${ad}–${b}` : `${a}–${b}`;
}

/**
 * A driver's number as a `tel:` target: digits only, the leading «+» kept —
 * the field is free text («+998 90 123-45-67 (Akmal)»), and a `tel:` with a
 * name in it dials nothing on half the phones. Null when fewer than seven
 * digits are left: that is a note, not a number.
 */
export function telOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return `${raw.trim().startsWith('+') ? '+' : ''}${digits}`;
}
