import { countryKey } from '../batches/country-key';
import type { LegKey, RouteDef } from './engine';

/**
 * WHERE a truck is, in the four words the owner uses for it (2026-10-17:
 * «pogruzga qattaligini bilishim kerak — ichki Xitoydami yokida
 * chegaradami … yolda bosqichida mashina qayerda — ichki Xitoymi yokida
 * tranzitmi»). ONE vocabulary for the batch board's sections and strip, the
 * cards' «Xitoy ichida», the dashboard and the map, so a lorry is never
 * «at the border» on one screen and «in transit» on the next (#513).
 *
 * - `cn` — inside China: a Chinese warehouse that is not the border hub
 *   (Yiwu, Guangzhou, Urumqi), or the Chinese road to the hub.
 * - `border` — at the border: the border hub (Kashgar; Horgos once its type
 *   is set to «Konsolidatsiya habi», his 11A), the road from the hub to the
 *   post, or a truck standing in a border queue (Irkeshtam, Khorgos,
 *   Yallama).
 * - `transit` — through a third country: Kyrgyzstan or Kazakhstan.
 * - `uz` — in Uzbekistan.
 *
 * Pure — no database, no clock — so every judgement is a table test.
 */
export const ROAD_ZONES = ['cn', 'border', 'transit', 'uz'] as const;
export type RoadZone = (typeof ROAD_ZONES)[number];

/**
 * A warehouse's place, by its TYPE and COUNTRY and never by its code or
 * name — the cabinet ladder's rule (`client-cabinet/stages.ts`): a second
 * border hub or a renamed warehouse needs no code. Anything outside China
 * and Uzbekistan answers null («joyi aniq emas») rather than a guess.
 */
export function zoneOfWarehouse(
  country: string | null | undefined,
  type: string | null | undefined,
): RoadZone | null {
  const c = countryKey(country);
  if (c === 'CN') return type === 'hub' ? 'border' : 'cn';
  if (c === 'UZ') return 'uz';
  return null;
}

/**
 * A leg's place. A `Record` over the leg keys, so a leg added to the route
 * table without a place fails `pnpm typecheck` instead of reading «joyi aniq
 * emas» on every truck that drives it.
 *
 * «At the border» is the whole border stretch: the road from the border hub
 * to the post (`to_border` — «Chegara tomon yo'lda»), the Chinese queue
 * (`border_wait`) and the Kazakh → Uzbek one (`uz_queue`). As `cn` the hub
 * road read backwards — a Horgos truck was «Chegara» while loading, «Xitoy
 * ichida» for the 5 km to the post, then «Chegarada» again. The card prints
 * the leg's own words beside the place, so the stretch never hides which of
 * the three it is. The generic straight line (`transit`) has no place of its
 * own; who it belongs to is decided from its two ends (`zoneOfGenericRoad`).
 *
 * A stated approximation: on the Kashgar road the `uz` leg starts at Osh, so
 * the ~25 km Osh → Dostlik read «O'zbekistonda». The schedule has no Dostlik
 * point, and adding one moves the legs every pin anchors to.
 */
export const LEG_ZONE: Record<LegKey, RoadZone | null> = {
  cn_transit: 'cn',
  to_border: 'border',
  border_wait: 'border',
  uz_queue: 'border',
  kg: 'transit',
  kz: 'transit',
  uz: 'uz',
  transit: null,
};

export function zoneOfLeg(key: string): RoadZone | null {
  return Object.hasOwn(LEG_ZONE, key) ? LEG_ZONE[key as LegKey] : null;
}

/**
 * A truck on a road nobody wrote a schedule for (`isGenericRoute`) is still
 * somewhere when both its ends are in one country: Yiwu → Guangzhou is
 * inside China, Tashkent 1 → Andijan is in Uzbekistan. Two Chinese ends are
 * `cn` even when one is the border hub — a truck driving between two border
 * warehouses is on a Chinese road, not in a queue. Anything else (a road
 * back from Uzbekistan to China, an unknown country) is null: no place is
 * better than an invented one.
 */
export function zoneOfGenericRoad(
  originCountry: string | null | undefined,
  destCountry: string | null | undefined,
): RoadZone | null {
  const o = countryKey(originCountry);
  const d = countryKey(destCountry);
  if (o === 'CN' && d === 'CN') return 'cn';
  if (o === 'UZ' && d === 'UZ') return 'uz';
  return null;
}

/**
 * The one place a whole road is in, when every leg of it agrees — Yiwu →
 * Kashgar is inside China from end to end, so a truck late on it is still
 * «Xitoy ichida» with nothing to say where along it. Null when the legs
 * disagree: an overdue Kashgar → Tashkent truck with no evidence could be in
 * any of four places, and the board says so rather than guess.
 */
export function zoneOfRoute(route: RouteDef): RoadZone | null {
  const zones = new Set(route.segments.map((s) => zoneOfLeg(s.key)));
  return zones.size === 1 ? ([...zones][0] ?? null) : null;
}
