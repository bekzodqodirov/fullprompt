import { sql } from 'drizzle-orm';
import type { Exec } from './cargo';
import { centsOf, roundPreservingTotal, unitsOf } from './stamp-split';

/**
 * A seller's COST by the prixod's stamp (4a) — the full table's half only:
 * no scope parameter, because it is company money by construction and its
 * ONLY caller is `sellerPerformanceAll` (the seller's own card never names
 * it — the fence reads seller-report.ts below its OWN marker).
 *
 * Exact, carton by carton: every live allocation of a CLAIMED client in the
 * period (`profitByClient`'s own set — a live entry, `cost_date` in the
 * period, `ca.client_id IS NOT NULL`) goes to its carton's prixod's stamp,
 * with NO box-status clause on purpose: a lost or issued carton keeps its
 * cost (#833). Unclaimed cargo is dropped exactly as «Mijoz foydasi» drops
 * its NULL group — nobody's cargo is nobody's score until it is claimed,
 * and then it takes the claim day's seller (0117).
 *
 * Per client, the stamps' cents sum to «Mijoz foydasi»'s cost for that client
 * to the cent: the target is `centsOf` of the client's exact sum — the same
 * expression `profitByClient` applies to the same sum — and the 1e-4 parts
 * are rounded to it by the largest remainder (`roundPreservingTotal`).
 * The executor is REQUIRED (#714).
 */

export interface StampCostRow {
  clientId: string;
  sellerId: string | null;
  cents: number;
}

export async function costByStamp(exec: Exec, period: { dan: string; gacha: string }): Promise<StampCostRow[]> {
  const rows = (await exec.execute(sql`
    SELECT ca.client_id, r.sales_manager_id AS seller_id,
           sum(ca.amount_usd)::text AS usd,
           (sum(sum(ca.amount_usd)) OVER (PARTITION BY ca.client_id))::text AS client_usd
      FROM cost_allocations ca
      JOIN cost_entries ce ON ce.id = ca.cost_entry_id
      JOIN boxes b ON b.id = ca.box_id
      JOIN receipt_lots rl ON rl.id = b.lot_id
      JOIN receipts r ON r.id = rl.receipt_id
     WHERE ca.client_id IS NOT NULL
       AND ce.voided_at IS NULL
       AND ce.cost_date >= ${period.dan}::date AND ce.cost_date <= ${period.gacha}::date
     GROUP BY ca.client_id, r.sales_manager_id`)) as unknown as {
    client_id: string;
    seller_id: string | null;
    usd: string;
    client_usd: string;
  }[];

  const byClient = new Map<string, { target: number; parts: { sellerId: string | null; units: number }[] }>();
  for (const row of rows) {
    const entry = byClient.get(row.client_id) ?? { target: centsOf(row.client_usd), parts: [] };
    entry.parts.push({ sellerId: row.seller_id, units: unitsOf(row.usd, 4) });
    byClient.set(row.client_id, entry);
  }

  const out: StampCostRow[] = [];
  for (const [clientId, { target, parts }] of byClient) {
    for (const p of roundPreservingTotal(parts, target)) out.push({ clientId, sellerId: p.sellerId, cents: p.cents });
  }
  // Client, then seller with the «—» last — deterministic, like foldParts.
  // '\uffff' is the highest BMP code unit, so a NULL seller sorts after every uuid.
  const key = (row: StampCostRow) => `${row.clientId}|${row.sellerId ?? '\uffff'}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
