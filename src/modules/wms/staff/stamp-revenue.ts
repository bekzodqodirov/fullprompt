import { sql } from 'drizzle-orm';
import { riderRowsSql } from '../batches/riders';
import { REVENUE_TYPES } from '../finance/ledger-kinds';
import { kindList, ledgerAlias, revenueUsdSql } from '../finance/ledger-sql';
import type { Exec, StaffScope } from './cargo';
import {
  attributeRow,
  foldParts,
  needsFallback,
  unitsOf,
  type CargoLookup,
  type CargoShare,
  type LedgerRow,
  type SellerKey,
  type StampRevenue,
} from './stamp-split';

/**
 * A seller's REVENUE by the prixod's stamp (4a, his «a) yuk kelgan kundagi
 * sotuvchiga», 2026-09-29) — ONE function for the seller's own card and the
 * full table (#1212: own == all by construction), the scope REQUIRED (#790).
 *
 * The clocks are `profitByClient`'s: a revenue row on its `tx_date`, the same
 * kinds and the same sign (`revenueUsdSql`) — only WHO changes. The rules
 * that decide who are stamp-split.ts's, pure; this file only reads.
 *
 * WHICH cargo a truck price names is the price door's relation — the
 * client's RIDERS on that truck (`riderRowsSql`, `clientAboardSql`'s own
 * relation: the live pointer before departure, the rides after it, found-back
 * and void cartons out) — and deliberately NOT the unpriced rule's `covers`
 * (finance/unpriced.ts, asked by staff/kpi-paid.ts). `covers` answers «is
 * this carton priced / paid»: it ignores the live pointer, rejects a
 * local-leg price and spreads one truck price over the whole prixod. WHOSE
 * revenue a price is asks the door's question, and the two answers differ on
 * purpose.
 *
 * It names no cost source — the seller's own card imports it, and the own
 * card structurally cannot compute a cost (the fence reads this file). The
 * executor is REQUIRED (#714), as for `stampedCargo`.
 *
 * A fixed number of statements for any number of rows (#432): the ledger (A)
 * always; the riders (B), the job prixods (C) and the fallback (D) only when
 * their key list is non-empty — an empty `IN ()` is a syntax error (the
 * `values([])` rule) — each ONE grouped query over a LITERAL list
 * (`riderLoad`'s shape: a CTE of the pairs was measured at 4.7 s, the
 * literal list at 1.1 s over 1,400 trucks and ~60 ms over a real month).
 */

/** Two bind parameters per pair; postgres refuses more than 65,535 in one statement. */
const FALLBACK_PAIRS_PER_STATEMENT = 10_000;

type ShareRow = {
  key_id: string;
  client_id: string;
  seller_id: string | null;
  n: number | string;
  m3u: string;
  kgu: string;
  no_m3: number | string;
  no_kg: number | string;
};

const safe = (text: string) => {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`stamp_share_range ${text}`);
  return value;
};

const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

function shareMap(rows: readonly ShareRow[]): Map<string, CargoShare[]> {
  const out = new Map<string, CargoShare[]>();
  for (const row of rows) {
    // Keyed on (truck or job, CLIENT): another client's cargo on the same truck
    // is never this client's price — `clientAboardSql`'s rule.
    const key = `${row.key_id}|${row.client_id}`;
    const list = out.get(key) ?? [];
    list.push({
      sellerId: row.seller_id,
      m3u: safe(row.m3u),
      kgu: safe(row.kgu),
      n: Number(row.n),
      noM3: Number(row.no_m3),
      noKg: Number(row.no_kg),
    });
    out.set(key, list);
  }
  return out;
}

export async function revenueByStamp(
  exec: Exec,
  period: { dan: string; gacha: string },
  scope: StaffScope,
): Promise<StampRevenue> {
  // The own pre-filter is a provable SUPERSET of every row that can land on the
  // actor: a receipt part needs its prixod stamped by them; a truck or job
  // share, and a latest-prixod fallback, need a prixod OF THAT CLIENT stamped
  // by them; a book fallback needs the book to name them. Each row is then
  // split over ALL its shares, so the actor's part is the same in both scopes.
  const own =
    scope.kind === 'own'
      ? sql`AND (cl.sales_manager_id = ${scope.userId}::uuid
     OR rc.sales_manager_id = ${scope.userId}::uuid
     OR EXISTS (SELECT 1 FROM receipts rs
                 WHERE rs.client_id = ct.client_id AND rs.sales_manager_id = ${scope.userId}::uuid))`
      : sql``;

  // A — the period's revenue rows, on profitByClient's clock and sign.
  const ledger = (await exec.execute(sql`
    SELECT ct.id, ct.client_id, ct.tx_date::text AS tx_date, ct.batch_id, ct.deal_id, ct.receipt_id,
           (${revenueUsdSql(ledgerAlias('ct'))})::text AS usd,
           cl.sales_manager_id AS book_seller_id,
           rc.sales_manager_id AS receipt_seller_id
      FROM client_transactions ct
      JOIN clients cl ON cl.id = ct.client_id
      LEFT JOIN receipts rc ON rc.id = ct.receipt_id
     WHERE ct.type IN (${kindList(REVENUE_TYPES)})
       AND ct.voided_at IS NULL
       AND ct.tx_date >= ${period.dan}::date AND ct.tx_date <= ${period.gacha}::date
       ${own}`)) as unknown as {
    id: string;
    client_id: string;
    tx_date: string;
    batch_id: string | null;
    deal_id: string | null;
    receipt_id: string | null;
    usd: string;
    book_seller_id: string | null;
    receipt_seller_id: string | null;
  }[];
  const rows: LedgerRow[] = [...ledger].map((row) => ({
    id: row.id,
    clientId: row.client_id,
    txDate: row.tx_date,
    cents: unitsOf(row.usd, 2),
    receiptId: row.receipt_id,
    receiptSellerId: row.receipt_seller_id,
    batchId: row.batch_id,
    dealId: row.deal_id,
    bookSellerId: row.book_seller_id,
  }));

  // B — the riders of the period's charged trucks, per (truck, client, stamp).
  const trucks = [
    ...new Set(rows.filter((r) => r.receiptId === null && r.batchId !== null).map((r) => r.batchId!)),
  ];
  const truckShares =
    trucks.length === 0
      ? new Map<string, CargoShare[]>()
      : shareMap(
          (await exec.execute(sql`
    WITH riders AS (${riderRowsSql({ batches: idList(trucks) })})
    SELECT rd.batch_id AS key_id, r.client_id, r.sales_manager_id AS seller_id,
           count(*)::int AS n,
           round(coalesce(sum(rl.total_volume_m3 / rl.box_count), 0) * 1000000)::bigint::text AS m3u,
           round(coalesce(sum(rl.total_weight_kg / rl.box_count), 0) * 1000000)::bigint::text AS kgu,
           (count(*) FILTER (WHERE rl.total_volume_m3 <= 0))::int AS no_m3,
           (count(*) FILTER (WHERE rl.total_weight_kg <= 0))::int AS no_kg
      FROM riders rd
      JOIN boxes bx ON bx.id = rd.box_id
      JOIN receipt_lots rl ON rl.id = bx.lot_id
      JOIN receipts r ON r.id = rl.receipt_id
     WHERE r.client_id IS NOT NULL
     GROUP BY rd.batch_id, r.client_id, r.sales_manager_id`)) as unknown as ShareRow[],
        );

  // C — the job prixods of the period's deal-only prices, over their non-void cartons.
  const deals = [
    ...new Set(
      rows.filter((r) => r.receiptId === null && r.batchId === null && r.dealId !== null).map((r) => r.dealId!),
    ),
  ];
  const dealShares =
    deals.length === 0
      ? new Map<string, CargoShare[]>()
      : shareMap(
          (await exec.execute(sql`
    SELECT r.deal_id AS key_id, r.client_id, r.sales_manager_id AS seller_id,
           count(*)::int AS n,
           round(coalesce(sum(rl.total_volume_m3 / rl.box_count), 0) * 1000000)::bigint::text AS m3u,
           round(coalesce(sum(rl.total_weight_kg / rl.box_count), 0) * 1000000)::bigint::text AS kgu,
           (count(*) FILTER (WHERE rl.total_volume_m3 <= 0))::int AS no_m3,
           (count(*) FILTER (WHERE rl.total_weight_kg <= 0))::int AS no_kg
      FROM receipts r
      JOIN receipt_lots rl ON rl.receipt_id = r.id
      JOIN boxes bx ON bx.lot_id = rl.id AND bx.status <> 'void'
     WHERE r.deal_id IN (${idList(deals)}) AND r.status = 'confirmed' AND r.client_id IS NOT NULL
     GROUP BY r.deal_id, r.client_id, r.sales_manager_id`)) as unknown as ShareRow[],
        );

  const latest = new Map<string, { sellerId: SellerKey }>();
  const lookup: CargoLookup = {
    truck: (batchId, clientId) => truckShares.get(`${batchId}|${clientId}`),
    deal: (dealId, clientId) => dealShares.get(`${dealId}|${clientId}`),
    lastPrixod: (clientId, txDate) => latest.get(`${clientId}|${txDate}`),
  };

  // D — the fallback's newest prixod: the stamp of the client's newest
  // confirmed prixod received by the END of the row's Tashkent day (the
  // upsale screen's own day bound). A pair with no prixod returns no row, so
  // the lookup answers undefined and the row falls to the book. Asked only
  // for the rows attributeRow will ask it for — `needsFallback` is the one
  // sentence both read.
  const pairs = new Map<string, { clientId: string; txDate: string }>();
  for (const row of rows.filter((r) => needsFallback(r, lookup))) {
    pairs.set(`${row.clientId}|${row.txDate}`, { clientId: row.clientId, txDate: row.txDate });
  }
  const pairList = [...pairs.values()];
  for (let at = 0; at < pairList.length; at += FALLBACK_PAIRS_PER_STATEMENT) {
    const chunk = pairList.slice(at, at + FALLBACK_PAIRS_PER_STATEMENT);
    const found = (await exec.execute(sql`
      SELECT q.client_id::text AS client_id, q.tx_date::text AS tx_date, last.sales_manager_id AS seller_id
        FROM (VALUES ${sql.join(
          chunk.map((p) => sql`(${p.clientId}::uuid, ${p.txDate}::date)`),
          sql`, `,
        )}) AS q(client_id, tx_date)
        JOIN LATERAL (
          SELECT r.sales_manager_id
            FROM receipts r
           WHERE r.client_id = q.client_id
             AND r.status = 'confirmed'
             AND r.received_at < ((q.tx_date + 1)::timestamp AT TIME ZONE 'Asia/Tashkent')
           ORDER BY r.received_at DESC, r.id DESC
           LIMIT 1
        ) last ON true`)) as unknown as { client_id: string; tx_date: string; seller_id: string | null }[];
    for (const row of found) latest.set(`${row.client_id}|${row.tx_date}`, { sellerId: row.seller_id });
  }

  const parts = rows.flatMap((row) => attributeRow(row, lookup));
  // The own result carries ONLY the actor's parts — filtered BEFORE anything is folded, so no
  // figure of a colleague's money can ride out in the shared return type (judge access-O2).
  const kept = scope.kind === 'own' ? parts.filter((p) => p.sellerId === scope.userId) : parts;
  return foldParts(kept);
}
