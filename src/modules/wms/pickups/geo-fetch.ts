import { logger } from '../../platform/logger';
import {
  legFromOsrm,
  parseAmapGeocode,
  parseNominatim,
  straightLeg,
  type GeocodeHit,
  type Leg,
  type LngLat,
} from './geo';

/**
 * The factory map's network half — deliberately thin: every decision lives
 * in `geo.ts` and is tested there, because this container cannot reach any
 * of these hosts and the CI runner can (#278).
 *
 * Every call carries a DEADLINE and never throws (round 97: an un-deadlined
 * outbound call is a hung save button), and none of it may run inside a
 * database transaction (#714) or on a page render — a factory is geocoded
 * when its address is saved, a trip's roads when its stops are saved, and
 * the answers are STORED. Nothing here is called per map view.
 *
 * DECISIONS #745 said the running app never calls a routing service; that
 * stays true of the corridor. A factory nobody knew about at build time is
 * the one thing a build-time file cannot hold, and the owner asked for a
 * road-shaped line to it (D1), so its road is fetched ONCE and stored — and
 * a straight line is drawn when nothing answers, so the router is an
 * improvement and never a dependency.
 */

const GEOCODE_TIMEOUT_MS = 6_000;

/**
 * `GEO_NETWORK=off` — the test suites set it (vitest.config, the Playwright
 * server env), so a geocode answers «not found» and a road is a straight
 * line in BOTH places, instead of green here and different on the runner.
 */
export function geoNetworkOff(): boolean {
  return process.env.GEO_NETWORK === 'off';
}
const ROUTE_TIMEOUT_MS = 10_000;

async function getJson(url: string, timeoutMs: number, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch (err) {
    logger.warn({ err: String(err), host: new URL(url).host }, 'geo request failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Amap (Gaode) when the server has a key — the one that knows Chinese
 * street addresses — else OpenStreetMap's Nominatim, keyless, weaker on
 * street level, with a 1-request-per-second policy that a factory saved by
 * hand never approaches. The key lives only in the server's `.env`.
 */
export async function geocodeAddress(address: string): Promise<GeocodeHit | null> {
  const text = address.trim();
  if (!text || geoNetworkOff()) return null;
  const key = process.env.AMAP_WEB_KEY?.trim();
  if (key) {
    const hit = parseAmapGeocode(
      await getJson(
        `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(text)}&key=${encodeURIComponent(key)}`,
        GEOCODE_TIMEOUT_MS,
      ),
    );
    if (hit) return hit;
  }
  return parseNominatim(
    await getJson(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=cn&q=${encodeURIComponent(text)}`,
      GEOCODE_TIMEOUT_MS,
      // Nominatim's policy asks every client to name itself.
      { 'User-Agent': 'GSR-WMS/1.0 (+https://gsrwms.uz)', 'Accept-Language': 'zh,en' },
    ),
  );
}

/** One leg of road, or a straight line when the router is not answering. */
export async function fetchLeg(from: LngLat, to: LngLat): Promise<Leg> {
  if (geoNetworkOff()) return straightLeg(from, to);
  const base = (process.env.OSRM_URL?.trim() || 'https://router.project-osrm.org').replace(/\/$/, '');
  const body = await getJson(
    `${base}/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson`,
    ROUTE_TIMEOUT_MS,
  );
  return (body ? legFromOsrm(body, from, to) : null) ?? straightLeg(from, to);
}
