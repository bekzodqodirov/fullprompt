import { allocateEntry, type AllocBox, type AllocShare, type AllocationBasis } from './engine';
import { freightGroups, splitFreight } from './freight-split';
import type { BoxMeasure, FreightCopy, FreightHeld, PricedGroup } from './freight-types';

/**
 * ONE pool for every question «where does this bill's money go» (docs/
 * YOLKIRA-TAQSIMOT.md §9.6). Pure. The recompute writes what it answers, the
 * void guard asks it twice (before and after a void), and the preview and
 * every explanation ask it over the same measures — so they cannot disagree.
 * It is the ONLY caller of `allocateEntry` (fenced).
 */
export type PoolVerdict =
  | { kind: 'split'; shares: AllocShare[]; groups?: PricedGroup[] }
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
    const split = splitFreight(freightGroups(base), freight.copy);
    if (!split.ok) return { kind: 'held', held: split.held };
    const pool: AllocBox[] = base.map((m) => ({
      boxId: m.boxId,
      clientId: m.clientId,
      weightKg: m.weightKg,
      volumeM3: m.volumeM3,
      chargeableKg: Math.max(m.weightKg, m.volumeM3 * factor),
      freightWeight: split.weights.get(m.boxId) ?? 0,
    }));
    const shares = allocateEntry({ amountUsd: entry.amountUsd, basis: 'freight', clientId: entry.clientId }, pool);
    if (shares.length === 0) {
      // Over a NON-empty base the belt in allocateEntry said «a box nobody
      // could price»: say so in the words a person can act on.
      const lots = new Map(base.map((m) => [m.lotId, m]));
      return {
        kind: 'held',
        held: {
          reason: 'cargo',
          measureMissing: [...lots.values()].map((m) => ({
            lotId: m.lotId,
            receiptId: m.receiptId,
            label: `${m.unclaimedMarking ?? m.clientCode ?? m.receiptNumber ?? '❓'}-${m.lotLetter ?? m.lotSeq}`,
            m3: m.volumeM3 * m.boxCount,
            kg: m.weightKg * m.boxCount,
            density: null,
          })),
          tooLight: [],
        },
      };
    }
    return { kind: 'split', shares, groups: split.groups };
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
