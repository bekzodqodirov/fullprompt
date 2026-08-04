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

/**
 * The colour IS the meaning, and the meaning is the owner's (2026-07-28):
 * "yengili yaxshi, o'rtasi sariq, og'iri qizil" — light cargo is the good
 * case in this business, so it is green, and the heavier it gets the redder.
 * The old scheme gave the lightest band the BRAND colour, and the brand is
 * red: a light lot wore the danger colour on every screen.
 */
export type DensityBand = 'green' | 'yellow' | 'red' | 'darkred';

/** Density badge bands, lower-bound inclusive (DECISIONS #17, recoloured #347). */
export function densityBand(
  density: number | null,
  thresholds: { light: number; medium: number; heavy: number },
): DensityBand | null {
  if (density === null) return null;
  if (density >= thresholds.heavy) return 'darkred';
  if (density >= thresholds.medium) return 'red';
  if (density >= thresholds.light) return 'yellow';
  return 'green';
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
