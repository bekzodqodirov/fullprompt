/**
 * The owner's KPI table as he sent it (2026-09-29, the image behind answers
 * 3a/4a) — ONE home for the seed and the tests that pin it, the tariff seed's
 * shape (#513, calc/tariff-seed.ts). Zero imports: the seed script and a unit
 * test both read it.
 *
 * Rows are the month's m³ «gacha» (up to, inclusive): ≤30, ≤50, ≤70, ≤100,
 * ≤150 and the open «>150»; columns the month's average density «до 100»,
 * «до 200», «до 350» and the open «от 350». $ per m³; KPI = m³ × the cell.
 * His image also printed totals (30 × 1 = 30, 50 × 1.5 = 75 …) — those were
 * illustrations of the rule, not a second rule, and are not stored.
 */

/** The month his table starts to apply — open point 1's default (a): September 2026. */
export const OWNER_KPI_FROM = '2026-09-01';

/** Tier tops in m³; null = the open top. */
export const OWNER_KPI_TIERS: (number | null)[] = [30, 50, 70, 100, 150, null];
/** Band tops in kg/m³; null = the open top. */
export const OWNER_KPI_BANDS: (number | null)[] = [100, 200, 350, null];

/** $/m³, one row per tier, one column per band — exactly his numbers. */
export const OWNER_KPI_GRID: number[][] = [
  [1, 2, 3, 4],
  [1.5, 3, 4, 5],
  [2, 4, 5, 6],
  [2.5, 5, 6, 7],
  [3, 6, 7, 8],
  [3, 7, 8, 9],
];

export interface KpiSeedCell {
  maxM3: number | null;
  maxDensity: number | null;
  rateUsd: number;
}

/** The 24 cells, tier-major. */
export function ownerKpiCells(): KpiSeedCell[] {
  return OWNER_KPI_TIERS.flatMap((maxM3, row) =>
    OWNER_KPI_BANDS.map((maxDensity, col) => ({ maxM3, maxDensity, rateUsd: OWNER_KPI_GRID[row]![col]! })),
  );
}
