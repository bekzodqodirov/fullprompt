/**
 * The factory map's pure half (owner, 2026-09-24: «adreslari bilan
 * kiritilsin xitoychada va mapda o'zi topib olsa» and D1 «route bo'yicha
 * navigatsiyaga o'xshagan liniya chizilsin»). Zero imports on purpose:
 * everything here is arithmetic and parsing, tested without a network —
 * this container cannot reach any geocoder or router, and the runner can,
 * so a test that touched one would resolve differently in the two (#278).
 * The fetch itself is a thin shell in `geo-fetch.ts`.
 *
 * Coordinates are [lng, lat] pairs throughout, the order OSRM, GeoJSON and
 * Amap all speak.
 */

export type LngLat = [number, number];

// ---------------------------------------------------------------------------
// GCJ-02 → WGS-84. Every Chinese web map (Amap/Gaode, Tencent) publishes its
// coordinates in GCJ-02, a legally mandated offset of the real (WGS-84)
// position by a few hundred metres. Our basemap is OpenStreetMap, i.e.
// WGS-84, so an Amap pin drawn raw lands beside the road and sometimes on
// the wrong side of a river. The forward transform is the published one;
// the inverse has no closed form and is taken by fixed-point iteration,
// which converges to well under a metre in a handful of steps.
// ---------------------------------------------------------------------------

const A = 6378245.0;
const EE = 0.00669342162296594323;

/** The offset applies inside mainland China only; outside, both datums agree. */
export function outOfChina([lng, lat]: LngLat): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

export function wgs84ToGcj02(point: LngLat): LngLat {
  if (outOfChina(point)) return point;
  const [lng, lat] = point;
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

export function gcj02ToWgs84(point: LngLat): LngLat {
  if (outOfChina(point)) return point;
  let guess: LngLat = [point[0], point[1]];
  for (let i = 0; i < 12; i += 1) {
    const forward = wgs84ToGcj02(guess);
    const dx = forward[0] - point[0];
    const dy = forward[1] - point[1];
    guess = [guess[0] - dx, guess[1] - dy];
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) break;
  }
  return guess;
}

// ---------------------------------------------------------------------------
// Distances and the road
// ---------------------------------------------------------------------------

/** Great-circle kilometres. */
export function haversineKm(a: LngLat, b: LngLat): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function perpendicular(p: LngLat, a: LngLat, b: LngLat): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Douglas–Peucker, the round-109 script's simplifier: the corridor's roads
 * were stored at 0.02° (~2 km), finer than the map draws at corridor zoom.
 */
export function simplify(points: LngLat[], tolerance: number): LngLat[] {
  if (points.length < 3) return points;
  let index = 0;
  let max = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = perpendicular(points[i]!, points[0]!, points[points.length - 1]!);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= tolerance) return [points[0]!, points[points.length - 1]!];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

/**
 * A lorry is slower than the car profile a public router answers for; the
 * owner's own corridor hours run ~1.3× a car's. The same factor stretches a
 * straight line into a road when no router answered.
 */
export const LORRY_FACTOR = 1.3;
/** Average lorry speed on a road we could not fetch, km/h. */
export const FALLBACK_KMH = 50;

export interface Leg {
  /** [lng, lat] points from the leg's start to its end, both ends exact. */
  points: LngLat[];
  hours: number;
  source: 'osrm' | 'line';
}

/** The straight line, when no router answered: the ends only, hours from distance. */
export function straightLeg(from: LngLat, to: LngLat): Leg {
  const km = haversineKm(from, to) * LORRY_FACTOR;
  return { points: [from, to], hours: Math.max(0.25, km / FALLBACK_KMH), source: 'line' };
}

/**
 * An OSRM `route` answer → a stored leg. The road's own first and last
 * points are REPLACED by the stops' exact coordinates: the router snaps to
 * the nearest road, and a leg whose end is not exactly the next leg's start
 * is a two-point hop the truck creeps along while it should be standing
 * (the dwell rule, route-shape.test.ts). Null when the answer is not a route.
 */
export function legFromOsrm(body: unknown, from: LngLat, to: LngLat): Leg | null {
  const route = (body as { code?: string; routes?: unknown[] } | null)?.routes?.[0] as
    | { duration?: number; geometry?: { coordinates?: unknown } }
    | undefined;
  if ((body as { code?: string } | null)?.code !== 'Ok' || !route) return null;
  const coords = route.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2 || typeof route.duration !== 'number') return null;
  const raw: LngLat[] = [];
  for (const c of coords) {
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
    raw.push([c[0], c[1]]);
  }
  const inner = simplify(raw, 0.02)
    .slice(1, -1)
    .map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000] as LngLat);
  return {
    points: [from, ...inner, to],
    hours: Math.max(0.25, (route.duration / 3600) * LORRY_FACTOR),
    source: 'osrm',
  };
}

// ---------------------------------------------------------------------------
// Geocoder answers
// ---------------------------------------------------------------------------

export interface GeocodeHit {
  /** WGS-84, whatever the provider spoke. */
  point: LngLat;
  source: 'amap' | 'osm';
  /** What the provider understood the address to be — shown to the person confirming. */
  label: string;
}

const inChinaBox = ([lng, lat]: LngLat) => lng > 70 && lng < 140 && lat > 15 && lat < 56;

/** Amap Web Service `geocode/geo` → a WGS-84 hit, or null. */
export function parseAmapGeocode(body: unknown): GeocodeHit | null {
  const b = body as { status?: string; geocodes?: { location?: string; formatted_address?: string }[] } | null;
  if (b?.status !== '1' || !b.geocodes?.length) return null;
  const hit = b.geocodes[0]!;
  const [lng, lat] = String(hit.location ?? '')
    .split(',')
    .map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !inChinaBox([lng!, lat!])) return null;
  return {
    point: gcj02ToWgs84([lng!, lat!]),
    source: 'amap',
    label: String(hit.formatted_address ?? ''),
  };
}

/** Nominatim `search?format=jsonv2` → a hit (already WGS-84), or null. */
export function parseNominatim(body: unknown): GeocodeHit | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const hit = body[0] as { lat?: string; lon?: string; display_name?: string };
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !inChinaBox([lng, lat])) return null;
  return { point: [lng, lat], source: 'osm', label: String(hit.display_name ?? '') };
}

/**
 * «lat, lon» or «lon,lat» pasted from a phone map, or a map link carrying
 * them. Inside China the two ranges never overlap — latitudes run 18-54,
 * longitudes 73-135 — so the order is read off the numbers themselves.
 */
export function parsePastedPoint(text: string): LngLat | null {
  const numbers = (text.match(/-?\d{1,3}\.\d+/g) ?? []).map(Number);
  if (numbers.length < 2) return null;
  const [a, b] = [numbers[0]!, numbers[1]!];
  const isLat = (v: number) => v >= 18 && v <= 54;
  const isLng = (v: number) => v >= 73 && v <= 135;
  if (isLat(a) && isLng(b)) return [b, a];
  if (isLng(a) && isLat(b)) return [a, b];
  return null;
}
