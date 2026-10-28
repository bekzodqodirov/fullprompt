/**
 * The add door's writer (docs/SAKKIZ-R3.md §9, his 1.9 a). K's stubs: the
 * signatures other packages call before P4 fills them, each inert.
 */
import type { CalcSection } from './intake';

/**
 * One home for «which totals does this addition leave stale» — the add table,
 * the diff and the re-run reply read it. K: nothing is stale.
 */
export function amendTotalsStale(_input: {
  section: CalcSection;
  stored: { weightKg: number | null; volumeM3: number | null; items: readonly { volumeM3: number | null }[] };
  linesAfter: readonly { volumeM3: number | null }[];
  added: number;
  answered: { weightKg: boolean; volumeM3: boolean };
}): { stale: ('weightKg' | 'volumeM3')[]; resummedM3: number | null } {
  return { stale: [], resummedM3: null };
}

/**
 * Hand every stored «waiting» addition (of one request, or all) back to the
 * save job once the machine pass it waited for is gone. K: none wait.
 */
export async function requeueWaitingAmendments(_requestId?: string): Promise<number> {
  return 0;
}
