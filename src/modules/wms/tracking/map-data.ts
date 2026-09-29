import { ROAD_LEG_POINTS } from './road-geometry';
import type { BorderPost, RouteDef, RoutePoint, RouteSegment } from './engine';

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
  // Horgos (owner, 2026-09-29, answer 12): HIS point, typed on the warehouse
  // row, copied to the digit — the Chinese road ends ON the dot /map draws.
  HOR: { x: 80.459135, y: 44.154112 },
  // The Nur Zholy post, the Kazakh side of the Khorgos crossing — where the
  // truck waits in the queue.
  NZL: { x: 80.3958, y: 44.1577 },
  ALA: { x: 76.8897, y: 43.2389 }, // Almaty
  SHY: { x: 69.5901, y: 42.3417 }, // Shymkent
  // Yallama (his 23a), the Kazakhstan → Uzbekistan post. APPROXIMATE, from a
  // public coordinate: the logist looks at it on /map once and says if the
  // post sits in the wrong spot.
  YAL: { x: 69.3587, y: 41.479 },
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
  // G30, Urumqi → Horgos: the north side of the Tian Shan, past the Sayram
  // lake and down the Guozigou gorge.
  CHJ: { x: 87.3, y: 44.01 }, // Changji
  SHZ: { x: 86.04, y: 44.31 }, // Shihezi
  KYT: { x: 84.9, y: 44.43 }, // Kuytun
  JNG: { x: 82.9, y: 44.6 }, // Jinghe
  SAY: { x: 81.2, y: 44.6 }, // Sayram lake
  GZG: { x: 80.9, y: 44.2 }, // Guozigou
  // A2/M39 through Kazakhstan: Nur Zholy → Almaty → Shymkent → Yallama.
  ZHK: { x: 80.0, y: 44.1667 }, // Zharkent
  KRD: { x: 74.71, y: 43.035 }, // Kordai
  MRK: { x: 73.18, y: 42.87 }, // Merke
  TRZ: { x: 71.3667, y: 42.9 }, // Taraz
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
  /** A queue the logist types by hand replaces this leg's hours (`BORDER_POSTS`). */
  post?: BorderPost;
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
    segments.push({
      key: leg.key,
      hours: leg.hours,
      span: [start, points.length - 1],
      // Only where there is one: every route without a post keeps the exact
      // segment objects it always had.
      ...(leg.post ? { post: leg.post } : {}),
    });
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

/**
 * `pts` joined onto a leg that must start at `at` — without a duplicate
 * point when the fallback chain already starts there. The stored roads end a
 * few hundred metres from our own dots, the hand chains end ON them, and a
 * leg has to begin where the previous one stopped either way.
 */
function from(at: RoutePoint, pts: RoutePoint[]): RoutePoint[] {
  const first = pts[0];
  return first && first.x === at.x && first.y === at.y ? pts : [at, ...pts];
}

/** Warehouse code → map dot. TAS2 sits beside TAS1 so both stay clickable. */
export const WAREHOUSE_POINTS: Record<string, RoutePoint> = {
  YW: P.YW,
  GZ: P.GZ,
  UCH: P.UCH,
  KA: P.KA,
  HOR: P.HOR,
  AND: P.AND,
  TAS1: P.TAS,
  TAS2: { x: P.TAS.x - 0.85, y: P.TAS.y - 0.58 },
};

/** Named dots drawn for context even without a warehouse. */
export const LANDMARKS: { name: string; p: RoutePoint }[] = [
  { name: 'Irkeshtam', p: P.IRK },
  { name: 'Osh', p: P.OSH },
  // The Horgos road through Kazakhstan (his 13a). The Nur Zholy post is 5 km
  // from the HOR dot and would sit on top of it, so it is not drawn.
  { name: 'Almaty', p: P.ALA },
  { name: 'Shymkent', p: P.SHY },
  { name: 'Yallama', p: P.YAL },
];

/**
 * The border posts whose queue the logist types by hand (owner, 2026-09-29,
 * answer 14), with his default wait in hours — ONE home, read by the legs
 * below AND by the /trucks panel's «Odatdagi: …», so the default a person
 * reads is the default the ETA uses.
 *
 * Khorgos «3 kuncha» = 60-84 h; Yallama «3-4 kun» = 72-96 h. The Kashgar
 * road's Irkeshtam wait is deliberately NOT here — his answer 9a: the Kashgar
 * trucks keep their pin (adding it later is one line).
 */
export const BORDER_POSTS = {
  khorgos: [60, 84],
  yallama: [72, 96],
} as const satisfies Record<BorderPost, readonly [number, number]>;

export const BORDER_POST_KEYS = Object.keys(BORDER_POSTS) as BorderPost[];

/** Leaflet initial view: whole corridor. */
export const MAP_BOUNDS: [[number, number], [number, number]] = [
  [20, 60], // south-west lat,lon
  [47, 125], // north-east
];

/**
 * Xi'an → Turpan: the G30, the road every Chinese truck of ours shares
 * whichever border it is heading for. Split out of the Kashgar spine
 * (value-identical — `CN_SPINE` below is the two halves joined) so the Horgos
 * road can turn north at Turpan instead of restating eight hundred
 * kilometres of Hexi corridor.
 */
const CN_TRUNK = [
  P.XIA, W.BAO, W.TSN, W.DNX, P.LAN,
  W.TZU, W.WUW, W.SDN, W.ZHY, W.JIQ, W.JYG, W.GUA, W.XXX, P.HAM,
  W.SHS, W.TFU,
];
/**
 * Turpan → Kashgar. Turpan → TOKSUN, never Urumqi (owner, round 109: «YW GZ
 * dan ketadgan yol urumchiga kirmaydi togri qashqarga ketadi»). The G3012
 * turns south-west at Toksun; going up to Urumqi and back down is ~300 km the
 * road does not drive — and the fetched geometry confirms it, never rising
 * above 43.4°N.
 */
const KA_TAIL = [
  W.TOK, W.YNQ, W.KRL, W.LUN, W.KCA, P.AKS,
  W.BCH, W.ATX, P.KA,
];
/** Xi'an → Kashgar: the G30 and G3012, the way a truck really drives it. */
const CN_SPINE = [...CN_TRUNK, ...KA_TAIL];
/**
 * Urumqi → Horgos: the Horgos road DOES go through Urumqi (the Kashgar one
 * does not), then west along the G30 north of the Tian Shan.
 */
const HOR_TAIL = [P.UCH, W.CHJ, W.SHZ, W.KYT, W.JNG, W.SAY, W.GZG, P.HOR];
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

/**
 * Horgos → an Uzbek warehouse through Kazakhstan (owner, 2026-09-29, answers
 * 13a, 14 and 23a): the Khorgos post, Almaty, Shymkent, the Yallama post,
 * Tashkent — and Andijan on over the Kamchik pass.
 *
 * TWO queues, each a stationary leg holding exactly the previous leg's last
 * point (the wait-point pattern of `ka2uzLegs`, verbatim — a wait on a
 * different point is a leg the engine walks along, and the truck creeps
 * across the border through the whole queue). Each carries its `post`, so
 * the logist's typed number replaces its hours (`routeWithWaits`).
 */
function hor2uzLegs(dest: RoutePoint): RouteLeg[] {
  // His «~3 days at the China border» starts once the truck is at the post:
  // the 5 km from our yard to it is its own short leg.
  const atCn = P.NZL;
  const kzRoad = road('nzl_yal') ?? [P.NZL, W.ZHK, P.ALA, W.KRD, W.MRK, W.TRZ, P.SHY, P.YAL];
  // WHERE THE KAZAKH ROAD ENDS, not our Yallama dot (the same reason as
  // `ka2uzLegs`' atBorder): the queue must hold the kz leg's own last point.
  const atUz = kzRoad[kzRoad.length - 1]!;
  const toUz =
    dest === P.AND
      ? [
          ...from(atUz, road('yal_tas') ?? [P.YAL, P.TAS]),
          ...reverse(road('and_tas') ?? AND_TAS(P.TAS)),
        ]
      : from(atUz, roadTo('yal_tas', dest, [P.YAL, dest]));
  return [
    { key: 'to_border', hours: [1, 3], points: [P.HOR, P.NZL] },
    { key: 'border_wait', hours: [...BORDER_POSTS.khorgos], points: [atCn], post: 'khorgos' },
    // «keyin 1 kun yolda oxb chegaragacha».
    { key: 'kz', hours: [18, 30], points: from(atCn, kzRoad) },
    // «3-4 kun ozbga kiriw ochered».
    { key: 'uz_queue', hours: [...BORDER_POSTS.yallama], points: [atUz], post: 'yallama' },
    {
      key: 'uz',
      // Yallama → Tashkent is a hundred kilometres; Andijan is the Kamchik
      // pass on top of it, the same road `AND_TAS` draws the other way.
      hours: dest === P.AND ? [14, 30] : [2, 6],
      points: dropRepeats(toUz),
    },
  ];
}

/** A stored or hand-drawn chain, driven the other way. */
function reverse(pts: RoutePoint[]): RoutePoint[] {
  return [...pts].reverse();
}

/** Consecutive duplicates out — a zero-length chord is a point the dot sits on for nothing. */
function dropRepeats(pts: RoutePoint[]): RoutePoint[] {
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1]!.x || p.y !== pts[i - 1]!.y);
}

/**
 * The Chinese leg of a truck that starts at one of the three CN warehouses,
 * heading for one of the two hubs a truck unloads at (his 21a: no direct
 * trucks — every truck unloads at Horgos or Kashgar).
 */
function cnLeg(origin: string, hub: 'KA' | 'HOR'): RouteLeg | null {
  if (hub === 'HOR') {
    // «6-7 kun» from Yiwu or Guangzhou (answer 14).
    if (origin === 'YW') {
      return {
        key: 'cn_transit',
        hours: [144, 168],
        points: road('yw_hor') ?? [P.YW, W.HGH, W.NKG, W.CGO, ...CN_TRUNK, ...HOR_TAIL],
      };
    }
    if (origin === 'GZ') {
      return {
        key: 'cn_transit',
        hours: [144, 168],
        points: road('gz_hor') ?? [P.GZ, W.SHG, W.HNY, P.CSX, W.XFN, W.ANK, ...CN_TRUNK, ...HOR_TAIL],
      };
    }
    if (origin === 'UCH') {
      // ~650 km of G30: our estimate, which he confirmed (answer 7, «ha»).
      return { key: 'cn_transit', hours: [12, 24], points: road('uch_hor') ?? HOR_TAIL };
    }
    return null;
  }
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

  const cn = cnLeg(o, 'KA');
  if (cn && d === 'KA') return build([cn]);
  // The Horgos road (0118's round). Before the generic line, which would
  // otherwise answer both with a placeholder «5-7 kun» straight across the
  // Tian Shan. KA ↔ HOR stays generic: nobody described that road.
  const toHor = d === 'HOR' ? cnLeg(o, 'HOR') : null;
  if (toHor) return build([toHor]);
  if (o === 'HOR' && (d === 'AND' || d === 'TAS1' || d === 'TAS2')) {
    return build(hor2uzLegs(d === 'AND' ? P.AND : WAREHOUSE_POINTS[d]!));
  }
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

/**
 * The positions the batch card's «где машина» pins can record — ONE list
 * (it used to be restated in six places, and `checkpointOf` silently dropped
 * any key a copy lacked). Which of them a given truck is OFFERED is its road's
 * question (`checkpointsFor`, eta.ts): the Kashgar road passes Kyrgyzstan,
 * the Horgos road Kazakhstan.
 */
export const CHECKPOINT_KEYS = ['at_border', 'in_kg', 'in_kz', 'in_uz'] as const;
export type CheckpointKey = (typeof CHECKPOINT_KEYS)[number];

/** Checkpoint key → the segment it anchors (batch card buttons). */
export const CHECKPOINT_SEGMENTS: Record<CheckpointKey, string> = {
  at_border: 'border_wait',
  in_kg: 'kg',
  in_kz: 'kz',
  in_uz: 'uz',
};

/**
 * A pin as a person reads it — one home for the Mashina tab's buttons and
 * badge, the dashboard's road line and /trucks (three hand-written copies
 * before). `label` is a `batches.*` key; a Record, so a fifth key that
 * forgets its label fails `pnpm typecheck`.
 */
export const CHECKPOINT_LABEL: Record<
  CheckpointKey,
  { icon: string; label: 'cpBorder' | 'cpKg' | 'cpKz' | 'cpUz' }
> = {
  at_border: { icon: '🛃', label: 'cpBorder' },
  in_kg: { icon: '🇰🇬', label: 'cpKg' },
  in_kz: { icon: '🇰🇿', label: 'cpKz' },
  in_uz: { icon: '🇺🇿', label: 'cpUz' },
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
