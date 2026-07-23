/**
 * Allocation engine (spec 6.9) — a PURE function distributing one cost
 * entry's USD amount over the boxes in its scope. A box's landed cost is the
 * sum of its shares across its whole journey (receipt + every batch it rode).
 *
 * Shares are rounded to 4 decimal places; the LAST box absorbs the rounding
 * remainder so the shares always sum exactly to the entry amount.
 */

export type AllocationBasis = 'weight' | 'volume' | 'chargeable' | 'boxes' | 'direct_to_client';

export interface AllocBox {
  boxId: string;
  clientId: string | null;
  weightKg: number;
  volumeM3: number;
  /** max(weightKg, volumeM3 × factor) — factor comes from settings (167). */
  chargeableKg: number;
}

export interface AllocInput {
  amountUsd: number;
  basis: AllocationBasis;
  /** Required for direct_to_client — only that client's boxes get a share. */
  clientId?: string | null;
}

export interface AllocShare {
  boxId: string;
  clientId: string | null;
  amountUsd: number;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function weightOf(box: AllocBox, basis: AllocationBasis): number {
  switch (basis) {
    case 'weight':
      return box.weightKg;
    case 'volume':
      return box.volumeM3;
    case 'chargeable':
      return box.chargeableKg;
    default:
      return 1; // boxes / direct_to_client → equal split
  }
}

/**
 * Returns one share per participating box (empty when nothing participates —
 * e.g. direct_to_client with no matching boxes, or a zero-weight basis).
 */
export function allocateEntry(entry: AllocInput, boxes: AllocBox[]): AllocShare[] {
  const pool =
    entry.basis === 'direct_to_client'
      ? boxes.filter((b) => entry.clientId && b.clientId === entry.clientId)
      : boxes;
  if (pool.length === 0) return [];

  const weights = pool.map((b) => weightOf(b, entry.basis));
  const total = weights.reduce((a, w) => a + w, 0);
  if (total <= 0) return [];

  const shares: AllocShare[] = pool.map((box, i) => ({
    boxId: box.boxId,
    clientId: box.clientId,
    amountUsd: round4((entry.amountUsd * weights[i]!) / total),
  }));
  // Absorb the rounding drift into the last share so Σ = amountUsd exactly.
  const sum = shares.reduce((a, s) => a + s.amountUsd, 0);
  const drift = round4(entry.amountUsd - sum);
  if (drift !== 0) {
    shares[shares.length - 1]!.amountUsd = round4(shares[shares.length - 1]!.amountUsd + drift);
  }
  return shares;
}

/** amount × dated rate → USD, rounded to cents. */
export function toUsd(amount: number, rateToUsd: number): number {
  return Math.round(amount * rateToUsd * 100) / 100;
}
