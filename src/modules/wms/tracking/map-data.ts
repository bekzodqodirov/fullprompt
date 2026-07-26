import type { RouteDef, RoutePoint } from './engine';

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

const CN_SPINE = [P.XIA, P.LAN, P.HAM, P.UCH, P.AKS, P.KA];

function ka2uz(dest: RoutePoint, uzHours: [number, number]): RouteDef {
  return {
    points: [P.KA, P.IRK, P.OSH, P.AND, dest],
    segments: [
      { key: 'to_border', hours: [12, 24], span: [0, 1] },
      // Owner: the truck waits at the Chinese border 1–3 days (sometimes more
      // — the manual checkpoint on the batch card corrects this).
      { key: 'border_wait', hours: [24, 72], span: [1, 1] },
      { key: 'kg', hours: [36, 48], span: [1, 2] },
      { key: 'uz', hours: uzHours, span: [2, 4] },
    ],
  };
}

/** Typical corridor schedule per origin→dest pair (owner's numbers). */
export function routeFor(originCode: string, destCode: string): RouteDef | null {
  const o = originCode.toUpperCase();
  const d = destCode.toUpperCase();
  const destPoint = WAREHOUSE_POINTS[d];
  if (!destPoint || !WAREHOUSE_POINTS[o]) return null;

  if (o === 'YW' && d === 'KA') {
    return {
      points: [P.YW, ...CN_SPINE],
      segments: [{ key: 'cn_transit', hours: [144, 168], span: [0, 6] }],
    };
  }
  if (o === 'GZ' && d === 'KA') {
    return {
      points: [P.GZ, P.CSX, ...CN_SPINE],
      segments: [{ key: 'cn_transit', hours: [120, 144], span: [0, 7] }],
    };
  }
  if (o === 'UCH' && d === 'KA') {
    return {
      points: [P.UCH, P.AKS, P.KA],
      segments: [{ key: 'cn_transit', hours: [48, 72], span: [0, 2] }],
    };
  }
  if (o === 'KA' && d === 'AND') {
    const r = ka2uz(P.AND, [12, 24]);
    // Destination IS Andijan — trim the trailing duplicate point.
    return { points: r.points.slice(0, 4), segments: r.segments.map((s) => ({ ...s, span: [Math.min(s.span[0], 3), Math.min(s.span[1], 3)] as [number, number] })) };
  }
  if (o === 'KA' && (d === 'TAS1' || d === 'TAS2')) {
    return ka2uz(WAREHOUSE_POINTS[d]!, [36, 48]);
  }
  if (o === 'AND' && (d === 'TAS1' || d === 'TAS2')) {
    return {
      points: [P.AND, WAREHOUSE_POINTS[d]!],
      segments: [{ key: 'uz', hours: [12, 24], span: [0, 1] }],
    };
  }
  // Any other pair between mapped warehouses: straight line, generic timing.
  return {
    points: [WAREHOUSE_POINTS[o]!, destPoint],
    segments: [{ key: 'transit', hours: [120, 168], span: [0, 1] }],
  };
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
