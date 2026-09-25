import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { tashkentDayStart, addDays } from '@/modules/platform/time/tashkent';

/**
 * The owner's dashboard reads (2026-09-25): where the cargo is, what is at
 * risk, what came in, and what arrived without a price. Each is ONE grouped
 * statement — no per-row round trips — and each is written so a screen that
 * lists the same rows (/transit, /reports/yuk-xavfi, /stock) counts them the
 * same way.
 *
 * Raw SQL with explicit aliases, so a correlated reference can never bind to
 * the wrong table (#128), and every id list goes through `sql.join`, never a
 * bound JS array (a JS array is not a postgres array).
 */

const round = (value: unknown, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(Number(value ?? 0) * f) / f;
};

function idList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/** Cargo on a shelf (the /stock statuses). */
const ON_SHELF = sql`('in_stock', 'planned', 'loading', 'ready_for_pickup')`;

export interface PipelineStage {
  boxes: number;
  m3: number;
  kg: number;
}
export type Pipeline = Record<'cn' | 'road' | 'uz' | 'other', PipelineStage>;

/**
 * Where the cargo stands right now, in journey order: in a Chinese
 * warehouse, on the road, in an Uzbek warehouse (anything else — a third
 * country — is «other»). The shelf stages are exactly /stock's statuses and
 * warehouse, so cn + uz + other equals the stock table's Σ; the road is the
 * boxes still `in_transit` on a truck that is on the road or standing at the
 * gate — /transit's live count. A truck already `unloaded` keeps only its
 * missing cartons in transit, and those are the attention list's business,
 * not a stage.
 */
export async function cargoPipeline(warehouseIds?: string[]): Promise<Pipeline> {
  const scoped = warehouseIds?.length ? warehouseIds : null;
  const scope = scoped
    ? sql`AND ((b.status <> 'in_transit' AND b.current_warehouse_id IN (${idList(scoped)}))
             OR (b.status = 'in_transit' AND (bt.origin_warehouse_id IN (${idList(scoped)})
                                           OR bt.dest_warehouse_id IN (${idList(scoped)}))))`
    : sql``;
  const rows = await db.execute<{ stage: string; boxes: number; m3: string; kg: string }>(sql`
    SELECT stage, count(*)::int AS boxes, coalesce(sum(m3), 0) AS m3, coalesce(sum(kg), 0) AS kg
    FROM (
      SELECT CASE
          WHEN b.status IN ${ON_SHELF} AND w.id IS NOT NULL THEN
            CASE upper(w.country) WHEN 'CN' THEN 'cn' WHEN 'UZ' THEN 'uz' ELSE 'other' END
          WHEN b.status = 'in_transit' AND bt.status IN ('in_transit', 'arrived') THEN 'road'
        END AS stage,
        rl.total_volume_m3 / rl.box_count AS m3,
        rl.total_weight_kg / rl.box_count AS kg
      FROM boxes b
      JOIN receipt_lots rl ON rl.id = b.lot_id
      LEFT JOIN warehouses w ON w.id = b.current_warehouse_id
      LEFT JOIN batches bt ON bt.id = b.current_batch_id
      WHERE b.status IN ('in_stock', 'planned', 'loading', 'ready_for_pickup', 'in_transit')
      ${scope}
    ) x
    WHERE stage IS NOT NULL
    GROUP BY stage
  `);
  const empty = (): PipelineStage => ({ boxes: 0, m3: 0, kg: 0 });
  const out: Pipeline = { cn: empty(), road: empty(), uz: empty(), other: empty() };
  for (const row of rows) {
    const key = row.stage as keyof Pipeline;
    if (key in out) out[key] = { boxes: Number(row.boxes), m3: round(row.m3, 3), kg: round(row.kg, 1) };
  }
  return out;
}

export type RiskKind = 'missing' | 'lost' | 'phantom' | 'undocumented';

export interface RiskSummary {
  boxes: number;
  m3: number;
  /** The landed cost already allocated to these cartons — money spent carrying them, not their value. */
  usd: number;
}

/**
 * The four ways a carton's money can be wrong or gone, as ONE shared set of
 * fragments so the dashboard's counts and /reports/yuk-xavfi's lists are the
 * same rows:
 *
 * - missing: flagged `missing_in_transit` on unload and not resolved — the
 *   truck arrived without it (scoped by the truck's two ends, /transit's rule).
 * - lost: written off as lost in the last N days.
 * - phantom: recorded as departed on a truck, then found at the ORIGIN — it
 *   never rode that truck, yet may still carry that truck's freight share.
 *   Counted only while it still does: that is money actually misallocated.
 * - undocumented: arrived on a truck without a load scan.
 *
 * A void carton is never cargo (the annul round's rule) and counts nowhere.
 */
function riskCtes(warehouseIds: string[] | undefined, sinceIso: string): SQL {
  const scoped = warehouseIds?.length ? warehouseIds : null;
  const truckScope = (alias: string) =>
    scoped
      ? sql`AND (${sql.raw(alias)}.origin_warehouse_id IN (${idList(scoped)}) OR ${sql.raw(alias)}.dest_warehouse_id IN (${idList(scoped)}))`
      : sql``;
  const shelfScope = scoped
    ? sql`AND (b.current_warehouse_id IN (${idList(scoped)}) OR b.current_warehouse_id IS NULL)`
    : sql``;
  return sql`
    missing AS (
      SELECT b.id AS box_id, bt.id AS batch_id
      FROM boxes b JOIN batches bt ON bt.id = b.current_batch_id
      WHERE b.flags @> '["missing_in_transit"]'::jsonb AND b.status <> 'void' ${truckScope('bt')}
    ),
    lost AS (
      SELECT b.id AS box_id, NULL::uuid AS batch_id
      FROM boxes b
      WHERE b.status = 'lost'
        AND EXISTS (SELECT 1 FROM box_movements lm
                    WHERE lm.box_id = b.id AND lm.to_status = 'lost' AND lm.created_at >= ${sinceIso}::timestamptz)
        ${shelfScope}
    ),
    phantom AS (
      SELECT DISTINCT fm.box_id, fm.ref_id AS batch_id
      FROM box_movements fm
      JOIN boxes b ON b.id = fm.box_id AND b.status <> 'void'
      JOIN batches bt ON bt.id = fm.ref_id
      WHERE fm.cause = 'found_at_origin' AND fm.ref_type = 'batch' ${truckScope('bt')}
        AND EXISTS (
          SELECT 1 FROM cost_allocations ca
          JOIN cost_entries ce ON ce.id = ca.cost_entry_id AND ce.voided_at IS NULL
          WHERE ca.box_id = fm.box_id AND ce.batch_id = fm.ref_id AND ce.scope = 'batch')
    ),
    undocumented AS (
      SELECT b.id AS box_id, NULL::uuid AS batch_id
      FROM boxes b
      WHERE b.flags @> '["undocumented_transfer"]'::jsonb AND b.status <> 'void' ${shelfScope}
    )`;
}

/** The money a set of cartons carries: every live allocation, or only the named truck's (phantom). */
function riskUsd(kind: RiskKind): SQL {
  return kind === 'phantom'
    ? sql`(SELECT coalesce(sum(ca.amount_usd), 0) FROM cost_allocations ca
           JOIN cost_entries ce ON ce.id = ca.cost_entry_id AND ce.voided_at IS NULL
           WHERE ca.box_id = r.box_id AND ce.batch_id = r.batch_id AND ce.scope = 'batch')`
    : sql`(SELECT coalesce(sum(ca.amount_usd), 0) FROM cost_allocations ca
           JOIN cost_entries ce ON ce.id = ca.cost_entry_id AND ce.voided_at IS NULL
           WHERE ca.box_id = r.box_id)`;
}

const RISK_KINDS: RiskKind[] = ['missing', 'lost', 'phantom', 'undocumented'];

export async function cargoAtRisk(
  warehouseIds?: string[],
  lostDays = 30,
  now: Date = new Date(),
): Promise<Record<RiskKind, RiskSummary>> {
  const sinceIso = new Date(now.getTime() - lostDays * 86_400_000).toISOString();
  const branches = sql.join(
    RISK_KINDS.map(
      (kind) => sql`
        SELECT ${kind}::text AS kind, count(DISTINCT r.box_id)::int AS boxes,
               coalesce(sum(rl.total_volume_m3 / rl.box_count), 0) AS m3,
               coalesce(sum(${riskUsd(kind)}), 0) AS usd
        FROM ${sql.raw(kind)} r
        JOIN boxes b ON b.id = r.box_id
        JOIN receipt_lots rl ON rl.id = b.lot_id`,
    ),
    sql` UNION ALL `,
  );
  const rows = await db.execute<{ kind: RiskKind; boxes: number; m3: string; usd: string }>(
    sql`WITH ${riskCtes(warehouseIds, sinceIso)} ${branches}`,
  );
  const out = Object.fromEntries(RISK_KINDS.map((kind) => [kind, { boxes: 0, m3: 0, usd: 0 }])) as Record<
    RiskKind,
    RiskSummary
  >;
  for (const row of rows) {
    out[row.kind] = { boxes: Number(row.boxes), m3: round(row.m3, 3), usd: round(row.usd) };
  }
  return out;
}

export interface RiskRow {
  boxId: string;
  shortCode: string;
  clientCode: string | null;
  marking: string | null;
  batchId: string | null;
  batchCode: string | null;
  m3: number;
  usd: number;
}

/** The rows behind one of `cargoAtRisk`'s counts, the costliest first. */
export async function cargoRiskList(
  kind: RiskKind,
  warehouseIds?: string[],
  limit = 100,
  lostDays = 30,
  now: Date = new Date(),
): Promise<RiskRow[]> {
  const sinceIso = new Date(now.getTime() - lostDays * 86_400_000).toISOString();
  const rows = await db.execute<{
    box_id: string;
    short_code: string;
    client_code: string | null;
    marking: string | null;
    batch_id: string | null;
    batch_code: string | null;
    m3: string;
    usd: string;
  }>(sql`
    WITH ${riskCtes(warehouseIds, sinceIso)}
    SELECT r.box_id, b.short_code, c.client_code, rc.unclaimed_marking AS marking,
           coalesce(r.batch_id, b.current_batch_id) AS batch_id, bt.code AS batch_code,
           rl.total_volume_m3 / rl.box_count AS m3, ${riskUsd(kind)} AS usd
    FROM ${sql.raw(kind)} r
    JOIN boxes b ON b.id = r.box_id
    JOIN receipt_lots rl ON rl.id = b.lot_id
    JOIN receipts rc ON rc.id = rl.receipt_id
    LEFT JOIN clients c ON c.id = rc.client_id
    LEFT JOIN batches bt ON bt.id = coalesce(r.batch_id, b.current_batch_id)
    ORDER BY usd DESC, b.short_code
    LIMIT ${limit}
  `);
  return rows.map((row) => ({
    boxId: row.box_id,
    shortCode: row.short_code,
    clientCode: row.client_code,
    marking: row.marking,
    batchId: row.batch_id,
    batchCode: row.batch_code,
    m3: round(row.m3, 3),
    usd: round(row.usd),
  }));
}

export interface IntakeMonth {
  month: string;
  receipts: number;
  boxes: number;
  m3: number;
  kg: number;
  /** The same, counting only days 1..mtdDay of that month — the like-for-like comparison. */
  receiptsMtd: number;
  boxesMtd: number;
  m3Mtd: number;
}

/**
 * What the warehouses took in, per Tashkent month: confirmed receipts, their
 * boxes, m³ and kg. The `*Mtd` columns count days 1..mtdDay only, so this
 * month-to-date can be compared with the same days of last month in the same
 * statement. The window is Tashkent's (R5), bound as ISO instants (#156).
 */
export async function intakeByMonth(
  from: string,
  to: string,
  warehouseIds?: string[],
  mtdDay = 31,
): Promise<IntakeMonth[]> {
  const start = tashkentDayStart(from).toISOString();
  const end = tashkentDayStart(addDays(to, 1)).toISOString();
  const scope = warehouseIds?.length ? sql`AND r.warehouse_id IN (${idList(warehouseIds)})` : sql``;
  const dom = sql`extract(day FROM r.received_at AT TIME ZONE 'Asia/Tashkent') <= ${mtdDay}`;
  const rows = await db.execute<{
    month: string;
    receipts: number;
    boxes: number;
    m3: string;
    kg: string;
    receipts_mtd: number;
    boxes_mtd: number;
    m3_mtd: string;
  }>(sql`
    SELECT to_char(r.received_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM') AS month,
      count(DISTINCT r.id)::int AS receipts,
      coalesce(sum(rl.box_count), 0)::int AS boxes,
      coalesce(sum(rl.total_volume_m3), 0) AS m3,
      coalesce(sum(rl.total_weight_kg), 0) AS kg,
      count(DISTINCT r.id) FILTER (WHERE ${dom})::int AS receipts_mtd,
      coalesce(sum(rl.box_count) FILTER (WHERE ${dom}), 0)::int AS boxes_mtd,
      coalesce(sum(rl.total_volume_m3) FILTER (WHERE ${dom}), 0) AS m3_mtd
    FROM receipts r
    LEFT JOIN receipt_lots rl ON rl.receipt_id = r.id
    WHERE r.status = 'confirmed'
      AND r.received_at >= ${start}::timestamptz AND r.received_at < ${end}::timestamptz
      ${scope}
    GROUP BY 1
    ORDER BY 1
  `);
  return rows.map((row) => ({
    month: row.month,
    receipts: Number(row.receipts),
    boxes: Number(row.boxes),
    m3: round(row.m3, 3),
    kg: round(row.kg, 1),
    receiptsMtd: Number(row.receipts_mtd),
    boxesMtd: Number(row.boxes_mtd),
    m3Mtd: round(row.m3_mtd, 3),
  }));
}

export interface UnbilledClient {
  clientId: string;
  clientCode: string;
  name: string;
  receipts: number;
  boxes: number;
  m3: number;
  kg: number;
  /** The earliest day any of this unbilled cargo landed in Uzbekistan. */
  firstArrivedAt: Date;
  /** Boxes of it already handed to the client — the money most at risk. */
  issuedBoxes: number;
}

/**
 * «Yetib kelgan, lekin narx yozilmagan yuk» (owner 8a): cargo that reached an
 * Uzbek warehouse — or was already handed over — whose client has NO price
 * covering it.
 *
 * «Covered» follows his answer 7: a prixod split over two trucks may be billed
 * ONCE or per truck, so a charge on ANY truck that carried part of this
 * prixod covers all of it, and so does a charge on the prixod's deal. A price
 * typed on the client's card with neither a truck nor a deal names no cargo
 * and cannot cover anything — the screen says so beside the list rather than
 * guessing which cargo it meant.
 *
 * «Landed in Uzbekistan» is the movement that put the box INTO a UZ warehouse
 * from somewhere else (`landedHereSql`'s three clauses). Unclaimed cargo has
 * no client to bill and is the /unclaimed screen's; a lost or void carton is
 * not cargo to bill.
 */
export async function unbilledArrived(warehouseIds?: string[]): Promise<UnbilledClient[]> {
  const scope = warehouseIds?.length
    ? sql`AND (b.current_warehouse_id IN (${idList(warehouseIds)}) OR (b.status = 'issued' AND lm.to_warehouse_id IN (${idList(warehouseIds)})))`
    : sql``;
  const rows = await db.execute<{
    client_id: string;
    client_code: string;
    name: string;
    receipts: number;
    boxes: number;
    m3: string;
    kg: string;
    first_arrived_at: string;
    issued_boxes: number;
  }>(sql`
    WITH landed AS (
      SELECT b.id AS box_id, b.status, rl.receipt_id, r.client_id, r.deal_id,
             rl.total_volume_m3 / rl.box_count AS m3, rl.total_weight_kg / rl.box_count AS kg,
             min(lm.created_at) AS arrived_at
      FROM boxes b
      JOIN receipt_lots rl ON rl.id = b.lot_id
      JOIN receipts r ON r.id = rl.receipt_id AND r.status = 'confirmed' AND r.client_id IS NOT NULL
      JOIN box_movements lm ON lm.box_id = b.id
      JOIN warehouses w ON w.id = lm.to_warehouse_id AND upper(w.country) = 'UZ'
      WHERE b.status IN ('in_stock', 'planned', 'loading', 'ready_for_pickup', 'issued')
        AND lm.from_warehouse_id IS DISTINCT FROM lm.to_warehouse_id
        AND lm.to_status <> 'in_transit'
        AND lm.cause <> 'found_at_origin'
        ${scope}
      GROUP BY b.id, b.status, rl.receipt_id, r.client_id, r.deal_id, rl.total_volume_m3, rl.total_weight_kg, rl.box_count
    ),
    rides AS (
      SELECT DISTINCT rl.receipt_id, bm.ref_id AS batch_id
      FROM box_movements bm
      JOIN boxes b ON b.id = bm.box_id
      JOIN receipt_lots rl ON rl.id = b.lot_id
      WHERE bm.ref_type = 'batch' AND bm.cause = 'batch_departed'
        AND rl.receipt_id IN (SELECT DISTINCT receipt_id FROM landed)
    ),
    receipts_landed AS (
      SELECT DISTINCT receipt_id, client_id, deal_id FROM landed
    ),
    unbilled AS (
      SELECT rl.receipt_id FROM receipts_landed rl
      WHERE NOT EXISTS (
        SELECT 1 FROM client_transactions ct
        WHERE ct.client_id = rl.client_id AND ct.type = 'charge' AND ct.voided_at IS NULL
          AND (ct.batch_id IN (SELECT rd.batch_id FROM rides rd WHERE rd.receipt_id = rl.receipt_id)
               OR (rl.deal_id IS NOT NULL AND ct.deal_id = rl.deal_id)))
    )
    SELECT l.client_id, c.client_code, c.name,
           count(DISTINCT l.receipt_id)::int AS receipts, count(*)::int AS boxes,
           coalesce(sum(l.m3), 0) AS m3, coalesce(sum(l.kg), 0) AS kg,
           min(l.arrived_at) AS first_arrived_at,
           count(*) FILTER (WHERE l.status = 'issued')::int AS issued_boxes
    FROM landed l
    JOIN clients c ON c.id = l.client_id
    WHERE l.receipt_id IN (SELECT receipt_id FROM unbilled)
    GROUP BY l.client_id, c.client_code, c.name
    ORDER BY min(l.arrived_at)
  `);
  return rows.map((row) => ({
    clientId: row.client_id,
    clientCode: row.client_code,
    name: row.name,
    receipts: Number(row.receipts),
    boxes: Number(row.boxes),
    m3: round(row.m3, 3),
    kg: round(row.kg, 1),
    firstArrivedAt: new Date(row.first_arrived_at),
    issuedBoxes: Number(row.issued_boxes),
  }));
}

export interface LossSummary {
  /** Cartons written off as lost within the period (by the day they were marked). */
  lost: { boxes: number; m3: number; usd: number };
  /** Cartons a truck arrived without, still unresolved — lost until somebody finds them. */
  missing: { boxes: number; m3: number; usd: number };
}

/**
 * «Yo'qotishlar» for the P&L page (owner 6a): what was lost in the period and
 * what the money already spent carrying it comes to. INFORMATION, not a line
 * of the P&L — that money is already inside the cargo costs above it, so
 * subtracting it again would count it twice (his answer: the money stays in
 * the client's tannarx; the report shows the loss beside it).
 */
export async function lossesInPeriod(from: string, to: string): Promise<LossSummary> {
  const start = tashkentDayStart(from).toISOString();
  const end = tashkentDayStart(addDays(to, 1)).toISOString();
  const cost = sql`(SELECT coalesce(sum(ca.amount_usd), 0) FROM cost_allocations ca
                    JOIN cost_entries ce ON ce.id = ca.cost_entry_id AND ce.voided_at IS NULL
                    WHERE ca.box_id = b.id)`;
  const [row] = await db.execute<{
    lost_boxes: number;
    lost_m3: string;
    lost_usd: string;
    missing_boxes: number;
    missing_m3: string;
    missing_usd: string;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE k = 'lost')::int AS lost_boxes,
      coalesce(sum(m3) FILTER (WHERE k = 'lost'), 0) AS lost_m3,
      coalesce(sum(usd) FILTER (WHERE k = 'lost'), 0) AS lost_usd,
      count(*) FILTER (WHERE k = 'missing')::int AS missing_boxes,
      coalesce(sum(m3) FILTER (WHERE k = 'missing'), 0) AS missing_m3,
      coalesce(sum(usd) FILTER (WHERE k = 'missing'), 0) AS missing_usd
    FROM (
      SELECT 'lost' AS k, rl.total_volume_m3 / rl.box_count AS m3, ${cost} AS usd
      FROM boxes b JOIN receipt_lots rl ON rl.id = b.lot_id
      WHERE b.status = 'lost' AND EXISTS (
        SELECT 1 FROM box_movements lm WHERE lm.box_id = b.id AND lm.to_status = 'lost'
          AND lm.created_at >= ${start}::timestamptz AND lm.created_at < ${end}::timestamptz)
      UNION ALL
      SELECT 'missing', rl.total_volume_m3 / rl.box_count, ${cost}
      FROM boxes b JOIN receipt_lots rl ON rl.id = b.lot_id
      WHERE b.flags @> '["missing_in_transit"]'::jsonb AND b.status <> 'void'
    ) x
  `);
  return {
    lost: { boxes: Number(row?.lost_boxes ?? 0), m3: round(row?.lost_m3, 3), usd: round(row?.lost_usd) },
    missing: {
      boxes: Number(row?.missing_boxes ?? 0),
      m3: round(row?.missing_m3, 3),
      usd: round(row?.missing_usd),
    },
  };
}
