import { sql } from 'drizzle-orm';
import { settlesUsd } from '../finance/ledger-kinds';
import { deferredPerDealSql } from '../finance/service';
import { settleCharges, type FifoCharge } from '../finance/fifo';
import { uncoveredCtes, unpricedScopeSql } from '../finance/unpriced';
import { MONEY_EPSILON } from '../calc/upsale';
import type { Exec } from './cargo';

/**
 * The PAID part of a seller's cargo (0117, the owner's 6b: «KPI is earned only
 * on cargo the client has paid for, like the upsale»).
 *
 * A carton is paid when:
 *  - at least one LIVE, non-zeroed charge COVERS it — the unpriced rule's own
 *    `u_pair.covers` (finance/unpriced.ts), never re-derived here: which price
 *    belongs to which cargo is that file's one sentence (#513). A carton
 *    covered only by a price the lost-cargo door lowered to zero is NOT paid:
 *    nobody paid anything for it;
 *  - and EVERY live charge covering it is settled — `settleCharges`
 *    (finance/fifo.ts) over the client's whole live ledger: a compensation
 *    first onto its own receipt's charges, a deferral onto its own deal's,
 *    then the money oldest charge first. So a client who ships all the time
 *    and has paid for the old months has PAID cargo in those months while the
 *    newest truck is still owed (open point 3, the default).
 *
 * Every read runs on the executor handed in (#714 — payKpi recomputes this
 * inside its own transaction), and the cartons are exactly `stampedCartonsSql`'s
 * (the `stamped` unpriced scope says the same WHERE), so the paid m³ is always
 * a part of the month's m³ and never more.
 */

/** seller → month (`YYYY-MM`) → paid m³. */
export type PaidM3 = Map<string, Map<string, number>>;

const ids = (list: string[]) =>
  sql.join(
    list.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

export async function paidM3ByMonth(
  exec: Exec,
  q: { sellerId: string | undefined; from: Date; to: Date },
): Promise<PaidM3> {
  // 1. The cartons and, per carton, the live non-zeroed charges covering it.
  const cartons = (await exec.execute(sql`
    WITH ${uncoveredCtes(unpricedScopeSql({ kind: 'stamped', sellerId: q.sellerId, from: q.from, to: q.to }), { landedOnly: false })}
    SELECT ub.box_id, ub.client_id, ub.m3::text AS m3, r.sales_manager_id AS seller_id,
           to_char(r.received_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM') AS month,
           string_agg(up.charge_id::text, ',') FILTER (WHERE up.covers AND NOT uc.zeroed) AS charges
      FROM u_box ub
      JOIN receipts r ON r.id = ub.receipt_id
      LEFT JOIN u_pair up ON up.box_id = ub.box_id
      LEFT JOIN u_charge uc ON uc.id = up.charge_id
     GROUP BY ub.box_id, ub.client_id, ub.m3, r.sales_manager_id, r.received_at`)) as unknown as {
    box_id: string;
    client_id: string;
    m3: string;
    seller_id: string;
    month: string;
    charges: string | null;
  }[];

  const out: PaidM3 = new Map();
  const clientIds = [...new Set(cartons.map((c) => c.client_id))];
  if (clientIds.length === 0) return out;

  // 2. The clients' whole LIVE ledger — a payment settles the oldest price
  //    whichever month or seller it belongs to.
  const ledger = (await exec.execute(sql`
    SELECT ct.id, ct.client_id, ct.type, ct.amount_usd::text AS amount_usd, ct.tx_date::text AS tx_date,
           ct.created_at::text AS created_at, ct.deal_id, ct.receipt_id
      FROM client_transactions ct
     WHERE ct.client_id IN (${ids(clientIds)}) AND ct.voided_at IS NULL`)) as unknown as {
    id: string;
    client_id: string;
    type: string;
    amount_usd: string;
    tx_date: string;
    created_at: string;
    deal_id: string | null;
    receipt_id: string | null;
  }[];

  // 3. The live deferrals, per deal — the handover gate's own rule.
  const deferrals = (await exec.execute(deferredPerDealSql(clientIds))) as unknown as {
    client_id: string;
    deal_id: string;
    owed: string;
  }[];

  // 4. Which charges cover a COMPENSATED receipt — the compensation's target,
  //    asked of the same rule over exactly those receipts (they may sit in
  //    another month, or another seller's stamp).
  const compensated = [
    ...new Set(ledger.filter((row) => row.type === 'compensation' && row.receipt_id).map((row) => row.receipt_id!)),
  ];
  const coversReceipts = new Map<string, Set<string>>();
  if (compensated.length > 0) {
    const pairs = (await exec.execute(sql`
      WITH ${uncoveredCtes(unpricedScopeSql({ kind: 'receipts', receiptIds: compensated }), { landedOnly: false })}
      SELECT DISTINCT ub.receipt_id, up.charge_id
        FROM u_pair up
        JOIN u_box ub ON ub.box_id = up.box_id
        JOIN u_charge uc ON uc.id = up.charge_id
       WHERE up.covers AND NOT uc.zeroed`)) as unknown as { receipt_id: string; charge_id: string }[];
    for (const pair of pairs) {
      const set = coversReceipts.get(pair.charge_id) ?? new Set<string>();
      set.add(pair.receipt_id);
      coversReceipts.set(pair.charge_id, set);
    }
  }

  // 5. Settle each client, once.
  const owed = new Map<string, number>();
  for (const clientId of clientIds) {
    const rows = ledger.filter((row) => row.client_id === clientId);
    const charges: FifoCharge[] = rows
      .filter((row) => row.type === 'charge')
      .map((row) => ({
        id: row.id,
        txDate: row.tx_date,
        createdAt: row.created_at,
        amountUsd: Number(row.amount_usd),
        dealId: row.deal_id,
        coversReceipts: [...(coversReceipts.get(row.id) ?? [])],
      }));
    const settled = settleCharges(charges, {
      generalUsd: rows.reduce((sum, row) => sum + settlesUsd({ type: row.type, amountUsd: Number(row.amount_usd) }), 0),
      compensations: rows
        .filter((row) => row.type === 'compensation' && row.receipt_id)
        .map((row) => ({ receiptId: row.receipt_id!, amountUsd: Number(row.amount_usd) })),
      deferrals: deferrals
        .filter((row) => row.client_id === clientId)
        .map((row) => ({ dealId: row.deal_id, owedUsd: Number(row.owed) })),
    });
    for (const [id, left] of settled) owed.set(id, left);
  }

  // 6. A carton is paid when something covers it and everything covering it is settled.
  for (const carton of cartons) {
    const covering = (carton.charges ?? '').split(',').filter(Boolean);
    if (covering.length === 0) continue;
    if (!covering.every((id) => (owed.get(id) ?? Infinity) <= MONEY_EPSILON)) continue;
    const bySeller = out.get(carton.seller_id) ?? new Map<string, number>();
    bySeller.set(carton.month, (bySeller.get(carton.month) ?? 0) + Number(carton.m3));
    out.set(carton.seller_id, bySeller);
  }
  return out;
}
