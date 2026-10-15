import { allocateEntry, type AllocBox, type AllocShare, type AllocationBasis } from './engine';
import { freightLots, lotCents, lotIdentityOf, splitFreight } from './freight-split';
import type { BoxMeasure, FreightCopy, FreightHeld, PricedLot } from './freight-types';

/**
 * ONE pool for every question «where does this bill's money go» (docs/
 * YOLKIRA-TAQSIMOT.md §9.6). Pure. The recompute writes what it answers, the
 * void guard asks it twice (before and after a void), and the preview and
 * every explanation ask it over the same measures — so they cannot disagree.
 * It is the ONLY caller of `allocateEntry` (fenced).
 */
export type PoolVerdict =
  | { kind: 'split'; shares: AllocShare[]; lots?: PricedLot[] }
  | { kind: 'nothing' }
  | { kind: 'held'; held: FreightHeld };

export interface PoolEntry {
  allocationBasis: AllocationBasis;
  clientId: string | null;
  amountUsd: number;
}

/** What the freight basis needs beyond the measures; null for every other basis. */
export interface PoolFreight {
  copy: FreightCopy | 'missing' | 'invalid';
  customs: boolean;
}

/**
 * THE ORDER IS A RULE (M3/E1). An EMPTY base is «nothing» for every basis
 * and is judged FIRST — before the copy, the customs flag or any group is
 * read. A held reason must never stand in for «no cargo»: the void guard
 * refuses a void that leaves money on no box, and a freight bill whose type
 * later became customs would otherwise answer «held, homed» about an empty
 * truck and let its money stay there.
 */
export function costPool(
  entry: PoolEntry,
  measures: BoxMeasure[],
  factor: number,
  freight: PoolFreight | null,
): PoolVerdict {
  const base =
    entry.allocationBasis === 'direct_to_client'
      ? measures.filter((m) => entry.clientId !== null && m.clientId === entry.clientId)
      : measures;
  if (base.length === 0) return { kind: 'nothing' };

  if (entry.allocationBasis === 'freight') {
    if (freight === null || freight.copy === 'missing') return { kind: 'held', held: { reason: 'copy_missing' } };
    if (freight.copy === 'invalid') return { kind: 'held', held: { reason: 'copy_invalid' } };
    if (freight.customs) return { kind: 'held', held: { reason: 'on_customs' } };
    const split = splitFreight(freightLots(base), freight.copy);
    if (!split.ok) return { kind: 'held', held: split.held };
    // The bill's cents are decided per LOT first — by the very `lotCents`
    // the preview, the fold and the ✎ rows print — and only then spread over
    // the lot's own cartons (which share one measure). Spread over all the
    // cartons at once at $0.0001, the per-carton remainder moved a lot's sum
    // by a few units and handed the spare cent to a different client after
    // «Saqlash»: ~7 % of random multi-carton bills (the review as built).
    const cents = lotCents(entry.amountUsd, split.lots.map((l) => ({ key: l.key, weight: l.share })));
    const byLot = new Map<string, BoxMeasure[]>();
    for (const m of base) {
      let list = byLot.get(m.lotId);
      if (!list) byLot.set(m.lotId, (list = []));
      list.push(m);
    }
    const byBox = new Map<string, AllocShare>();
    let priced = true;
    for (const [lotId, boxes] of byLot) {
      const pool: AllocBox[] = boxes.map((m) => ({
        boxId: m.boxId,
        clientId: m.clientId,
        weightKg: m.weightKg,
        volumeM3: m.volumeM3,
        chargeableKg: Math.max(m.weightKg, m.volumeM3 * factor),
        freightWeight: split.weights.get(m.boxId) ?? 0,
      }));
      const part = allocateEntry({ amountUsd: cents[`l:${lotId}`] ?? 0, basis: 'freight', clientId: entry.clientId }, pool);
      if (part.length === 0) priced = false;
      for (const share of part) byBox.set(share.boxId, share);
    }
    const shares = priced ? base.map((m) => byBox.get(m.boxId)!) : [];
    if (shares.length === 0) {
      // Over a NON-empty base the belt in allocateEntry said «a box nobody
      // could price»: say so in the words a person can act on.
      const lots = new Map<string, { m: BoxMeasure; m3: number; kg: number }>();
      for (const m of base) {
        const lot = lots.get(m.lotId) ?? { m, m3: 0, kg: 0 };
        lot.m3 += m.volumeM3;
        lot.kg += m.weightKg;
        lots.set(m.lotId, lot);
      }
      return {
        kind: 'held',
        held: {
          reason: 'cargo',
          measureMissing: [...lots.values()].map(({ m, m3, kg }) => ({ ...lotIdentityOf(m), m3, kg, density: null })),
          tooLight: [],
        },
      };
    }
    return { kind: 'split', shares, lots: split.lots };
  }

  const pool: AllocBox[] = base.map((m) => ({
    boxId: m.boxId,
    clientId: m.clientId,
    weightKg: m.weightKg,
    volumeM3: m.volumeM3,
    chargeableKg: Math.max(m.weightKg, m.volumeM3 * factor),
    freightWeight: 0,
  }));
  const shares = allocateEntry(
    { amountUsd: entry.amountUsd, basis: entry.allocationBasis, clientId: entry.clientId },
    pool,
  );
  return shares.length === 0 ? { kind: 'nothing' } : { kind: 'split', shares };
}

/**
 * «Is the money somewhere?» — the void guard's question. A HELD freight bill
 * is homed (the bill is written and named on every ⚠ surface; fixing a lot
 * re-splits it); only «nothing» is money on no box.
 */
export const homed = (v: PoolVerdict) => v.kind !== 'nothing';
