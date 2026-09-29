import { sql, type SQL } from 'drizzle-orm';
import type { db } from '../../platform/db/client';
import { CARGO_STATUSES } from '../finance/unpriced';
import { monthRange } from './month';

/**
 * The cargo a seller BROUGHT (0117, the owner's 1a / 2a / 5b) — ONE reader for
 * every surface that says it: /hodimlar's KPI, the profile's «Bu oy», the
 * seller report (/reports/sotuvchilar) and the /upsale «yuk» block (#513).
 *
 *  - WHOSE: the receipt's own stamp (`receipts.sales_manager_id`, written the
 *    day the cargo got its client — wms/staff/stamp.ts), never the client
 *    book, which answers «who is the seller NOW» (his 2a).
 *  - WHEN: `received_at`, the day the cargo was received — in China or, for a
 *    walk-in, in Uzbekistan (his 5b) — cut by TASHKENT months. The office door
 *    back-dates it and the receipt card corrects it; `confirmed_at` is the
 *    entry clock and would put a back-dated prixod in the wrong month.
 *  - THE GRAIN is the CARTON, the unpriced rule's own grain
 *    (finance/unpriced.ts): a carton of a confirmed, claimed receipt still in
 *    `CARGO_STATUSES` — so a lost or annulled carton drops out of the kub the
 *    same way it drops out of what can be billed, and the KPI's «paid» part
 *    (kpi-paid.ts) is counted over exactly these cartons. Per carton m³ and kg
 *    are the lot's share, `total / box_count` — `u_box`'s own expressions, held
 *    equal by staff-pay.integration's reconciliation test.
 *
 * Every reader takes the executor as a REQUIRED argument (#714: payKpi reads
 * this inside its own transaction), and the scope is REQUIRED too (#790: an
 * optional scope fails OPEN — the whole company where one seller was meant).
 */

export type Exec = Pick<typeof db, 'execute'>;

/** Whose cargo a reader asks about. */
export type StaffScope = { kind: 'all' } | { kind: 'own'; userId: string };

/** Which cartons by their stamp: one seller, every stamped seller, or nobody's. */
export type CartonOwner = { sellerId: string } | 'stamped' | 'unstamped';

const ownerSql = (who: CartonOwner): SQL =>
  who === 'stamped'
    ? sql`r.sales_manager_id IS NOT NULL`
    : who === 'unstamped'
      ? sql`r.sales_manager_id IS NULL`
      : sql`r.sales_manager_id = ${who.sellerId}::uuid`;

/**
 * The Tashkent month (`YYYY-MM`) a receipt was received in — ONE fragment for
 * the cargo reader and the paid part (kpi-paid.ts), because a label that
 * drifted from `monthRange`'s Tashkent BOUNDS would file a receipt of 00:30
 * on the 1st inside month M's range under M-1, and the month's cargo would
 * vanish from both the KPI and its paid m³. `received_at` is a timestamptz,
 * so the zone is named here and never left to the session's.
 */
export const receivedMonthSql = (receivedAt: SQL): SQL =>
  sql`to_char(${receivedAt} AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM')`;

/**
 * The cartons, one row each: the receipt, its number, client and stamp, the
 * TASHKENT month it was received in, and the carton's share of its lot. A lot
 * whose kg or m³ is not positive would move the density band without being
 * cargo anyone measured, so it is flagged (`unmeasured`) rather than summed
 * silently — the engine refuses such a month and names the receipt.
 */
export function stampedCartonsSql(q: { from: Date; to: Date; who: CartonOwner }): SQL {
  return sql`
    SELECT b.id AS box_id, r.id AS receipt_id, r.number, r.client_id, r.sales_manager_id AS seller_id,
           ${receivedMonthSql(sql`r.received_at`)} AS month,
           rl.total_volume_m3 / rl.box_count AS m3,
           rl.total_weight_kg / rl.box_count AS kg,
           (rl.total_volume_m3 <= 0 OR rl.total_weight_kg <= 0) AS unmeasured
      FROM receipts r
      JOIN receipt_lots rl ON rl.receipt_id = r.id
      JOIN boxes b ON b.lot_id = rl.id
     WHERE r.status = 'confirmed'
       AND r.client_id IS NOT NULL
       AND r.received_at >= ${q.from.toISOString()}::timestamptz
       AND r.received_at < ${q.to.toISOString()}::timestamptz
       AND b.status IN ${CARGO_STATUSES}
       AND ${ownerSql(q.who)}`;
}

export interface StampedCargo {
  sellerId: string;
  sellerName: string | null;
  receipts: number;
  kg: number;
  m3: number;
  /** Receipt NUMBERS of lots with no positive kg or m³ (the engine's `lot_unmeasured`). */
  unmeasured: string[];
}

const round4 = (n: unknown) => Math.round(Number(n ?? 0) * 10_000) / 10_000;
const round3 = (n: unknown) => Math.round(Number(n ?? 0) * 1000) / 1000;

type Row = {
  seller_id: string;
  seller_name?: string | null;
  receipts: string | number;
  kg: string;
  m3: string;
  unmeasured: string[] | null;
};

const toCargo = (row: Row): StampedCargo => ({
  sellerId: row.seller_id,
  sellerName: row.seller_name ?? null,
  receipts: Number(row.receipts),
  kg: round3(row.kg),
  m3: round4(row.m3),
  unmeasured: (row.unmeasured ?? []).filter(Boolean).sort(),
});

/** Per seller over a period — the report's and /upsale's read. */
export async function stampedCargo(exec: Exec, q: { from: Date; to: Date }, scope: StaffScope): Promise<StampedCargo[]> {
  const who: CartonOwner = scope.kind === 'own' ? { sellerId: scope.userId } : 'stamped';
  const rows = (await exec.execute(sql`
    SELECT c.seller_id,
           u.full_name AS seller_name,
           count(DISTINCT c.receipt_id) AS receipts,
           coalesce(sum(c.kg), 0) AS kg,
           coalesce(sum(c.m3), 0) AS m3,
           array_agg(DISTINCT coalesce(c.number, c.receipt_id::text)) FILTER (WHERE c.unmeasured) AS unmeasured
      FROM (${stampedCartonsSql({ ...q, who })}) c
      LEFT JOIN users u ON u.id = c.seller_id
     GROUP BY c.seller_id, u.full_name
     ORDER BY sum(c.m3) DESC`)) as unknown as Row[];
  return [...rows].map(toCargo);
}

export interface MonthCargo extends Omit<StampedCargo, 'sellerId' | 'sellerName'> {
  /** `YYYY-MM`, Tashkent. */
  month: string;
}

/** Both ends inclusive, as Tashkent months. */
const monthsRange = (fromMonth: string, toMonth: string) => ({
  from: monthRange(fromMonth).from,
  to: monthRange(toMonth).to,
});

/** One seller month by month, `fromMonth`..`toMonth` inclusive — the KPI's read. */
export async function stampedCargoByMonth(
  exec: Exec,
  sellerId: string,
  fromMonth: string,
  toMonth: string,
): Promise<MonthCargo[]> {
  const range = monthsRange(fromMonth, toMonth);
  const rows = (await exec.execute(sql`
    SELECT c.month,
           c.seller_id,
           count(DISTINCT c.receipt_id) AS receipts,
           coalesce(sum(c.kg), 0) AS kg,
           coalesce(sum(c.m3), 0) AS m3,
           array_agg(DISTINCT coalesce(c.number, c.receipt_id::text)) FILTER (WHERE c.unmeasured) AS unmeasured
      FROM (${stampedCartonsSql({ ...range, who: { sellerId } })}) c
     GROUP BY c.month, c.seller_id
     ORDER BY c.month`)) as unknown as (Row & { month: string })[];
  return [...rows].map((row) => {
    const cargo = toCargo(row);
    return { month: row.month, receipts: cargo.receipts, kg: cargo.kg, m3: cargo.m3, unmeasured: cargo.unmeasured };
  });
}

/** Every stamped seller, month by month — the company-wide KPI (/hodimlar). */
export async function stampedCargoBySellerMonth(
  exec: Exec,
  fromMonth: string,
  toMonth: string,
): Promise<(StampedCargo & { month: string })[]> {
  const range = monthsRange(fromMonth, toMonth);
  const rows = (await exec.execute(sql`
    SELECT c.month,
           c.seller_id,
           count(DISTINCT c.receipt_id) AS receipts,
           coalesce(sum(c.kg), 0) AS kg,
           coalesce(sum(c.m3), 0) AS m3,
           array_agg(DISTINCT coalesce(c.number, c.receipt_id::text)) FILTER (WHERE c.unmeasured) AS unmeasured
      FROM (${stampedCartonsSql({ ...range, who: 'stamped' })}) c
     GROUP BY c.month, c.seller_id`)) as unknown as (Row & { month: string })[];
  return [...rows].map((row) => ({ month: row.month, ...toCargo(row) }));
}

export interface UnstampedClientCargo {
  clientId: string;
  clientCode: string;
  clientName: string;
  /**
   * The seller the client card names NOW, or null. Non-null here means the
   * client form's stamp missed these receipts — a prixod confirmed in the
   * same moment the first seller was named (its INSERT read the client before
   * the save, and committed after `stampUnattributedCargo` had run) — and no
   * later save will ever stamp them, because the client has a seller now.
   * The list offers the repair (`stampToCurrentSeller`).
   */
  currentSellerId: string | null;
  currentSellerName: string | null;
  receipts: number;
  kg: number;
  m3: number;
}

/**
 * «Sotuvchisiz yuk»: the period's cargo nobody was named on, per CLIENT — the
 * list /hodimlar shows with «mijozga sotuvchi belgilang», because naming a
 * seller on the client card is what stamps it (`stampUnattributedCargo`).
 */
export async function unstampedCargo(exec: Exec, q: { from: Date; to: Date }): Promise<UnstampedClientCargo[]> {
  const rows = (await exec.execute(sql`
    SELECT c.client_id, cl.client_code, cl.name, cl.sales_manager_id, su.full_name AS seller_name,
           count(DISTINCT c.receipt_id) AS receipts,
           coalesce(sum(c.kg), 0) AS kg,
           coalesce(sum(c.m3), 0) AS m3
      FROM (${stampedCartonsSql({ ...q, who: 'unstamped' })}) c
      JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN users su ON su.id = cl.sales_manager_id
     GROUP BY c.client_id, cl.client_code, cl.name, cl.sales_manager_id, su.full_name
     ORDER BY sum(c.m3) DESC, cl.client_code`)) as unknown as {
    client_id: string;
    client_code: string;
    name: string;
    sales_manager_id: string | null;
    seller_name: string | null;
    receipts: string | number;
    kg: string;
    m3: string;
  }[];
  return [...rows].map((row) => ({
    clientId: row.client_id,
    clientCode: row.client_code,
    clientName: row.name,
    currentSellerId: row.sales_manager_id,
    currentSellerName: row.seller_name,
    receipts: Number(row.receipts),
    kg: round3(row.kg),
    m3: round4(row.m3),
  }));
}
