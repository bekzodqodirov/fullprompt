import { paidCargo } from '../finance/paid-cartons';
import type { Exec } from './cargo';

/**
 * The PAID part of a seller's cargo (0117, the owner's 6b: «KPI is earned only
 * on cargo the client has paid for, like the upsale»).
 *
 * The paid rule lives in finance/paid-cartons.ts — one reader for the KPI and
 * the upsale (his 3a); this file is the seller × month fold. The cartons are
 * exactly `stampedCartonsSql`'s (the `stamped` unpriced scope says the same
 * WHERE), so the paid m³ is always a part of the month's m³ and never more,
 * and every read runs on the executor handed in (#714 — payKpi recomputes
 * this inside its own transaction).
 */

/** seller → month (`YYYY-MM`) → paid m³. */
export type PaidM3 = Map<string, Map<string, number>>;

export async function paidM3ByMonth(
  exec: Exec,
  q: { sellerId: string | undefined; from: Date; to: Date },
): Promise<PaidM3> {
  const out: PaidM3 = new Map();
  const { cartons } = await paidCargo(
    exec,
    { kind: 'stamped', sellerId: q.sellerId, from: q.from, to: q.to },
    { elsewhere: false },
  );
  for (const c of cartons) {
    if (!c.paid || c.sellerId === null) continue;
    const bySeller = out.get(c.sellerId) ?? new Map<string, number>();
    bySeller.set(c.month, (bySeller.get(c.month) ?? 0) + c.m3);
    out.set(c.sellerId, bySeller);
  }
  return out;
}
