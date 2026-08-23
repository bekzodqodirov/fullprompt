/**
 * The owner's freight tariff, as he settled it (docs/VED.md).
 *
 * It lives here rather than inside `scripts/seed.ts` because two things need
 * the same table and must never disagree about it: the seed that writes it on
 * a fresh installation, and the fence that proves it has no holes (#513).
 *
 * **The table is CONTIGUOUS, and that is his own correction.** He first wrote
 * it with «501–700» followed by «700–900», then nothing until «1000+», which
 * left 700 in two bands and 900-999 in none — and each is real money (30 m³ at
 * 950 kg/m³ is $9,600 or $15,675 depending on which way the gap is read). His
 * three answers: the 900-999 band takes the $320/$200 row, every band starts
 * where the one before it ended plus one, and the step at 1000 stays a step.
 * So «700–900» became **701–999** and the whole table now covers every whole
 * kg/m³ from 1 upwards exactly once.
 *
 * The engine's `band_missing` and `band_ambiguous` refusals STAY — they are
 * about the tariff a person may edit tomorrow on `/admin/tarif`, not about
 * this seed, and they are the reason a future hole will be a visible refusal
 * rather than a quietly cheaper invoice.
 *
 * Zones are named by their CODES and nowhere by city: `seed-demo-gate.test.ts`
 * reads `scripts/seed.ts` as text and refuses the demo warehouse names.
 */

/** `[minDensity, maxDensity | null, china price, western price]`, USD. */
export type OwnerBand = readonly [number, number | null, number, number];

export const OWNER_TARIFF_ZONES = ['cn', 'kashgar'] as const;

/**
 * The date the seeded tariff takes effect.
 *
 * FIXED, never `new Date()`: a tariff dated «whenever the seed happened to
 * run» makes two installations disagree about which row is in force, and a
 * re-seed would silently supersede a row the owner had edited.
 */
export const OWNER_TARIFF_FROM = '2026-01-01';

export const OWNER_TARIFF_BANDS: readonly OwnerBand[] = [
  [1, 100, 110, 70],
  [101, 150, 130, 85],
  [151, 200, 160, 100],
  [201, 250, 180, 115],
  [251, 300, 200, 130],
  [301, 350, 230, 150],
  [351, 400, 260, 170],
  [401, 450, 280, 180],
  [451, 500, 290, 190],
  [501, 700, 300, 195],
  // Was «700–900» in his first table. 700 belongs to the row above (his
  // «ketma-ket» rule) and 900-999 belongs here (his «sen aytgandek»).
  [701, 999, 320, 200],
  // The step he chose to keep: priced per KILOGRAM, not per cube.
  [1000, null, 0.55, 0.3],
] as const;

/** The rows as the seed writes them — one per band per zone. */
export function ownerTariffRows(): {
  zone: string;
  minDensity: number;
  maxDensity: number | null;
  priceUsd: number;
  perKg: boolean;
}[] {
  return OWNER_TARIFF_BANDS.flatMap(([min, max, cn, west]) =>
    ([['cn', cn], ['kashgar', west]] as const).map(([zone, price]) => ({
      zone,
      minDensity: min,
      maxDensity: max,
      priceUsd: price,
      // Only the open-ended top band is charged by weight.
      perKg: max === null,
    })),
  );
}
