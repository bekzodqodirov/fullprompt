import type { RouteDef, RoutePoint } from './engine';

/**
 * Hand-drawn corridor geometry (owner's routes, DECISIONS: self-hosted SVG —
 * no external map tiles, must open instantly in China). Coordinates are a
 * linear lon/lat projection into a 1000×600 viewBox:
 *   x = (lon − 66) × 16.6,  y = (45 − lat) × 24.
 */

export const VIEWBOX = { w: 1000, h: 600 };

const P = {
  TAS: { x: 53, y: 89 }, // Tashkent 69.2E 41.3N
  AND: { x: 105, y: 101 }, // Andijan 72.3E 40.8N
  OSH: { x: 113, y: 108 }, // Osh (KG)
  IRK: { x: 131, y: 127 }, // Irkeshtam border
  KA: { x: 166, y: 132 }, // Kashgar
  AKS: { x: 237, y: 91 }, // Aksu
  UCH: { x: 359, y: 29 }, // Urumqi
  HAM: { x: 457, y: 53 }, // Hami
  LAN: { x: 627, y: 216 }, // Lanzhou
  XIA: { x: 712, y: 257 }, // Xi'an
  CSX: { x: 780, y: 403 }, // Changsha
  YW: { x: 898, y: 377 }, // Yiwu
  GZ: { x: 785, y: 526 }, // Guangzhou
} satisfies Record<string, RoutePoint>;

/** Warehouse code → map dot. TAS2 sits beside TAS1 so both stay clickable. */
export const WAREHOUSE_POINTS: Record<string, RoutePoint> = {
  YW: P.YW,
  GZ: P.GZ,
  UCH: P.UCH,
  KA: P.KA,
  AND: P.AND,
  TAS1: P.TAS,
  TAS2: { x: P.TAS.x - 14, y: P.TAS.y + 14 },
};

/** Named dots drawn on the map even without a warehouse (context). */
export const LANDMARKS: { name: string; p: RoutePoint }[] = [
  { name: 'Irkeshtam', p: P.IRK },
  { name: 'Osh', p: P.OSH },
];

const CN_SPINE = [P.XIA, P.LAN, P.HAM, P.UCH, P.AKS, P.KA];

function ka2uz(dest: RoutePoint, uzHours: [number, number]): Omit<RouteDef, 'points'> & {
  points: RoutePoint[];
} {
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

/** Decorative country outlines (very rough, purely visual context). */
export const DECOR_PATHS: string[] = [
  // UZ / KG hint
  'M 10 60 L 90 55 L 150 95 L 150 150 L 60 140 L 10 110 Z',
  // China hint
  'M 155 160 L 240 60 L 340 5 L 520 15 L 700 120 L 900 250 L 950 420 L 830 570 L 700 560 L 560 470 L 350 300 L 180 190 Z',
];
