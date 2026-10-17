import type { LegKey } from './engine';

/**
 * WHERE a truck is, in the four words the owner uses for it (2026-10-17:
 * «pogruzga qattaligini bilishim kerak — ichki Xitoydami yokida
 * chegaradami … yolda bosqichida mashina qayerda — ichki Xitoymi yokida
 * tranzitmi»). ONE vocabulary for the batch board's sections and strip, the
 * cards' «Xitoy ichida», the dashboard and the map, so a lorry is never
 * «at the border» on one screen and «in transit» on the next (#513).
 *
 * - `cn` — inside China: a Chinese warehouse that is not the border hub
 *   (Yiwu, Guangzhou, Urumqi), or the Chinese road towards the border.
 * - `border` — at the border: the border hub (Kashgar; Horgos once its type
 *   is set to «Konsolidatsiya habi», his 11A), or a truck standing in a
 *   border queue (Irkeshtam, Khorgos, Yallama).
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
  const c = (country ?? '').trim().toUpperCase();
  if (c === 'CN') return type === 'hub' ? 'border' : 'cn';
  if (c === 'UZ') return 'uz';
  return null;
}

/**
 * A leg's place. A `Record` over the leg keys, so a leg added to the route
 * table without a place fails `pnpm typecheck` instead of reading «joyi aniq
 * emas» on every truck that drives it.
 *
 * Both queues are «at the border» — the Chinese one (`border_wait`) and the
 * Kazakh → Uzbek one (`uz_queue`): his section is «Chegarada (navbatda)».
 * The generic straight line (`transit`) has no place of its own; who it
 * belongs to is decided from its two ends (`zoneOfGenericRoad`).
 *
 * A stated approximation: on the Kashgar road the `uz` leg starts at Osh, so
 * the ~25 km Osh → Dostlik read «O'zbekistonda». The schedule has no Dostlik
 * point, and adding one moves the legs every pin anchors to.
 */
export const LEG_ZONE: Record<LegKey, RoadZone | null> = {
  cn_transit: 'cn',
  to_border: 'cn',
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
  const o = (originCountry ?? '').trim().toUpperCase();
  const d = (destCountry ?? '').trim().toUpperCase();
  if (o === 'CN' && d === 'CN') return 'cn';
  if (o === 'UZ' && d === 'UZ') return 'uz';
  return null;
}
