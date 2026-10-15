import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, costTypes, currencies } from '../../platform/db/schema';
import { isUuidShaped } from '../../platform/audit/fields';
import { mayAt, type ScopedActor } from '../../platform/rbac/scope';
import { tashkentDayStart } from '../../platform/time/tashkent';
import { batchTextMatchSql, codePrefixSql, formerCodeHitSql } from '../batches/former-codes';
import { batchLots } from '../batches/lots';
import { likeNeedle, prefixNeedle } from '../search/query';
import { listPartners } from '../partners/service';
import { maySeeStaffMoney } from '../partners/staff';
import { mayEnterBatchCostWhere } from './cost-door';
import { tillOptionsFor } from './till-props';
import { freightOffer } from './freight-offer';

/**
 * «Partiyaga xarajat» from the general money page (docs/SARFLAR.md §2) — a
 * LIGHT page: no report reader runs here, so picking a truck costs
 * milliseconds. The picker's rows AND its count are one predicate,
 * `mayEnterBatchCostWhere` (a cancelled truck is never offered, the origin
 * scope is today's rule), so «N tadan 20» never counts a truck it then hides.
 */

type Actor = ScopedActor & { permissions: ReadonlySet<string> };

/** Every status but the two that end a truck's money life on this screen. */
const OPEN = ['forming', 'loading', 'in_transit', 'arrived', 'unloaded'] as const;
export const ENTRY_LIMIT = 20;

export interface EntryTruck {
  id: string;
  code: string;
  status: string;
  origin: string;
  dest: string;
  /** A former name the search matched — the truck was renamed since (#1252). */
  formerHit: string | null;
  /** Live cost entries on it: zero draws «xarajatsiz». */
  entries: number;
  /** Its live dollars, null while some entry has no rate. */
  usd: number;
  unconverted: number;
}

/**
 * The picker. No `q`: the open trucks, newest first. A typed `q` also finds
 * a CLOSED truck (marked by the screen), by its code, plate, driver or a name
 * it wore before; ordered exact code → code prefix → a former name → newest.
 */
export async function trucksForCostEntry(actor: Actor, q: string): Promise<{ rows: EntryTruck[]; total: number }> {
  const text = q.trim().slice(0, 60);
  const door = mayEnterBatchCostWhere(actor);
  const like = likeNeedle(text);
  const match = text ? batchTextMatchSql(like) : sql`"batches"."status" IN (${sql.join(OPEN.map((s) => sql`${s}`), sql`, `)})`;
  const order = text
    ? sql`(lower("batches"."code") = lower(${text})) DESC,
          ${codePrefixSql(prefixNeedle(text))} DESC,
          (${formerCodeHitSql(like)} IS NOT NULL) DESC,
          "batches"."created_at" DESC`
    : sql`"batches"."created_at" DESC`;
  const rows = (await db.execute(sql`
    SELECT "batches"."id", "batches"."code", "batches"."status",
           ow.name AS origin, dw.name AS dest,
           ${text ? formerCodeHitSql(like) : sql`NULL::text`} AS former_hit,
           count(*) OVER ()::int AS total
      FROM "batches"
      JOIN warehouses ow ON ow.id = "batches"."origin_warehouse_id"
      JOIN warehouses dw ON dw.id = "batches"."dest_warehouse_id"
     WHERE ${door} AND ${match}
     ORDER BY ${order}
     LIMIT ${ENTRY_LIMIT}`)) as unknown as {
    id: string;
    code: string;
    status: string;
    origin: string;
    dest: string;
    former_hit: string | null;
    total: number;
  }[];
  const list = [...rows];
  const sums = await truckCostSums(list.map((r) => r.id));
  return {
    total: list[0]?.total ?? 0,
    rows: list.map((r) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      origin: r.origin,
      dest: r.dest,
      formerHit: r.former_hit,
      entries: sums.get(r.id)?.entries ?? 0,
      usd: sums.get(r.id)?.usd ?? 0,
      unconverted: sums.get(r.id)?.unconverted ?? 0,
    })),
  };
}

/** Each drawn truck's live Σ — ONE grouped query over the drawn ids (#432). */
async function truckCostSums(ids: string[]) {
  if (ids.length === 0) return new Map<string, { entries: number; usd: number; unconverted: number }>();
  const rows = (await db.execute(sql`
    SELECT batch_id, count(*)::int AS entries, coalesce(sum(amount_usd), 0) AS usd,
           (count(*) FILTER (WHERE amount_usd IS NULL))::int AS unconverted
      FROM cost_entries
     WHERE voided_at IS NULL AND batch_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
     GROUP BY batch_id`)) as unknown as { batch_id: string; entries: number; usd: string; unconverted: number }[];
  return new Map(
    [...rows].map((r) => [r.batch_id, { entries: r.entries, usd: Math.round(Number(r.usd) * 100) / 100, unconverted: r.unconverted }]),
  );
}

/**
 * `?p=<id>` re-asked (§8.5): a non-uuid is no choice at all; not found and
 * out of scope are the SAME answer (a hand-typed id learns nothing); a
 * cancelled truck is named as such and gets a sentence, never a form.
 */
export async function batchForCostEntry(
  actor: Actor,
  raw: string | undefined,
): Promise<
  | { kind: 'none' }
  | { kind: 'not_found' }
  | { kind: 'cancelled'; code: string }
  | { kind: 'ok'; batch: { id: string; code: string; status: string; originWarehouseId: string; destWarehouseId: string } }
> {
  if (!isUuidShaped(raw)) return { kind: 'none' };
  const [batch] = await db
    .select({
      id: batches.id,
      code: batches.code,
      status: batches.status,
      originWarehouseId: batches.originWarehouseId,
      destWarehouseId: batches.destWarehouseId,
    })
    .from(batches)
    .where(eq(batches.id, raw))
    .limit(1);
  if (!batch || !mayAt(actor, 'costs.enter_batch', batch.originWarehouseId)) return { kind: 'not_found' };
  if (batch.status === 'cancelled') return { kind: 'cancelled', code: batch.code };
  return { kind: 'ok', batch };
}

/** The cost types a panel offers, in ONE order (the grid's: created, then code). */
export async function activeCostTypes() {
  return db
    .select({ id: costTypes.id, code: costTypes.code, name: costTypes.name })
    .from(costTypes)
    .where(eq(costTypes.active, true))
    .orderBy(asc(costTypes.createdAt), asc(costTypes.code));
}

/**
 * Everything a truck's CostPanel offers, for this page AND the truck tab
 * (§2): `mayEnter` REQUIRED — when the reader may not add, no counterparty is
 * read and no kassa or client is offered at all. The clients are the truck's
 * RIDERS (`batchLots`), not the live pointer, which unloading empties.
 */
export async function costPanelOptions(
  actor: Actor & { id: string },
  batchId: string,
  opts: { mayEnter: boolean },
) {
  const [types, currencyRows] = await Promise.all([
    activeCostTypes(),
    db.select({ code: currencies.code }).from(currencies).where(eq(currencies.active, true)),
  ]);
  const currencyCodes = currencyRows.map((row) => row.code);
  if (!opts.mayEnter) return { types, currencies: currencyCodes, partners: [], tills: [], clients: [], freight: null };
  const [partnerRows, tills, lots, freight] = await Promise.all([
    listPartners({ includeStaff: maySeeStaffMoney(actor.permissions) }),
    tillOptionsFor(actor.permissions),
    batchLots(batchId),
    // The yo'lkira-tarifi offer (docs/YOLKIRA-TAQSIMOT.md §7.2): the truck's
    // column, its priced versions and the preview split over its riders.
    freightOffer(actor, batchId),
  ]);
  const clients = new Map<string, string>();
  for (const lot of lots) if (lot.clientId && lot.clientCode) clients.set(lot.clientId, lot.clientCode);
  return {
    types,
    currencies: currencyCodes,
    partners: partnerRows.map((row) => ({ id: row.id, name: row.name })),
    tills,
    clients: [...clients].map(([id, clientCode]) => ({ id, clientCode })).sort((a, b) => a.clientCode.localeCompare(b.clientCode)),
    freight,
  };
}

export interface TodayEntry {
  id: string;
  costDate: string;
  amount: string;
  currency: string;
  typeName: string;
  batchId: string | null;
  batchCode: string | null;
}

/**
 * «Bugun men kiritganlar» (§8.5): what THIS person typed today (Tashkent's
 * day, by the entry clock), live rows only — the second look before the next
 * bill, the way a paper book shows its last line.
 */
export async function myCostsToday(actorId: string, today: string): Promise<TodayEntry[]> {
  const rows = (await db.execute(sql`
    SELECT ce.id, ce.cost_date::text AS cost_date, ce.amount, ce.currency, ct.name AS type_name,
           ce.batch_id, b.code AS batch_code
      FROM cost_entries ce
      JOIN cost_types ct ON ct.id = ce.cost_type_id
      LEFT JOIN batches b ON b.id = ce.batch_id
     WHERE ce.entered_by = ${actorId}::uuid AND ce.voided_at IS NULL
       AND ce.created_at >= ${tashkentDayStart(today).toISOString()}::timestamptz
     ORDER BY ce.created_at DESC
     LIMIT 50`)) as unknown as {
    id: string;
    cost_date: string;
    amount: string;
    currency: string;
    type_name: string;
    batch_id: string | null;
    batch_code: string | null;
  }[];
  return [...rows].map((r) => ({
    id: r.id,
    costDate: String(r.cost_date).slice(0, 10),
    amount: String(r.amount),
    currency: r.currency,
    typeName: r.type_name,
    batchId: r.batch_id,
    batchCode: r.batch_code,
  }));
}
