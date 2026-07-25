import type { RouteDef, RoutePoint } from './engine';

/**
 * Corridor geometry (owner's routes). Points are REAL lon/lat (x = lon,
 * y = lat), so the same data drives both renderers:
 *  - the Leaflet basemap (self-hosted OSM PMTiles — real zoomable map);
 *  - the fallback SVG drawing (shown until the basemap file is downloaded),
 *    which projects lon/lat into a 1000×600 viewBox via toSvg().
 */

export const VIEWBOX = { w: 1000, h: 600 };

/** lon/lat → fallback-SVG coordinates. */
export function toSvg(p: RoutePoint): { x: number; y: number } {
  return { x: (p.x - 66) * 16.6, y: (45 - p.y) * 24 };
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

/** Decorative country outlines for the FALLBACK SVG (already projected). */
export const DECOR_PATHS: string[] = [
  // UZ / KG hint
  'M 10 60 L 90 55 L 150 95 L 150 150 L 60 140 L 10 110 Z',
  // China hint
  'M 155 160 L 240 60 L 340 5 L 520 15 L 700 120 L 900 250 L 950 420 L 830 570 L 700 560 L 560 470 L 350 300 L 180 190 Z',
];
