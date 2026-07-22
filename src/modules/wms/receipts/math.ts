/** Lot math (spec 4.6, acceptance test 5). Pure — unit-tested. */

export interface UniformLotInput {
  dimsMode: 'uniform';
  boxCount: number;
  boxLengthCm: number;
  boxWidthCm: number;
  boxHeightCm: number;
  boxWeightKg: number;
}

export interface MixedLotInput {
  dimsMode: 'mixed';
  boxCount: number;
  totalWeightKg: number;
  totalVolumeM3: number;
}

export type LotInput = UniformLotInput | MixedLotInput;

export interface LotTotals {
  totalWeightKg: number;
  totalVolumeM3: number;
  densityKgM3: number | null;
  chargeableKg: number;
}

export function computeLotTotals(lot: LotInput, chargeableFactor: number): LotTotals {
  let totalWeightKg: number;
  let totalVolumeM3: number;
  if (lot.dimsMode === 'uniform') {
    totalWeightKg = round3(lot.boxWeightKg * lot.boxCount);
    totalVolumeM3 = round4(
      ((lot.boxLengthCm * lot.boxWidthCm * lot.boxHeightCm) / 1_000_000) * lot.boxCount,
    );
  } else {
    totalWeightKg = round3(lot.totalWeightKg);
    totalVolumeM3 = round4(lot.totalVolumeM3);
  }
  const densityKgM3 = totalVolumeM3 > 0 ? totalWeightKg / totalVolumeM3 : null;
  const chargeableKg = Math.max(totalWeightKg, round3(totalVolumeM3 * chargeableFactor));
  return { totalWeightKg, totalVolumeM3, densityKgM3, chargeableKg };
}

export type DensityBand = 'light' | 'green' | 'orange' | 'heavy';

/** Density badge bands, lower-bound inclusive (DECISIONS #17). */
export function densityBand(
  density: number | null,
  thresholds: { light: number; medium: number; heavy: number },
): DensityBand | null {
  if (density === null) return null;
  if (density >= thresholds.heavy) return 'heavy';
  if (density >= thresholds.medium) return 'orange';
  if (density >= thresholds.light) return 'green';
  return 'light';
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
