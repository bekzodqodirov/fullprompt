import { ROAD_LEG_POINTS } from './road-geometry';
import type { RouteDef, RoutePoint, RouteSegment } from './engine';

/**
 * Corridor geometry (owner's routes). Points are REAL lon/lat (x = lon,
 * y = lat), so the same data drives both renderers:
 *  - the Leaflet basemap (self-hosted OSM PMTiles — real zoomable map);
 *  - the fallback SVG drawing (shown until the basemap file is downloaded),
 *    which projects lon/lat into a 1000×600 viewBox via toSvg().
 */

/**
 * Equirectangular projection, and the reference latitude that makes it
 * honest (owner: "xarita to'g'ri nisbatlarda bo'lsin").
 *
 * A degree of longitude is shorter than a degree of latitude by cos(lat): at
 * 35°N, 0.819 as long. The old projection scaled x by 16.6 and y by 24 — a
 * ratio of 0.69 — which squeezed the corridor sideways, so China looked
 * narrow and the Uzbek end looked stretched. Scaling x by `SCALE * cos(35°)`
 * puts every distance on the drawing in the right proportion to every other.
 */
const REF_LAT = 35;
const SCALE = 20;
const LON_SCALE = SCALE * Math.cos((REF_LAT * Math.PI) / 180);

/** Drawing extent, in degrees, with a margin for labels. */
const BOX = { west: 66.5, east: 122, north: 45.5, south: 21.5 };

/**
 * Deliberately NOT rounded: the viewBox has to be exactly the projected
 * extent, or the graticule's outermost lines fall a fraction outside the
 * drawing and get clipped.
 */
export const VIEWBOX = {
  w: (BOX.east - BOX.west) * LON_SCALE,
  h: (BOX.north - BOX.south) * SCALE,
};

/** lon/lat → fallback-SVG coordinates, in proportion. */
export function toSvg(p: RoutePoint): { x: number; y: number } {
  return { x: (p.x - BOX.west) * LON_SCALE, y: (BOX.north - p.y) * SCALE };
}

const P = {
  TAS: { x: 69.24, y: 41.31 }, // Tashkent
  AND: { x: 72.34, y: 40.78 }, // Andijan
  OSH: { x: 72.8, y: 40.53 }, // Osh (KG)
  IRK: { x: 73.91, y: 39.68 }, // Irkeshtam border
  KA: { x: 75.98, y: 39.47 }, // Kashgar
  AKS: { x: 80.26, y: 41.17 }, // Aksu
  UCH: { x: 87.62, y: 43.83 }, // Urumqi
  HAM: { x: 93.51, y: 42.83 }, // Hami
  LAN: { x: 103.83, y: 36.06 }, // Lanzhou
  XIA: { x: 108.94, y: 34.34 }, // Xi'an
  CSX: { x: 113.0, y: 28.2 }, // Changsha
  YW: { x: 120.07, y: 29.31 }, // Yiwu
  GZ: { x: 113.26, y: 23.13 }, // Guangzhou
} satisfies Record<string, RoutePoint>;

/**
 * The towns the road actually goes through (round 47, owner's item 10:
 * «to'g'ri liniya bo'yicha emas — marshrut bo'yicha, yo'ldan yursin, huddi
 * navigatordagidek»).
 *
 * Nothing here is a stop and nothing is displayed: these are shape points, so
 * the corridor drawn on the map — and the estimated position walking along it
 * — follows the highway instead of cutting across it. Two stretches made the
 * old drawing plainly wrong to anyone who knows the road: Lanzhou→Hami runs
 * the Hexi corridor, a long arc north-west between the Qilian mountains and
 * the Gobi, and the straight line went through both; and Urumqi→Aksu goes
 * AROUND the Tian Shan through Turpan and Korla, while the straight line flew
 * over a 5,000 m range. Andijan→Tashkent is the same story at home — the
 * Kamchik pass road via Kokand and Angren, not a line over the Fergana rim.
 *
 * They are the road's own towns, not GPS traces: the point is that the line
 * bends where the road bends, not that it is metre-accurate.
 */
const W = {
  // G30/G25, Yiwu → Xi'an.
  HGH: { x: 120.15, y: 30.27 }, // Hangzhou
  NKG: { x: 118.78, y: 32.06 }, // Nanjing
  CGO: { x: 113.63, y: 34.75 }, // Zhengzhou
  // G4/G55, Guangzhou → Changsha → Xi'an.
  SHG: { x: 113.6, y: 24.81 }, // Shaoguan
  HNY: { x: 112.61, y: 26.89 }, // Hengyang
  XFN: { x: 112.14, y: 32.01 }, // Xiangyang
  ANK: { x: 109.03, y: 32.68 }, // Ankang
  // G30, Xi'an → Lanzhou.
  BAO: { x: 107.14, y: 34.36 }, // Baoji
  TSN: { x: 105.72, y: 34.58 }, // Tianshui
  DNX: { x: 104.62, y: 35.58 }, // Dingxi
  // G30, the Hexi corridor: Lanzhou → Hami. Round 98 added the towns BETWEEN
  // the round-47 anchors («faqat 5-6 shahar bo'yicha to'g'ri chiziq» — he was
  // right): the corridor's own line of oasis towns, so the arc bends where
  // the road does instead of jumping 200 km at a time.
  // Round 100 (9a): the Wushaoling pass town — LAN→WUW was the longest chord
  // left, and it is exactly a mountain crossing.
  TZU: { x: 103.14, y: 36.97 }, // Tianzhu
  WUW: { x: 102.63, y: 37.93 }, // Wuwei
  SDN: { x: 101.09, y: 38.79 }, // Shandan
  ZHY: { x: 100.45, y: 38.93 }, // Zhangye
  JIQ: { x: 98.51, y: 39.73 }, // Jiuquan
  JYG: { x: 98.29, y: 39.77 }, // Jiayuguan
  GUA: { x: 95.78, y: 40.52 }, // Guazhou
  XXX: { x: 94.85, y: 41.75 }, // Xingxingxia (the Gansu/Xinjiang gorge)
  // G30, Hami → Urumqi.
  SHS: { x: 90.21, y: 42.87 }, // Shanshan
  TFU: { x: 89.18, y: 42.95 }, // Turpan
  // G3012, around the Tian Shan: Urumqi → Aksu.
  TOK: { x: 88.65, y: 42.79 }, // Toksun
  YNQ: { x: 86.57, y: 42.06 }, // Yanqi
  KRL: { x: 86.15, y: 41.73 }, // Korla
  LUN: { x: 84.25, y: 41.78 }, // Luntai
  KCA: { x: 82.96, y: 41.72 }, // Kuqa
  // G3012, Aksu → Kashgar.
  BCH: { x: 78.55, y: 39.8 }, // Bachu
  // Round 100 (9a): the last bend before Kashgar — without it the BCH→KA
  // chord cut across the Kashgar range's foothills.
  ATX: { x: 76.17, y: 39.72 }, // Artux
  // Kashgar → the Irkeshtam border.
  WUQ: { x: 75.02, y: 39.72 }, // Wuqia
  // M41 through Kyrgyzstan: over the Taldyk pass down to the Gulcha valley.
  SRT: { x: 73.26, y: 39.72 }, // Sary-Tash
  TLD: { x: 73.2, y: 39.85 }, // Taldyk pass
  GUL: { x: 73.44, y: 40.31 }, // Gulcha
  // The Kamchik pass road, Andijan → Tashkent.
  FEG: { x: 70.94, y: 40.53 }, // Kokand
  KMC: { x: 70.55, y: 41.13 }, // Kamchik pass
  ANG: { x: 70.14, y: 41.02 }, // Angren
} satisfies Record<string, RoutePoint>;

/**
 * A route is a list of LEGS, and the point spans are computed rather than
 * counted by hand.
 *
 * They used to be written literally (`span: [1, 2]`), which is why the road
 * shape could not be improved without re-numbering every segment of every
 * route — and getting one index wrong parks a truck on the wrong side of a
 * border with nothing to say so. A leg carries its own points; the builder
 * joins them, drops the duplicate at each seam, and hands each segment the
 * span it landed on. A leg with a single point is stationary — that is the
 * border wait.
 */
interface RouteLeg {
  key: string;
  hours: [number, number];
  points: RoutePoint[];
}

function build(legs: RouteLeg[]): RouteDef {
  const points: RoutePoint[] = [];
  const segments: RouteSegment[] = [];
  for (const leg of legs) {
    const start = points.length === 0 ? 0 : points.length - 1;
    const same =
      points.length > 0 &&
      points[points.length - 1]!.x === leg.points[0]!.x &&
      points[points.length - 1]!.y === leg.points[0]!.y;
    points.push(...(same ? leg.points.slice(1) : leg.points));
    segments.push({ key: leg.key, hours: leg.hours, span: [start, points.length - 1] });
  }
  return { points, segments };
}

/**
 * The REAL road for a leg, when it has been fetched (round 109, the owner's
 * «B»): stored geometry, never a runtime call. A leg with no stored road
 * falls back to its hand-drawn town chain, so an un-fetched or newly-added
 * corridor still draws — degraded, never missing.
 */
function road(key: string): RoutePoint[] | null {
  const pts = ROAD_LEG_POINTS[key];
  return pts && pts.length > 1 ? pts.map(([x, y]) => ({ x, y })) : null;
}

/** The stored road, with a destination dot appended when it ends elsewhere —
 *  TAS2 sits beside TAS1, and the road stops at the city, not at our yard. */
function roadTo(key: string, dest: RoutePoint, fallback: RoutePoint[]): RoutePoint[] {
  const pts = road(key);
  if (!pts) return fallback;
  const last = pts[pts.length - 1]!;
  return last.x === dest.x && last.y === dest.y ? pts : [...pts, dest];
}

/** Warehouse code → map dot. TAS2 sits beside TAS1 so both stay clickable. */
export const WAREHOUSE_POINTS: Record<string, RoutePoint> = {
  YW: P.YW,
  GZ: P.GZ,
  UCH: P.UCH,
  KA: P.KA,
  AND: P.AND,
  TAS1: P.TAS,
  TAS2: { x: P.TAS.x - 0.85, y: P.TAS.y - 0.58 },
};

/** Named dots drawn for context even without a warehouse. */
export const LANDMARKS: { name: string; p: RoutePoint }[] = [
  { name: 'Irkeshtam', p: P.IRK },
  { name: 'Osh', p: P.OSH },
];

/** Leaflet initial view: whole corridor. */
export const MAP_BOUNDS: [[number, number], [number, number]] = [
  [20, 60], // south-west lat,lon
  [47, 125], // north-east
];

/** Xi'an → Kashgar: the G30 and G3012, the way a truck really drives it. */
const CN_SPINE = [
  P.XIA, W.BAO, W.TSN, W.DNX, P.LAN,
  W.TZU, W.WUW, W.SDN, W.ZHY, W.JIQ, W.JYG, W.GUA, W.XXX, P.HAM,
  // Turpan → TOKSUN, never Urumqi (owner, round 109: «YW GZ dan ketadgan yol
  // urumchiga kirmaydi togri qashqarga ketadi»). The G3012 turns south-west
  // at Toksun; going up to Urumqi and back down is ~300 km the road does not
  // drive — and the fetched geometry confirms it, never rising above 43.4°N.
  W.SHS, W.TFU,
  W.TOK, W.YNQ, W.KRL, W.LUN, W.KCA, P.AKS,
  W.BCH, W.ATX, P.KA,
];
/** Andijan → Tashkent over the Kamchik pass. */
const AND_TAS = (dest: RoutePoint) => [P.AND, W.FEG, W.KMC, W.ANG, dest];

/**
 * The legs from Kashgar to an Uzbek warehouse. Split out of `ka2uz` so a
 * THROUGH truck — one batch booked Yiwu → Tashkent, which the app has always
 * allowed — can be drawn as the road it actually takes instead of a straight
 * line across the Taklamakan. It also gives that batch the three checkpoint
 * segments (`border_wait`/`kg`/`uz`), so the card's «где машина» pins have
 * something to re-anchor.
 */
function ka2uzLegs(dest: RoutePoint, uzHours: [number, number]): RouteLeg[] {
  const toBorder = road('ka_irk') ?? [P.KA, W.WUQ, P.IRK];
  // WHERE THE ROAD ENDS, not our own Irkeshtam dot: the stored geometry snaps
  // to the real post a few hundred metres away, and a wait leg holding a
  // DIFFERENT point is a two-point leg the engine walks along — the truck
  // would creep across the border through the whole three-day wait
  // (route-shape's stationary fence caught exactly that).
  const atBorder = toBorder[toBorder.length - 1]!;
  return [
    { key: 'to_border', hours: [12, 24], points: toBorder },
    // Owner: the truck waits at the Chinese border 1–3 days (sometimes more
    // — the manual checkpoint on the batch card corrects this).
    { key: 'border_wait', hours: [24, 72], points: [atBorder] },
    // Prefixed with the wait's own point so the seam dedupes and the drawn
    // line has no gap, whichever half is the stored road.
    { key: 'kg', hours: [36, 48], points: [atBorder, ...(road('irk_osh') ?? [P.IRK, W.SRT, W.GUL, P.OSH])] },
    {
      key: 'uz',
      hours: uzHours,
      // Andijan IS the destination on the short leg — no need to leave it and
      // come back, which is what the old hand-counted spans had to fake.
      points:
        dest === P.AND
          ? roadTo('osh_and', P.AND, [P.OSH, P.AND])
          : roadTo('osh_tas', dest, [P.OSH, ...AND_TAS(dest)]),
    },
  ];
}

function ka2uz(dest: RoutePoint, uzHours: [number, number]): RouteDef {
  return build(ka2uzLegs(dest, uzHours));
}

/** The Chinese leg of a truck that starts at one of the three CN warehouses. */
function cnLeg(origin: string): RouteLeg | null {
  if (origin === 'YW') {
    return {
      key: 'cn_transit',
      hours: [144, 168],
      points: road('yw_ka') ?? [P.YW, W.HGH, W.NKG, W.CGO, ...CN_SPINE],
    };
  }
  if (origin === 'GZ') {
    return {
      key: 'cn_transit',
      hours: [120, 144],
      points: road('gz_ka') ?? [P.GZ, W.SHG, W.HNY, P.CSX, W.XFN, W.ANK, ...CN_SPINE],
    };
  }
  if (origin === 'UCH') {
    return {
      key: 'cn_transit',
      hours: [48, 72],
      points: road('uch_ka') ?? [P.UCH, W.TOK, W.KRL, W.LUN, W.KCA, P.AKS, W.BCH, P.KA],
    };
  }
  return null;
}

/** Typical corridor schedule per origin→dest pair (owner's numbers). */
export function routeFor(originCode: string, destCode: string): RouteDef | null {
  const o = originCode.toUpperCase();
  const d = destCode.toUpperCase();
  const destPoint = WAREHOUSE_POINTS[d];
  if (!destPoint || !WAREHOUSE_POINTS[o]) return null;

  const cn = cnLeg(o);
  if (cn && d === 'KA') return build([cn]);
  if (o === 'KA' && d === 'AND') return ka2uz(P.AND, [12, 24]);
  if (o === 'KA' && (d === 'TAS1' || d === 'TAS2')) {
    return ka2uz(WAREHOUSE_POINTS[d]!, [36, 48]);
  }
  // A through truck: booked in China, unloaded in Uzbekistan, no transfer at
  // Kashgar. Same road, same border wait, hours added rather than invented —
  // and drawn as the road (owner, round 109: «hamma yonalish boyicha va
  // toshkent yonalishi boyicha ham kerak boladi»).
  if (cn && (d === 'AND' || d === 'TAS1' || d === 'TAS2')) {
    return build([
      cn,
      ...ka2uzLegs(d === 'AND' ? P.AND : WAREHOUSE_POINTS[d]!, d === 'AND' ? [12, 24] : [36, 48]),
    ]);
  }
  if (o === 'AND' && (d === 'TAS1' || d === 'TAS2')) {
    return build([
      {
        key: 'uz',
        hours: [12, 24],
        points: roadTo('and_tas', WAREHOUSE_POINTS[d]!, AND_TAS(WAREHOUSE_POINTS[d]!)),
      },
    ]);
  }
  // Any other pair between mapped warehouses: straight line, generic timing.
  // Honest rather than invented — we do not know the road, so we do not draw
  // one, and the label already says the position is approximate.
  return build([{ key: 'transit', hours: [120, 168], points: [WAREHOUSE_POINTS[o]!, destPoint] }]);
}

/** Checkpoint key → the segment it anchors (batch card buttons). */
export const CHECKPOINT_SEGMENTS: Record<string, string> = {
  at_border: 'border_wait',
  in_kg: 'kg',
  in_uz: 'uz',
};

/**
 * A lat/lon grid for the fallback drawing, generated from the projection.
 *
 * It replaces two hand-drawn "country hint" blobs that were never real
 * geography and were drawn against the old, squashed projection — so they
 * became wrong the moment the proportions were fixed. A graticule cannot be
 * wrong: it IS the projection, and it is what makes a schematic read as a
 * map rather than a diagram.
 */
export interface GridLine {
  /** Line ends in SVG space. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
  /** Where to put the label. */
  lx: number;
  ly: number;
}

export function graticule(): { meridians: GridLine[]; parallels: GridLine[] } {
  const meridians: GridLine[] = [];
  for (let lon = 70; lon <= BOX.east; lon += 10) {
    const top = toSvg({ x: lon, y: BOX.north });
    const bottom = toSvg({ x: lon, y: BOX.south });
    meridians.push({
      x1: top.x,
      y1: top.y,
      x2: bottom.x,
      y2: bottom.y,
      label: `${lon}°E`,
      lx: top.x + 4,
      ly: 16,
    });
  }
  const parallels: GridLine[] = [];
  for (let lat = 25; lat <= BOX.north; lat += 5) {
    const left = toSvg({ x: BOX.west, y: lat });
    const right = toSvg({ x: BOX.east, y: lat });
    parallels.push({
      x1: left.x,
      y1: left.y,
      x2: right.x,
      y2: right.y,
      label: `${lat}°N`,
      lx: 4,
      ly: left.y - 4,
    });
  }
  return { meridians, parallels };
}
