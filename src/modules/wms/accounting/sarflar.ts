import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { addDays, calendarDay, tashkentDay, tashkentMonthStart } from '../../platform/time/tashkent';
import { isUuidShaped } from '../../platform/audit/fields';
import type { CompanyMoneySight } from '../finance/scope';
import type { CostSight } from '../costing/cost-sight';
import { unplacedCostSql, unplacedCostSince } from '../costing/service';
import { resolvePeriod } from './period';
import { internalLegSql } from '../batches/internal';
import { staffPartnerSql } from '../partners/staff';
import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { batchTabHref, mayOpenBatchCard, mayOpenBatchCosts } from '../batches/card-door';
import { mayPickTill } from './till-door';

/**
 * «Pul qayerga ketdi» — the spending map (docs/SARFLAR.md §1, §8.3). Every
 * figure here is a regrouping of the SAME money the P&L adds up: the live
 * cost entries and expenses dated in the period, by the date written on them.
 * So every breakdown — by kind, by warehouse, by payer — reconciles to the
 * «kitob jami» (direct + opex, the P&L's own two totals), and the kurs farqi
 * is the one bridge line between that and the P&L's «Xarajat».
 *
 * ONE row set (`spendRowsSql`) carries the three CASEs — the kind, the place,
 * the payer — and every block and the register's filter group or filter over
 * it, so a filter can never select a different set from the bar it came from
 * (#513). Every reader takes the `CompanyMoneySight` brand: only the
 * predicate can mint one, so a block mounted without the page's door is a
 * compile error, not a leak.
 */

// ---------------------------------------------------------------------------
// The period (§8.3): this month by default, the P&L's clock (the date
// written on the row).
// ---------------------------------------------------------------------------

export type SarflarPreset = 'oy' | 'otgan' | 'yil' | 'custom';

/** The first day a period may start on (the books start long after it). */
const EARLIEST_DAY = '1900-01-01';

export interface SarflarPeriod {
  from: string;
  to: string;
  preset: SarflarPreset;
}

/** Pure: the period a visit asks for. Garbage reads as the default, never a 500. */
export function sarflarPeriod(
  params: { davr?: string; from?: string; to?: string },
  now: Date = new Date(),
): SarflarPeriod {
  const today = tashkentDay(now);
  const monthStart = tashkentMonthStart(now);
  if (params.davr === 'otgan') {
    const lastOfPrevious = addDays(monthStart, -1);
    return { from: `${lastOfPrevious.slice(0, 7)}-01`, to: lastOfPrevious, preset: 'otgan' };
  }
  if (params.davr === 'yil') return { from: `${today.slice(0, 4)}-01-01`, to: today, preset: 'yil' };
  // A real day inside the books' era or nothing (§8.3): a day in year 3 made
  // the comparison window run before year 0, which postgres refuses.
  const sane = (value: string | undefined) => {
    const day = calendarDay(value);
    return day && day >= EARLIEST_DAY ? day : undefined;
  };
  const from = sane(params.from);
  const to = sane(params.to);
  if (from || to) return { ...resolvePeriod({ from, to }, now), preset: 'custom' };
  return { from: monthStart, to: today, preset: 'oy' };
}

// ---------------------------------------------------------------------------
// The three CASEs.
// ---------------------------------------------------------------------------

/** Where a cost went (§1.3a). The truck stamp FIRST, so a grid cell is a truck's money. */
export const SPEND_KINDS = ['batch', 'receipt', 'crate', 'pickup'] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

/** `spendKind` over an unaliased `cost_entries` row. */
export function spendKindSql(): SQL {
  return sql`(CASE WHEN cost_entries.batch_id IS NOT NULL THEN 'batch'
                   WHEN cost_entries.scope = 'receipt' THEN 'receipt'
                   WHEN cost_entries.scope = 'crate' THEN 'crate'
                   ELSE 'pickup' END)`;
}

/**
 * Who paid (§1.4 «Kim to'ladi», §8.3), one ordered CASE for each book. A
 * reader without staff sight has no «o'z puli» branch: a colleague's own
 * pocket reads as an ordinary counterparty debt (`seesStaff` REQUIRED — an
 * optional one fails open).
 */
export const COST_PAYERS = ['kassa', 'own', 'firm', 'queue', 'history'] as const;
export const EXPENSE_PAYERS = ['kassa', 'own', 'firm', 'book', 'noKassa'] as const;
export const PAYERS = ['kassa', 'own', 'firm', 'book', 'queue', 'history', 'noKassa'] as const;
export type SpendPayer = (typeof PAYERS)[number];

/** Over an unaliased `cost_entries` joined to unaliased `partners`/`partner_types`. */
export function costPayerSql(opts: { seesStaff: boolean; since: string }): SQL {
  const own = opts.seesStaff
    ? sql`WHEN cost_entries.partner_id IS NOT NULL AND ${staffPartnerSql()} THEN 'own'`
    : sql``;
  return sql`(CASE WHEN cost_entries.account_id IS NOT NULL THEN 'kassa'
                   ${own}
                   WHEN cost_entries.partner_id IS NOT NULL THEN 'firm'
                   WHEN ${unplacedCostSql(opts.since)} THEN 'queue'
                   ELSE 'history' END)`;
}

/** Over `expenses e` / `expense_categories c` joined to unaliased `partners`/`partner_types`. */
export function expensePayerSql(opts: { seesStaff: boolean }): SQL {
  const own = opts.seesStaff ? sql`WHEN e.partner_id IS NOT NULL AND ${staffPartnerSql()} THEN 'own'` : sql``;
  return sql`(CASE WHEN e.account_id IS NOT NULL THEN 'kassa'
                   ${own}
                   WHEN e.partner_id IS NOT NULL THEN 'firm'
                   WHEN NOT c.cash THEN 'book'
                   ELSE 'noKassa' END)`;
}

/**
 * The money of the period as one row set — both books, the three CASEs, the
 * place of every row (§1.4 «Sklad bo'yicha»): a prixod cost at its receiving
 * warehouse, a factory truck at its destination, a yashik at the warehouse it
 * was PACKED in (its `crate_packed` movement — unloading rewrites
 * `crates.warehouse_id`), an overhead at its own warehouse, and truck money
 * at none (Q3: a direction is not a fact about money).
 */
export function spendRowsSql(from: string, to: string, opts: { seesStaff: boolean; since: string }): SQL {
  return sql`
    SELECT 'cost'::text AS book, cost_entries.id, cost_entries.cost_date AS day, cost_entries.created_at,
           cost_entries.cost_type_id AS type_id, ct.name AS type_name,
           cost_entries.amount, cost_entries.currency, cost_entries.amount_usd AS usd,
           ${spendKindSql()} AS kind,
           cost_entries.batch_id, cost_entries.receipt_id, cost_entries.crate_id, cost_entries.pickup_id,
           (CASE WHEN cost_entries.batch_id IS NOT NULL THEN NULL
                 WHEN cost_entries.scope = 'receipt' THEN r.warehouse_id
                 WHEN cost_entries.scope = 'pickup' THEN pk.dest_warehouse_id
                 WHEN cost_entries.scope = 'crate' THEN cp.wh END) AS wh_id,
           cost_entries.account_id, cost_entries.partner_id, cost_entries.merged_expense_id,
           ${costPayerSql(opts)} AS payer,
           cost_entries.entered_by AS author
      FROM cost_entries
      JOIN cost_types ct ON ct.id = cost_entries.cost_type_id
      LEFT JOIN receipts r ON r.id = cost_entries.receipt_id
      LEFT JOIN pickups pk ON pk.id = cost_entries.pickup_id
      LEFT JOIN LATERAL (
        SELECT bm.to_warehouse_id AS wh FROM box_movements bm
         WHERE bm.ref_type = 'crate' AND bm.ref_id = cost_entries.crate_id AND bm.cause = 'crate_packed'
         ORDER BY bm.created_at LIMIT 1) cp ON cost_entries.scope = 'crate'
      LEFT JOIN partners ON partners.id = cost_entries.partner_id
      LEFT JOIN partner_types ON partner_types.id = partners.type_id
     WHERE cost_entries.voided_at IS NULL
       AND cost_entries.cost_date >= ${from}::date AND cost_entries.cost_date <= ${to}::date
    UNION ALL
    SELECT 'expense'::text, e.id, e.expense_date, e.created_at,
           e.category_id, c.name,
           e.amount, e.currency, e.amount_usd,
           'expense'::text,
           NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
           e.warehouse_id,
           e.account_id, e.partner_id, NULL::uuid,
           ${expensePayerSql(opts)},
           e.created_by
      FROM expenses e
      JOIN expense_categories c ON c.id = e.category_id
      LEFT JOIN partners ON partners.id = e.partner_id
      LEFT JOIN partner_types ON partner_types.id = partners.type_id
     WHERE e.voided_at IS NULL
       AND e.expense_date >= ${from}::date AND e.expense_date <= ${to}::date`;
}

const num = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;

// ---------------------------------------------------------------------------
// The map's blocks.
// ---------------------------------------------------------------------------

export interface SpendSlice {
  key: string;
  label: string | null;
  usd: number;
  /** Rows with no dollar figure yet — printed as «kurs yo'q», never $0. */
  unconverted: number;
}

export interface SpendMap {
  /** Σ of the cost book = the P&L's direct total. */
  direct: number;
  /** Σ of the expense book = the P&L's opex total. */
  opex: number;
  kinds: SpendSlice[];
  /** Warehouse rows (prixod, zavod, yashik, overheads) and the unplaced row (`key` = ''). */
  warehouses: SpendSlice[];
  /** The truck money the warehouse block refers up to (Q3). */
  trucksUsd: number;
  trucksUnconverted: number;
  payers: SpendSlice[];
  /** The cost book by cost type, with each type's unconverted rows (the P&L's rows cannot say «kurs yo'q»). */
  types: SpendSlice[];
}

/** The blocks of one period. `seesStaff` REQUIRED: it decides the «o'z puli» bucket. */
export async function spendMap(
  _sight: CompanyMoneySight,
  from: string,
  to: string,
  opts: { seesStaff: boolean },
): Promise<SpendMap> {
  const since = await unplacedCostSince();
  const rows = spendRowsSql(from, to, { seesStaff: opts.seesStaff, since });
  const [byKind, byPlace, byPayer, byType] = await Promise.all([
    db.execute(sql`
      WITH s AS (${rows})
      SELECT book, kind, coalesce(sum(usd), 0) AS usd, count(*) FILTER (WHERE usd IS NULL)::int AS unconverted
        FROM s GROUP BY book, kind`) as unknown as Promise<{ book: string; kind: string; usd: string; unconverted: number }[]>,
    db.execute(sql`
      WITH s AS (${rows})
      SELECT s.wh_id, w.name, coalesce(sum(s.usd), 0) AS usd, count(*) FILTER (WHERE s.usd IS NULL)::int AS unconverted
        FROM s LEFT JOIN warehouses w ON w.id = s.wh_id
       WHERE s.kind <> 'batch'
       GROUP BY s.wh_id, w.name`) as unknown as Promise<
      { wh_id: string | null; name: string | null; usd: string; unconverted: number }[]
    >,
    db.execute(sql`
      WITH s AS (${rows})
      SELECT payer, coalesce(sum(usd), 0) AS usd, count(*) FILTER (WHERE usd IS NULL)::int AS unconverted
        FROM s GROUP BY payer`) as unknown as Promise<{ payer: string; usd: string; unconverted: number }[]>,
    db.execute(sql`
      WITH s AS (${rows})
      SELECT type_id, type_name, coalesce(sum(usd), 0) AS usd, count(*) FILTER (WHERE usd IS NULL)::int AS unconverted
        FROM s WHERE book = 'cost' GROUP BY type_id, type_name`) as unknown as Promise<
      { type_id: string; type_name: string; usd: string; unconverted: number }[]
    >,
  ]);
  const kindRows = [...byKind];
  const kinds = SPEND_KINDS.map((kind) => {
    const row = kindRows.find((r) => r.book === 'cost' && r.kind === kind);
    return { key: kind, label: null, usd: num(row?.usd), unconverted: row?.unconverted ?? 0 };
  });
  const expenseRow = kindRows.find((r) => r.book === 'expense');
  const direct = num(kinds.reduce((sum, k) => sum + k.usd, 0));
  const truck = kinds.find((k) => k.key === 'batch')!;
  const warehouses = [...byPlace]
    .map((r) => ({ key: r.wh_id ?? '', label: r.name, usd: num(r.usd), unconverted: r.unconverted }))
    .sort((a, b) => Number(a.key === '') - Number(b.key === '') || b.usd - a.usd || b.unconverted - a.unconverted);
  const payerRows = [...byPayer];
  const payers = PAYERS.map((payer) => {
    const row = payerRows.find((r) => r.payer === payer);
    return { key: payer, label: null, usd: num(row?.usd), unconverted: row?.unconverted ?? 0 };
  }).filter((slice) => slice.usd !== 0 || slice.unconverted > 0);
  return {
    direct,
    opex: num(expenseRow?.usd),
    kinds,
    warehouses,
    trucksUsd: truck.usd,
    trucksUnconverted: truck.unconverted,
    payers,
    types: [...byType]
      .map((r) => ({ key: r.type_id, label: r.type_name, usd: num(r.usd), unconverted: r.unconverted }))
      .sort((a, b) => b.usd - a.usd || b.unconverted - a.unconverted),
  };
}

/** The «Partiyalar» fold's row: a truck with money dated in the period. */
export interface SpendTruck {
  id: string;
  code: string;
  status: string;
  originWarehouseId: string;
  destWarehouseId: string;
  internal: boolean;
  tracked: boolean;
  periodUsd: number;
  periodUnconverted: number;
  allTimeUsd: number;
}

/**
 * Trucks with a live cost dated in the period, by the period's dollars, then
 * the unconverted count (a truck whose only bill has no rate is still
 * listed), then code. `limit` bounds the rows; `total` never is.
 */
export async function spendTrucks(
  _sight: CompanyMoneySight,
  from: string,
  to: string,
  page: { limit: number; offset: number },
): Promise<{ rows: SpendTruck[]; total: number }> {
  const inPeriod = sql`ce.cost_date >= ${from}::date AND ce.cost_date <= ${to}::date`;
  const rows = (await db.execute(sql`
    SELECT b.id, b.code, b.status, b.origin_warehouse_id, b.dest_warehouse_id, b.profit_tracked,
           ${internalLegSql('ow', 'dw')} AS internal,
           coalesce(sum(ce.amount_usd) FILTER (WHERE ${inPeriod}), 0) AS period_usd,
           (count(*) FILTER (WHERE ${inPeriod} AND ce.amount_usd IS NULL))::int AS period_unconverted,
           coalesce(sum(ce.amount_usd), 0) AS all_usd,
           count(*) OVER ()::int AS total
      FROM cost_entries ce
      JOIN batches b ON b.id = ce.batch_id
      JOIN warehouses ow ON ow.id = b.origin_warehouse_id
      JOIN warehouses dw ON dw.id = b.dest_warehouse_id
     WHERE ce.voided_at IS NULL
     GROUP BY b.id, ow.country, dw.country
    HAVING count(*) FILTER (WHERE ${inPeriod}) > 0
     ORDER BY period_usd DESC, period_unconverted DESC, b.code
     LIMIT ${page.limit} OFFSET ${page.offset}`)) as unknown as {
    id: string;
    code: string;
    status: string;
    origin_warehouse_id: string;
    dest_warehouse_id: string;
    profit_tracked: boolean;
    internal: boolean;
    period_usd: string;
    period_unconverted: number;
    all_usd: string;
    total: number;
  }[];
  const list = [...rows];
  return {
    total: list[0]?.total ?? (await spendTruckCount(from, to)),
    rows: list.map((r) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      originWarehouseId: r.origin_warehouse_id,
      destWarehouseId: r.dest_warehouse_id,
      internal: r.internal,
      tracked: r.profit_tracked,
      periodUsd: num(r.period_usd),
      periodUnconverted: r.period_unconverted,
      allTimeUsd: num(r.all_usd),
    })),
  };
}

/** The count alone, for a page past the last row (the window above has none to carry it). */
async function spendTruckCount(from: string, to: string): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT count(DISTINCT batch_id)::int AS n FROM cost_entries
     WHERE voided_at IS NULL AND batch_id IS NOT NULL
       AND cost_date >= ${from}::date AND cost_date <= ${to}::date`)) as unknown as { n: number }[];
  return [...rows][0]?.n ?? 0;
}

/** What the trucks drawn earned — `tripKind`'s «priced» question, for the chip alone. */
export async function truckRevenue(_sight: CompanyMoneySight, batchIds: string[]): Promise<Map<string, number>> {
  if (batchIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT batch_id, coalesce(sum(amount_usd), 0) AS usd FROM client_transactions
     WHERE type = 'charge' AND voided_at IS NULL
       AND batch_id IN (${sql.join(batchIds.map((id) => sql`${id}::uuid`), sql`, `)})
     GROUP BY batch_id`)) as unknown as { batch_id: string; usd: string }[];
  return new Map([...rows].map((r) => [r.batch_id, num(r.usd)]));
}

export type SpendTruckChip = 'internal' | 'continuation' | 'tracked' | null;

/**
 * The truck's kind, as a chip (Q3, his correction): an internal leg carries
 * cost only, a «davomi» carries none of its own price, and the money is
 * earned on the truck marked «partiya foydasi». Internal wins even on a
 * marked truck — it is tannarx there whatever the mark says; «davomi» is
 * `tripKind`'s own (unpriced AND every rider carried on).
 */
export function spendTruckChip(row: {
  internal: boolean;
  continuation: boolean;
  revenueUsd: number;
  tracked: boolean;
}): SpendTruckChip {
  if (row.internal) return 'internal';
  if (row.continuation && Math.abs(row.revenueUsd) <= 0.009) return 'continuation';
  if (row.tracked) return 'tracked';
  return null;
}

// ---------------------------------------------------------------------------
// The register (§1.6).
// ---------------------------------------------------------------------------

export interface SpendFilters {
  book: 'cost' | 'expense' | null;
  /** `t:<costTypeId>` or `c:<categoryId>`. */
  type: string | null;
  warehouseId: string | null;
  batchId: string | null;
  kind: SpendKind | 'expense' | null;
  payer: SpendPayer | null;
  mine: boolean;
}

const KIND_VALUES = new Set<string>([...SPEND_KINDS, 'expense']);
const PAYER_VALUES = new Set<string>(PAYERS);

/**
 * The register's filters out of the URL, every value validated (#514): an
 * id must be uuid-shaped, a kind or payer one of the closed lists — anything
 * else is dropped, never passed on. `?payer=own` is dropped for a reader
 * without staff sight, whose rows carry no such bucket.
 */
export function readSpendFilters(
  params: Record<string, string | undefined>,
  opts: { seesStaff: boolean; expenseRows: boolean },
): SpendFilters {
  const book = params.kitob === 'cost' || (params.kitob === 'expense' && opts.expenseRows) ? params.kitob : null;
  const rawType = params.turi ?? '';
  const type =
    (rawType.startsWith('t:') || (rawType.startsWith('c:') && opts.expenseRows)) && isUuidShaped(rawType.slice(2))
      ? rawType
      : null;
  const kind =
    params.joy && KIND_VALUES.has(params.joy) && (params.joy !== 'expense' || opts.expenseRows)
      ? (params.joy as SpendKind | 'expense')
      : null;
  const payer =
    params.payer && PAYER_VALUES.has(params.payer) && (params.payer !== 'own' || opts.seesStaff)
      ? (params.payer as SpendPayer)
      : null;
  return {
    book,
    type,
    warehouseId: isUuidShaped(params.sklad) ? params.sklad! : null,
    batchId: isUuidShaped(params.partiya) ? params.partiya! : null,
    kind,
    payer,
    mine: params.men === '1',
  };
}

export interface SpendRow {
  book: 'cost' | 'expense';
  id: string;
  day: string;
  typeName: string;
  amount: string;
  currency: string;
  usd: string | null;
  kind: SpendKind | 'expense';
  payer: SpendPayer;
  batchId: string | null;
  batchCode: string | null;
  batchOrigin: string | null;
  batchDest: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
  receiptWarehouseId: string | null;
  crateId: string | null;
  crateCode: string | null;
  crateWarehouseId: string | null;
  pickupId: string | null;
  pickupCode: string | null;
  warehouseName: string | null;
  accountId: string | null;
  accountName: string | null;
  mergedExpenseId: string | null;
  partnerName: string | null;
  partnerIsStaff: boolean;
  authorName: string | null;
}

export const REGISTER_PAGE = 100;
export const REGISTER_XLSX_CAP = 5000;

/**
 * The register's rows, newest first, and the uncapped count over the SAME
 * predicate. `expenseRows` REQUIRED (§8.4): individual expense rows — with an
 * employee's salary in them — are the expense book's readers' alone; every
 * other reader of the map gets cost rows and the category totals above.
 * `costs` REQUIRED like every reader that returns cost entries (#790).
 */
export async function spendRegister(
  _sight: CompanyMoneySight,
  period: { from: string; to: string },
  filters: SpendFilters,
  reader: { id: string; seesStaff: boolean; expenseRows: boolean; costs: CostSight },
  page: { limit: number; offset: number },
): Promise<{ rows: SpendRow[]; total: number }> {
  const since = await unplacedCostSince();
  const rows = spendRowsSql(period.from, period.to, { seesStaff: reader.seesStaff, since });
  const where: SQL[] = [];
  if (!reader.expenseRows) where.push(sql`s.book = 'cost'`);
  if (reader.costs.ownOnly) where.push(sql`(s.book <> 'cost' OR s.author = ${reader.costs.ownOnly}::uuid)`);
  if (filters.book) where.push(sql`s.book = ${filters.book}`);
  if (filters.type?.startsWith('t:')) where.push(sql`s.book = 'cost' AND s.type_id = ${filters.type.slice(2)}::uuid`);
  if (filters.type?.startsWith('c:')) where.push(sql`s.book = 'expense' AND s.type_id = ${filters.type.slice(2)}::uuid`);
  if (filters.warehouseId) where.push(sql`s.wh_id = ${filters.warehouseId}::uuid`);
  if (filters.batchId) where.push(sql`s.batch_id = ${filters.batchId}::uuid`);
  if (filters.kind) where.push(sql`s.kind = ${filters.kind}`);
  if (filters.payer) where.push(sql`s.payer = ${filters.payer}`);
  if (filters.mine) where.push(sql`s.author = ${reader.id}::uuid`);
  const condition = where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;
  const list = (await db.execute(sql`
    WITH s AS (${rows})
    SELECT s.book, s.id, s.day::text AS day, s.type_name, s.amount, s.currency, s.usd, s.kind, s.payer,
           s.batch_id, b.code AS batch_code, b.origin_warehouse_id AS batch_origin, b.dest_warehouse_id AS batch_dest,
           s.receipt_id, r.number AS receipt_number, r.warehouse_id AS receipt_warehouse_id,
           s.crate_id, cr.code AS crate_code, cr.warehouse_id AS crate_warehouse_id,
           s.pickup_id, pk.code AS pickup_code,
           w.name AS warehouse_name,
           s.account_id, ma.name AS account_name, s.merged_expense_id,
           partners.name AS partner_name,
           (partners.id IS NOT NULL AND ${staffPartnerSql()}) AS partner_is_staff,
           u.full_name AS author_name,
           count(*) OVER ()::int AS total
      FROM s
      LEFT JOIN batches b ON b.id = s.batch_id
      LEFT JOIN receipts r ON r.id = s.receipt_id
      LEFT JOIN crates cr ON cr.id = s.crate_id
      LEFT JOIN pickups pk ON pk.id = s.pickup_id
      LEFT JOIN warehouses w ON w.id = s.wh_id
      LEFT JOIN money_accounts ma ON ma.id = s.account_id
      LEFT JOIN partners ON partners.id = s.partner_id
      LEFT JOIN partner_types ON partner_types.id = partners.type_id
      LEFT JOIN users u ON u.id = s.author
     ${condition}
     ORDER BY s.day DESC, s.created_at DESC, s.id
     LIMIT ${page.limit} OFFSET ${page.offset}`)) as unknown as (Record<string, unknown> & { total: number })[];
  const out = [...list];
  let total = out[0]?.total ?? 0;
  if (out.length === 0 && page.offset > 0) {
    const counted = (await db.execute(sql`WITH s AS (${rows}) SELECT count(*)::int AS n FROM s ${condition}`)) as unknown as {
      n: number;
    }[];
    total = [...counted][0]?.n ?? 0;
  }
  return {
    total,
    rows: out.map((r) => ({
      book: r.book as SpendRow['book'],
      id: r.id as string,
      day: String(r.day).slice(0, 10),
      typeName: r.type_name as string,
      amount: String(r.amount),
      currency: r.currency as string,
      usd: r.usd === null ? null : String(r.usd),
      kind: r.kind as SpendRow['kind'],
      payer: r.payer as SpendPayer,
      batchId: (r.batch_id as string | null) ?? null,
      batchCode: (r.batch_code as string | null) ?? null,
      batchOrigin: (r.batch_origin as string | null) ?? null,
      batchDest: (r.batch_dest as string | null) ?? null,
      receiptId: (r.receipt_id as string | null) ?? null,
      receiptNumber: (r.receipt_number as string | null) ?? null,
      receiptWarehouseId: (r.receipt_warehouse_id as string | null) ?? null,
      crateId: (r.crate_id as string | null) ?? null,
      crateCode: (r.crate_code as string | null) ?? null,
      crateWarehouseId: (r.crate_warehouse_id as string | null) ?? null,
      pickupId: (r.pickup_id as string | null) ?? null,
      pickupCode: (r.pickup_code as string | null) ?? null,
      warehouseName: (r.warehouse_name as string | null) ?? null,
      accountId: (r.account_id as string | null) ?? null,
      accountName: (r.account_name as string | null) ?? null,
      mergedExpenseId: (r.merged_expense_id as string | null) ?? null,
      partnerName: (r.partner_name as string | null) ?? null,
      partnerIsStaff: Boolean(r.partner_is_staff),
      authorName: (r.author_name as string | null) ?? null,
    })),
  };
}

/**
 * The payer as a reader may see it: a reader without staff sight reads the
 * bucket word for every counterparty — that reader's rows already carry no
 * «o'z puli» bucket, so the name is the only place it could leak.
 */
export function payerNameFor(row: Pick<SpendRow, 'partnerName' | 'partnerIsStaff'>, seesStaff: boolean): string | null {
  // Without staff sight NO counterparty is named: if only a colleague's own
  // pocket fell back to the bucket word while firms kept their names, the
  // bare word would itself say «a colleague paid this» (the review's leak).
  if (!row.partnerName || !seesStaff) return null;
  return row.partnerName;
}

/**
 * Where a register row's target link goes, for THIS reader — or null for
 * plain text (§8.4: every link asks its destination's own door, one helper
 * for the map and /kiritish). `readableReceipts` is `receiptsReadableBy`
 * asked once for the page.
 */
export function costTargetHref(
  actor: ScopedActor & { permissions: ReadonlySet<string> },
  row: Pick<
    SpendRow,
    'book' | 'batchId' | 'batchOrigin' | 'batchDest' | 'receiptId' | 'crateId' | 'crateWarehouseId' | 'pickupId'
  >,
  readableReceipts: ReadonlySet<string>,
): string | null {
  if (row.book === 'expense') return mayPickTill(actor.permissions) ? '/accounting/expenses' : null;
  if (row.batchId && row.batchOrigin && row.batchDest) {
    if (!mayOpenBatchCard(actor, { originWarehouseId: row.batchOrigin, destWarehouseId: row.batchDest })) return null;
    return mayOpenBatchCosts(actor.permissions) ? batchTabHref(row.batchId, 'xarajat') : `/batches/${row.batchId}`;
  }
  if (row.receiptId) return readableReceipts.has(row.receiptId) ? `/receipts/${row.receiptId}` : null;
  if (row.crateId) {
    return actor.permissions.has('crates.manage') && row.crateWarehouseId && inScope(actor, row.crateWarehouseId)
      ? `/crates/${row.crateId}`
      : null;
  }
  if (row.pickupId) return `/zavod/${row.pickupId}`;
  return null;
}
