import { sql } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';

/**
 * «Has a person written on this request since the machine?» — the stamp's one
 * mover (docs/SAKKIZ-R3.md K15, his 1.9 a «VED hali boshlamagan»).
 *
 * `handsoff_rev` equal to `rev` means only the machine's pass and the seller's
 * own additions have written. Each of those saves moves it, inside the SAME
 * transaction that moved the clock, from the revision it expected to the one
 * it wrote — so a pass killed half-way leaves the stamp at its last committed
 * write and never behind it. The compare-and-set on `from` is the whole rule:
 * a person's save in between moved `rev` without moving the stamp, and from
 * then on no machine write can catch it up — the request reads «started» for
 * good. A request with no stamp (before 0137, a correction) never moves.
 */
export async function advanceHandsOffInTx(tx: Tx, id: string, from: number, to: number): Promise<void> {
  await tx.execute(sql`
    UPDATE calc_requests SET handsoff_rev = ${to}::int
     WHERE id = ${id}::uuid AND handsoff_rev = ${from}::int
  `);
}
