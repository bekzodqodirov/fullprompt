import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { tashkentDayStart, addDays } from '@/modules/platform/time/tashkent';
import { leftBehindSql } from '../batches/riders';
import { roadLossBatchSql } from '../boxes/road-loss';
import { customsCostTypeIds } from '../costing/service';
import { withoutJit } from '../../platform/db/no-jit';
import { GATE_OFF, unpricedReceiptsOn } from '../finance/unpriced';

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
 * - phantom: recorded as departed on a truck, then found back at the ORIGIN
 *   (`leftBehindSql` — the money readers' own rule: the manager's
 *   `found_at_origin` AND the loader's accept-found / the stocktake) — it
 *   never rode that truck, yet may still carry that truck's ROAD cost share
 *   (freight and every non-customs bill — the truck's own and the grid cells
 *   stamped with it, which a re-split moves off it too: `scopeBoxIds`, U17 ×
 *   U18, and `riderRepairPlan` counts both). Its CUSTOMS share is right to stay
 *   — the carton was declared, and the owner's rule (2026-09-25) is that it
 *   is billed on the next truck — so a customs allocation is not counted.
 *   Counted only while a road share remains: money a re-split has not moved.
 *   Since the found-back doors re-split the truck after their commit (U17)
 *   and `pnpm repair-riders` fixes the old ones, this reads zero on repaired
 *   data — a non-zero count is a re-split that failed and wants the script.
 * - undocumented: arrived on a truck without a load scan.
 *
 * A void carton is never cargo (the annul round's rule) and counts nowhere.
 */
/** A cost entry (by alias) that is a ROAD cost of its truck — not a customs type. */
function roadCostSql(entryAlias: string, customsTypeIds: string[]): SQL {
  return customsTypeIds.length
    ? sql`AND ${sql.raw(entryAlias)}.cost_type_id NOT IN (${idList(customsTypeIds)})`
    : sql``;
}

function riskCtes(warehouseIds: string[] | undefined, sinceIso: string, customsTypeIds: string[]): SQL {
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
      -- A carton lost ON THE ROAD (U38) stands in no warehouse, so the shelf
      -- rule would count it in EVERY warehouse's scope; it belongs to its
      -- truck's two ends instead, /transit's rule, and its row names the truck
      -- (boxes/road-loss.ts — the box card and the search read the same one).
      SELECT b.id AS box_id, rbt.id AS batch_id
      FROM boxes b
      LEFT JOIN batches rbt ON rbt.id = ${roadLossBatchSql('b')}
      WHERE b.status = 'lost'
        AND EXISTS (SELECT 1 FROM box_movements lm
                    WHERE lm.box_id = b.id AND lm.to_status = 'lost' AND lm.created_at >= ${sinceIso}::timestamptz)
        ${
          scoped
            ? sql`AND (CASE WHEN rbt.id IS NOT NULL
                   THEN (rbt.origin_warehouse_id IN (${idList(scoped)}) OR rbt.dest_warehouse_id IN (${idList(scoped)}))
                   ELSE (b.current_warehouse_id IN (${idList(scoped)}) OR b.current_warehouse_id IS NULL) END)`
            : sql``
        }
    ),
    phantom AS (
      SELECT DISTINCT dm.box_id, dm.ref_id AS batch_id
      FROM box_movements fb
      JOIN box_movements dm ON dm.box_id = fb.box_id
                           AND dm.ref_type = 'batch' AND dm.cause = 'batch_departed'
      JOIN boxes b ON b.id = dm.box_id
      JOIN batches bt ON bt.id = dm.ref_id
      WHERE fb.cause IN ('found_at_origin', 'inventory_found') ${truckScope('bt')}
        AND ${leftBehindSql(sql`dm.ref_id`, 'b')}
        AND EXISTS (
          SELECT 1 FROM cost_allocations ca
          JOIN cost_entries ce ON ce.id = ca.cost_entry_id AND ce.voided_at IS NULL
          WHERE ca.box_id = dm.box_id AND ce.batch_id = dm.ref_id
            ${roadCostSql('ce', customsTypeIds)})
    ),
    undocumented AS (
      SELECT b.id AS box_id, NULL::uuid AS batch_id
      FROM boxes b
      WHERE b.flags @> '["undocumented_transfer"]'::jsonb AND b.status <> 'void' ${shelfScope}
    )`;
}

/** The money a set of cartons carries: every live allocation, or only the named truck's (phantom). */
function riskUsd(kind: RiskKind, customsTypeIds: string[]): SQL {
  return kind === 'phantom'
    ? sql`(SELECT coalesce(sum(ca.amount_usd), 0) FROM cost_allocations ca
           JOIN cost_entries ce ON ce.id = ca.cost_entry_id AND ce.voided_at IS NULL
           WHERE ca.box_id = r.box_id AND ce.batch_id = r.batch_id
             ${roadCostSql('ce', customsTypeIds)})`
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
  const customsTypeIds = await customsCostTypeIds();
  const branches = sql.join(
    RISK_KINDS.map(
      (kind) => sql`
        SELECT ${kind}::text AS kind, count(DISTINCT r.box_id)::int AS boxes,
               coalesce(sum(rl.total_volume_m3 / rl.box_count), 0) AS m3,
               coalesce(sum(${riskUsd(kind, customsTypeIds)}), 0) AS usd
        FROM ${sql.raw(kind)} r
        JOIN boxes b ON b.id = r.box_id
        JOIN receipt_lots rl ON rl.id = b.lot_id`,
    ),
    sql` UNION ALL `,
  );
  const rows = await db.execute<{ kind: RiskKind; boxes: number; m3: string; usd: string }>(
    sql`WITH ${riskCtes(warehouseIds, sinceIso, customsTypeIds)} ${branches}`,
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
  const customsTypeIds = await customsCostTypeIds();
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
    WITH ${riskCtes(warehouseIds, sinceIso, customsTypeIds)}
    SELECT r.box_id, b.short_code, c.client_code, rc.unclaimed_marking AS marking,
           coalesce(r.batch_id, b.current_batch_id) AS batch_id, bt.code AS batch_code,
           rl.total_volume_m3 / rl.box_count AS m3, ${riskUsd(kind, customsTypeIds)} AS usd
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
 * Uzbek warehouse — or was already handed over — with no price covering it,
 * per client.
 *
 * The rule is `finance/unpriced.ts`'s and nowhere else (#513): the handover
 * gate refuses exactly these cartons and the accountant's list names exactly
 * these prixods, so the dashboard and the counter one tap apart cannot
 * disagree about which cargo is unpriced. It used to be restated here, and
 * the restatement was already three sentences out of date — a carton found
 * back at Yiwu still «rode» the first truck (U17), a price on the Andijan →
 * Tashkent leg covered cargo that came from China (Q1), and a landed carton
 * vanished from the list for the day it rode that local leg.
 *
 * The gate's instant does not matter to these figures (nothing here counts
 * gated cartons), so the ban's setting is not read.
 */
export async function unbilledArrived(warehouseIds?: string[]): Promise<UnbilledClient[]> {
  // Every carton the company holds: past JIT's cost line by shape (no-jit.ts).
  const receipts = await withoutJit((exec) =>
    unpricedReceiptsOn(exec, { kind: 'company', warehouseIds, ownerId: undefined, landedFrom: undefined }, GATE_OFF),
  );
  const byClient = new Map<string, UnbilledClient>();
  for (const row of receipts) {
    const prev = byClient.get(row.clientId);
    if (!prev) {
      byClient.set(row.clientId, {
        clientId: row.clientId,
        clientCode: row.clientCode,
        name: row.clientName,
        receipts: 1,
        boxes: row.boxes,
        m3: row.m3,
        kg: row.kg,
        firstArrivedAt: row.firstLandedAt,
        issuedBoxes: row.issuedBoxes,
      });
      continue;
    }
    prev.receipts += 1;
    prev.boxes += row.boxes;
    prev.m3 += row.m3;
    prev.kg += row.kg;
    prev.issuedBoxes += row.issuedBoxes;
    if (row.firstLandedAt < prev.firstArrivedAt) prev.firstArrivedAt = row.firstLandedAt;
  }
  return [...byClient.values()]
    .map((row) => ({ ...row, m3: round(row.m3, 3), kg: round(row.kg, 1) }))
    .sort((a, b) => a.firstArrivedAt.getTime() - b.firstArrivedAt.getTime());
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
      -- «missing» is TODAY's state, on every period's report and said so in
      -- its words: a flag carries no date to bound it by.
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
