import { applyPacking, packingStated, setStated, unsetStated, type PackedField } from './carton-math';
import type { CalcGoodsFact } from './intake';

/**
 * A seller's ANSWER on a row whose figures the bot may compute
 * (docs/AI-SORAYDI.md §2.3; review JN-15, JB-1).
 *
 * `applyPacking` fills, replaces and doubts a row's figures from its packing.
 * A figure a PERSON typed is none of its business: «1: 2.6 kub» over a
 * computed 2.4 is him overruling the arithmetic, and «1: 0.083 kub» under a
 * «bitta karobkanikimi yoki hammasinikimi?» IS the answer. So every figure an
 * answer writes is marked his (`setStated`) — here, in the one place the two
 * writers of a row share (the table's write and the re-read's placement), so
 * no writer has an obligation to remember.
 *
 * Only a row the arithmetic can touch is changed at all: a row with no
 * packing and no computed figure is returned AS IT IS, the same object.
 */
const PACKED: readonly PackedField[] = ['quantity', 'weightKg', 'volumeM3', 'measureQty'];

const computable = (row: CalcGoodsFact): boolean => packingStated(row.packing) || Boolean(row.derived);

/** `row` — the row with the answer's `patch` already written onto it. */
export function answeredRow<T extends CalcGoodsFact>(row: T, patch: Partial<CalcGoodsFact>): T {
  if (!computable(row)) return row;
  let out: T = row;
  let touched = false;
  for (const field of PACKED) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value !== null && typeof value !== 'number') continue;
    out = setStated(out, field, value);
    touched = true;
  }
  // The arithmetic re-runs over what he said: a count answered is what a
  // piece's weight was waiting for; a figure of his is left alone.
  return touched ? applyPacking(out).line : row;
}

/**
 * The goods with every placed answer's figures marked the seller's — after
 * `placeByName` put the answers back on a re-read list, whose fresh rows the
 * reading had just computed (and would compute over his figure again).
 */
export function answersStated<T extends CalcGoodsFact>(
  goods: readonly T[],
  entries: readonly { index: number; patch: Partial<CalcGoodsFact> }[],
): T[] {
  const out = [...goods];
  for (const e of entries) {
    if (e.index >= 0 && e.index < out.length) out[e.index] = answeredRow(out[e.index]!, e.patch);
  }
  return out;
}

/**
 * A row after an answer was TAKEN BACK (the table's «↩️»): `before` — the
 * fields the undo restored, each to what stood before the answer. A figure
 * that had been the arithmetic's own is its own again, with its mark.
 */
export function unansweredRow<T extends CalcGoodsFact>(row: T, before: Partial<CalcGoodsFact>): T {
  if (!computable(row)) return row;
  let out: T = row;
  for (const field of PACKED) {
    if (!(field in before)) continue;
    const was = before[field];
    out = unsetStated(out, field, typeof was === 'number' ? was : null);
  }
  return out;
}
