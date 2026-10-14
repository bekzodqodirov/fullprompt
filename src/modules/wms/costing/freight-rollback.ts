import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { rollbackFreightBill } from './rebase';

/**
 * The ROLLBACK for the yo'lkira-tarifi basis (docs/YOLKIRA-TAQSIMOT.md §8.8,
 * §10, DS3), the part `pnpm freight-to-weight` runs. If the reason for going
 * below 0132 is this release's own cost screen, a button on that screen is no
 * tool at all — so the list and the re-basis live here, where a test reaches
 * them, and the script only prints and presses.
 */
export interface FreightBillRow {
  id: string;
  truckCode: string | null;
  typeName: string;
  amount: string;
  currency: string;
  amountUsd: string | null;
  /** Each client's (or unclaimed prixod's) share as stored, to the cent. */
  shares: { label: string; usd: number }[];
}

/** Every LIVE freight bill with its stored shares — the dry run's whole answer. */
export async function liveFreightBills(): Promise<FreightBillRow[]> {
  const rows = (await db.execute(sql`
    SELECT ce.id, b.code AS truck_code, ct.name AS type_name, ce.amount::text AS amount, ce.currency,
           ce.amount_usd::text AS amount_usd,
           coalesce((
             SELECT json_agg(json_build_object('label', s.label, 'usd', s.usd) ORDER BY s.label)
               FROM (
                 SELECT coalesce(min(cl.client_code), min(r.unclaimed_marking), min(r.number), '?') AS label,
                        round(sum(ca.amount_usd), 2)::float8 AS usd
                   FROM cost_allocations ca
                   JOIN boxes bx ON bx.id = ca.box_id
                   JOIN receipt_lots rl ON rl.id = bx.lot_id
                   JOIN receipts r ON r.id = rl.receipt_id
                   LEFT JOIN clients cl ON cl.id = ca.client_id
                  WHERE ca.cost_entry_id = ce.id
                  GROUP BY coalesce(ca.client_id::text, 'r:' || rl.receipt_id::text)
               ) s
           ), '[]'::json) AS shares
      FROM cost_entries ce
      JOIN cost_types ct ON ct.id = ce.cost_type_id
      LEFT JOIN batches b ON b.id = ce.batch_id
     WHERE ce.allocation_basis = 'freight' AND ce.voided_at IS NULL
     ORDER BY ce.created_at`)) as unknown as {
    id: string;
    truck_code: string | null;
    type_name: string;
    amount: string;
    currency: string;
    amount_usd: string | null;
    shares: { label: string; usd: number }[];
  }[];
  return [...rows].map((r) => ({
    id: r.id,
    truckCode: r.truck_code,
    typeName: r.type_name,
    amount: r.amount,
    currency: r.currency,
    amountUsd: r.amount_usd,
    shares: r.shares,
  }));
}

/**
 * Each listed bill back to weight through the re-basis door's SAVE half
 * (the entry locked, the shares deleted, the copy removed, an audit row with
 * `reason: 'rollback'` and no actor, then the split). One bill's failure is
 * named and the rest still run, so a rerun is known to be owed.
 */
export async function rollbackFreightBills(ids: string[]): Promise<{
  done: number;
  skipped: number;
  failed: { id: string; message: string }[];
  /** Each moved bill and how its weight split came out — a «pending» or «nothing» one is named, never counted silently. */
  splits: { id: string; split: string | null }[];
}> {
  let done = 0;
  let skipped = 0;
  const failed: { id: string; message: string }[] = [];
  const splits: { id: string; split: string | null }[] = [];
  for (const id of ids) {
    try {
      const result = await rollbackFreightBill(id, { actorId: null, ip: null, userAgent: 'freight-to-weight' });
      if (result.moved === 'saved') {
        done += 1;
        splits.push({ id, split: result.split });
      } else skipped += 1;
    } catch (err) {
      failed.push({ id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { done, skipped, failed, splits };
}
