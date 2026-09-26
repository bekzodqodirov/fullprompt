/**
 * Allocation engine (spec 6.9) — a PURE function distributing one cost
 * entry's USD amount over the boxes in its scope. A box's landed cost is the
 * sum of its shares across its whole journey (receipt + every batch it rode).
 *
 * Shares are whole $0.0001 units, split by the LARGEST REMAINDER: every box
 * gets the floor of its exact share and the units left over go, one each, to
 * the boxes with the biggest fractions. So the shares still sum exactly to the
 * entry amount (DECISIONS #88), no share is negative and none is more than
 * one unit from exact. The old rule — round every share, then dump the whole
 * leftover on the LAST box — was not «a few 0.0001»: on an equal-weight pool
 * every rounding error points the same way, so the leftover grew with the box
 * count (N × half a unit — $0.03 on a 600-box truck) and on a small fee it
 * pushed that one box below zero. «Last» was also whatever row order postgres
 * returned, so which client absorbed the cents was arbitrary.
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

/** $0.0001 — the grain of `cost_allocations.amount_usd` (numeric(…, 4)). */
const UNITS_PER_USD = 10_000;

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

  const units = Math.round(entry.amountUsd * UNITS_PER_USD);
  const exact = weights.map((w) => (units * w) / total);
  // The epsilon keeps a float like 4.999999999 from losing a whole unit it
  // was always owed; the take-back below covers the opposite edge.
  const whole = exact.map((x) => Math.floor(x + 1e-9));
  let rest = units - whole.reduce((a, n) => a + n, 0);
  // Biggest fraction first; a tie goes to the earlier box so the same pool
  // always splits the same way.
  const byFraction = exact
    .map((x, i) => ({ i, fraction: x - whole[i]! }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % byFraction.length, rest -= 1) {
    whole[byFraction[k]!.i]! += 1;
  }
  // Float edge only: the epsilon over-counted. Take back from the smallest
  // fractions, never from a box that is already at zero.
  let k = byFraction.length - 1;
  while (rest < 0) {
    const i = byFraction[k]!.i;
    if (whole[i]! > 0) {
      whole[i]! -= 1;
      rest += 1;
    }
    k = (k - 1 + byFraction.length) % byFraction.length;
  }
  return pool.map((box, i) => ({
    boxId: box.boxId,
    clientId: box.clientId,
    amountUsd: whole[i]! / UNITS_PER_USD,
  }));
}

/** amount × dated rate → USD, rounded to cents. */
export function toUsd(amount: number, rateToUsd: number): number {
  return Math.round(amount * rateToUsd * 100) / 100;
}
