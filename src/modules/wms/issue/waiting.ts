import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { warehouses } from '../../platform/db/schema';
import { seesAllClients } from '../../platform/clients/card-door';
import { getSetting } from '../../platform/settings/service';
import { roundKg, roundM3, shareOf, sumRounded } from '../../platform/telegram/format';
import { calendarDaysBetween, tashkentDay } from '../../platform/time/tashkent';
import { landedHereAtSql } from '../documents/arrivals';
import { gatedAt, uncoveredBoxesOn, type Exec, type GateSince } from '../finance/unpriced';
import { balancesForClients, debtBlocks } from '../finance/service';
import { ISSUABLE_STATUSES } from './parties';

/**
 * «Olib ketilmagan yuk» — cargo standing in a warehouse that hands cargo to
 * clients, waiting for its owner (the owner, 2026-09-28, answer 3a: «5 va 10
 * kundan keyin sotuvchi va ofisga ro'yxat, mijozga xabar yo'q»).
 *
 * One row per (client, warehouse) — a seller works by CODE, so one person's
 * three codes are three rows, and a pickup in Andijan says nothing about the
 * cartons in Tashkent. Built from the CARGO, like the handover screen's own
 * waiting list (`issue/parties.ts`), and asking the same question it does:
 * `ISSUABLE_STATUSES` in a warehouse whose `issues_to_clients` is ticked.
 * Unclaimed marking cargo has no client to ring and keeps its own list
 * (`unclaimedReport`); cargo still in China is not waiting for anybody.
 *
 * THE CLOCK is the landing (`landedHereAtSql` — the agent sheet's rule, with
 * its walk-in half): how long the OLDEST waiting carton has stood where it
 * stands, in Tashkent calendar days. Never the China receipt day, which is how
 * the svodka called a carton that landed yesterday a month old; and never the
 * last pickup, which is how a client taking one carton a week would keep 700
 * under five days for ever while the dashboard and the stock report printed a
 * different age for the same carton (the design review's #6). The pickup does
 * two other things: it marks the row «qoldiq» — cartons left behind at a
 * visit, which is also how the office finds the ghost carton recorded as
 * standing and long gone — and it moves the ALERT's clock (`clockFrom`): the
 * leftovers are announced again only once they have waited the warn line
 * since that visit (`announceLevel`), never the next morning.
 *
 * No money on the list. The two reasons the counter itself would refuse the
 * cargo are asked separately: «narxsiz» (`waitingPriceGate`) is a CARGO fact —
 * no amount, and the issue screen already tells a warehouse operator with no
 * money grant exactly which cartons have no price — so every reader of the row
 * gets it, on the screen and in Telegram alike; «qarz» (`waitingDebtors`) is a
 * money fact, shown only where the client's ledger would open.
 */

export interface UncollectedRow {
  clientId: string;
  clientCode: string;
  clientName: string;
  phones: string[];
  sellerId: string | null;
  sellerName: string | null;
  warehouseId: string;
  warehouseCode: string;
  /**
   * A customs warehouse (Andijan): the cargo may still be waiting for its
   * declaration, and a client cannot collect what is not cleared — the row
   * says so rather than calling it uncollected without a word (the review's
   * MISSING item; «rastamojka tugadi» is NULL on every truck today, so the
   * clock cannot wait for it).
   */
  customs: boolean;
  boxes: number;
  /** Per-carton SHARES of each lot (`shareOf`), summed as printed. */
  kg: number;
  m3: number;
  /** The goods of the lot that has waited longest. */
  goods: string;
  /** How many other lots stand in the same row. */
  moreLots: number;
  /** The oldest waiting carton's landing; null only for a carton with no landing movement. */
  landedFrom: Date | null;
  /** The client's last handover at THIS warehouse, if any. */
  lastPickupAt: Date | null;
  /** Tashkent calendar days since `landedFrom`; null with it. */
  days: number | null;
  /** Some of these cartons were already standing here when the client last came. */
  leftover: boolean;
  /**
   * The alert's re-arm clock: the later of the oldest landing and the last
   * pickup. An announcement older than it is spent; a newer one still stands.
   */
  clockFrom: Date | null;
}

export interface UncollectedQuery {
  /** The instant «today» is read at — pinned by every test (R5, #1063). */
  asOf: Date;
  /** Days from which a row is listed; 0 lists everything waiting. */
  minDays: number;
  /**
   * A seller's own book (`clients.sales_manager_id`), or undefined for every
   * client — `seesAllClients`'s answer, resolved by the caller. REQUIRED: an
   * optional scope fails open (#790).
   */
  ownerId: string | undefined;
  /** `warehouseScope`'s three answers as ids: undefined = every one, [] = none. */
  warehouseIds: string[] | undefined;
  /** The all-scope screen's seller chip — a user, or 'none' for nobody's clients. */
  sellerId?: string | 'none';
  /** One warehouse chip. */
  warehouseId?: string;
  /** The sweep's and the tests' seam: only these clients. */
  clientIds?: string[];
}

export interface UncollectedList {
  rows: UncollectedRow[];
  /** Over the WHOLE list, never a capped slice of it (round 74). */
  clients: number;
  boxes: number;
}

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const ISSUABLE_SQL = sql.raw(`(${ISSUABLE_STATUSES.map((s) => `'${s}'`).join(', ')})`);

export interface WaitThresholds {
  /** Level 1 — the seller's first message and the svodka. */
  warn: number;
  /** Level 2 — the alarm. Never below `warn`. */
  alarm: number;
}

/** 0 = not yet, 1 = the warn threshold, 2 = the alarm. */
export function waitLevel(days: number | null, t: WaitThresholds): 0 | 1 | 2 {
  if (days === null) return 0;
  if (days >= t.alarm) return 2;
  if (days >= t.warn) return 1;
  return 0;
}

/**
 * The level a row may be ANNOUNCED at this morning — its age's level, but only
 * once its alert clock (`clockFrom`: the landing, or the last visit that left
 * cartons behind) has been quiet for the warn line.
 *
 * A visit is proof somebody is in touch with the client, so it buys the
 * leftovers the same five days the landing gave the whole shipment. Without
 * that, the visit re-armed the claim and the age — counted from the landing,
 * already past the line — announced the leftovers the very next morning: a
 * client who takes a few cartons a day set the seller's Telegram off every
 * day, and the svodka listed them under «today» every day (reproduced: five
 * mornings, five messages). The age on every line stays the landing's; only
 * WHEN it may be said moves. For a row nobody has visited the clock is the
 * landing itself, so the first announcement comes exactly as before.
 */
export function announceLevel(
  row: Pick<UncollectedRow, 'days' | 'clockFrom'>,
  t: WaitThresholds,
  asOf: Date,
): 0 | 1 | 2 {
  if (!row.clockFrom) return 0;
  if (calendarDaysBetween(tashkentDay(row.clockFrom), tashkentDay(asOf)) < t.warn) return 0;
  return waitLevel(row.days, t);
}

/**
 * The two thresholds, read on the POOL and before any read that runs inside
 * `withoutJit`'s transaction (#714). A value somebody typed badly falls back
 * rather than switching the feature off in silence.
 */
export async function waitThresholds(): Promise<WaitThresholds> {
  const [warnRaw, alarmRaw] = await Promise.all([
    getSetting('uncollected_warn_days'),
    getSetting('uncollected_alarm_days'),
  ]);
  const whole = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 ? n : fallback;
  };
  const warn = whole(warnRaw, 5);
  return { warn, alarm: Math.max(whole(alarmRaw, 10), warn) };
}

/**
 * The list. Takes the executor as its FIRST argument and touches nothing else
 * — no settings, no actor, no pool: a company-wide caller runs it inside
 * `withoutJit`, which is a transaction on a pool connection, and anything in
 * here reaching back to the pool is #714's freeze with the fence blind to it
 * (the design review's #3; `uncollected-wire.test.ts` holds the body to it).
 *
 * ONE statement. The landing is computed once per waiting carton in a
 * MATERIALIZED CTE — the design review measured the inlined form on the
 * 18k-carton shaped copy evaluating the landing subplan twice — and the
 * pickups are one grouped read through `handovers_client_idx`. Lots are folded in JS so kilos and cubes are
 * per-carton SHARES (`shareOf`): a 700-carton lot with three left behind is
 * three cartons' worth, never the lot's total.
 */
export async function uncollectedCargo(exec: Exec, q: UncollectedQuery): Promise<UncollectedList> {
  const filters: SQL[] = [];
  if (q.ownerId !== undefined) {
    filters.push(sql`AND c.sales_manager_id = ${q.ownerId}::uuid`);
  } else if (q.sellerId === 'none') {
    filters.push(sql`AND c.sales_manager_id IS NULL`);
  } else if (q.sellerId) {
    filters.push(sql`AND c.sales_manager_id = ${q.sellerId}::uuid`);
  }
  if (q.warehouseIds !== undefined) {
    filters.push(q.warehouseIds.length ? sql`AND b.current_warehouse_id IN (${idList(q.warehouseIds)})` : sql`AND false`);
  }
  if (q.warehouseId) filters.push(sql`AND b.current_warehouse_id = ${q.warehouseId}::uuid`);
  if (q.clientIds !== undefined) {
    filters.push(q.clientIds.length ? sql`AND r.client_id IN (${idList(q.clientIds)})` : sql`AND false`);
  }

  const lots = (await exec.execute(sql`
    WITH w_box AS MATERIALIZED (
      SELECT b.lot_id, b.current_warehouse_id AS warehouse_id, r.client_id,
             ${landedHereAtSql('b')} AS landed_at
        FROM boxes b
        JOIN receipt_lots rl ON rl.id = b.lot_id
        JOIN receipts r ON r.id = rl.receipt_id
        JOIN clients c ON c.id = r.client_id
        JOIN warehouses w ON w.id = b.current_warehouse_id AND w.issues_to_clients
       WHERE b.status IN ${ISSUABLE_SQL}
         ${sql.join(filters, sql` `)}
    ),
    w_lot AS (
      SELECT client_id, warehouse_id, lot_id, count(*)::int AS n,
             min(landed_at) AS landed_from
        FROM w_box
       GROUP BY client_id, warehouse_id, lot_id
    ),
    w_pick AS (
      SELECT h.client_id, h.warehouse_id, max(h.created_at) AS last_pickup_at
        FROM handovers h
       WHERE h.kind = 'issued_to_client'
         AND (h.client_id, h.warehouse_id) IN (SELECT DISTINCT client_id, warehouse_id FROM w_box)
       GROUP BY h.client_id, h.warehouse_id
    )
    SELECT l.client_id, c.client_code, c.name AS client_name, c.phones,
           c.sales_manager_id, u.full_name AS seller_name,
           l.warehouse_id, w.code AS warehouse_code, w.type AS warehouse_type,
           l.n, rl.box_count, rl.total_weight_kg, rl.total_volume_m3,
           coalesce(nullif(rl.product_name_ru, ''), rl.product_name_zh) AS goods,
           l.landed_from::text AS landed_from,
           p.last_pickup_at::text AS last_pickup_at
      FROM w_lot l
      JOIN clients c ON c.id = l.client_id
      JOIN warehouses w ON w.id = l.warehouse_id
      JOIN receipt_lots rl ON rl.id = l.lot_id
      LEFT JOIN users u ON u.id = c.sales_manager_id
      LEFT JOIN w_pick p ON p.client_id = l.client_id AND p.warehouse_id = l.warehouse_id
     -- The first lot of a row is the one that has waited longest; a tie is
     -- broken by the prixod and the lot's own order, never by the planner (67b).
     ORDER BY l.client_id, l.warehouse_id, l.landed_from NULLS LAST, rl.receipt_id, rl.seq
  `)) as unknown as {
    client_id: string;
    client_code: string;
    client_name: string;
    phones: unknown;
    sales_manager_id: string | null;
    seller_name: string | null;
    warehouse_id: string;
    warehouse_code: string;
    warehouse_type: string;
    n: number;
    box_count: number;
    total_weight_kg: string | null;
    total_volume_m3: string | null;
    goods: string | null;
    landed_from: string | null;
    last_pickup_at: string | null;
  }[];

  const today = tashkentDay(q.asOf);
  const folded = new Map<string, { row: UncollectedRow; kg: number[]; m3: number[]; lots: number }>();
  for (const lot of lots) {
    const key = `${lot.client_id}|${lot.warehouse_id}`;
    let entry = folded.get(key);
    if (!entry) {
      entry = {
        row: {
          clientId: lot.client_id,
          clientCode: lot.client_code,
          clientName: lot.client_name,
          phones: Array.isArray(lot.phones)
            ? (lot.phones as unknown[]).filter((p): p is string => typeof p === 'string' && p.trim() !== '')
            : [],
          sellerId: lot.sales_manager_id,
          sellerName: lot.seller_name,
          warehouseId: lot.warehouse_id,
          warehouseCode: lot.warehouse_code,
          customs: lot.warehouse_type === 'customs',
          boxes: 0,
          kg: 0,
          m3: 0,
          goods: lot.goods ?? '',
          moreLots: 0,
          landedFrom: null,
          lastPickupAt: lot.last_pickup_at ? new Date(lot.last_pickup_at) : null,
          days: null,
          leftover: false,
          clockFrom: null,
        },
        kg: [],
        m3: [],
        lots: 0,
      };
      folded.set(key, entry);
    }
    const n = Number(lot.n);
    const of = Number(lot.box_count);
    entry.row.boxes += n;
    entry.lots += 1;
    entry.kg.push(shareOf(Number(lot.total_weight_kg ?? 0), n, of));
    entry.m3.push(shareOf(Number(lot.total_volume_m3 ?? 0), n, of));
    if (lot.landed_from) {
      const at = new Date(lot.landed_from);
      if (!entry.row.landedFrom || at < entry.row.landedFrom) entry.row.landedFrom = at;
    }
  }

  const rows: UncollectedRow[] = [];
  for (const { row, kg, m3, lots: lotCount } of folded.values()) {
    row.kg = sumRounded(kg, roundKg);
    row.m3 = sumRounded(m3, roundM3);
    row.moreLots = lotCount - 1;
    // The oldest landing's TASHKENT day — the earliest instant is on the
    // earliest day, so the day is read off the instant (R5's one home).
    row.days = row.landedFrom ? calendarDaysBetween(tashkentDay(row.landedFrom), today) : null;
    row.leftover = Boolean(row.lastPickupAt && row.landedFrom && row.lastPickupAt > row.landedFrom);
    row.clockFrom =
      row.landedFrom && row.lastPickupAt && row.lastPickupAt > row.landedFrom
        ? row.lastPickupAt
        : row.landedFrom;
    if (q.minDays > 0 && (row.days === null || row.days < q.minDays)) continue;
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      (b.days ?? -1) - (a.days ?? -1) ||
      b.boxes - a.boxes ||
      a.clientCode.localeCompare(b.clientCode) ||
      a.warehouseCode.localeCompare(b.warehouseCode),
  );
  return {
    rows,
    clients: new Set(rows.map((row) => row.clientId)).size,
    boxes: rows.reduce((sum, row) => sum + row.boxes, 0),
  };
}

/**
 * The home rows' number: how many CLIENTS have cargo past the warn threshold —
 * the same function the screen lists, so the row and the page it opens cannot
 * disagree (#513). Same executor contract as `uncollectedCargo`.
 */
export async function uncollectedCount(exec: Exec, q: UncollectedQuery): Promise<number> {
  return (await uncollectedCargo(exec, q)).clients;
}

/** `?daraja=` — level NAMES in the URL, never a setting's value (the review's minor). */
export const WAIT_TABS = ['qizil', 'sariq', 'hammasi'] as const;
export type WaitTab = (typeof WAIT_TABS)[number];

export interface UncollectedFilters {
  tab: WaitTab;
  /** Only when it names a warehouse the viewer may read. */
  warehouseId: string | null;
  /** Only for a viewer who sees every client; ignored for anybody else (#514). */
  sellerId: string | 'none' | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The screen's filters out of the URL — validated or dropped, never trusted
 * (#514): a hand-typed `sotuvchi` from a seller is ignored rather than
 * obeyed, and a warehouse the viewer cannot read is no filter at all.
 */
export function readUncollectedFilters(
  params: { daraja?: string | null; ombor?: string | null; sotuvchi?: string | null },
  opts: { seesAll: boolean; warehouseIds: readonly string[] },
): UncollectedFilters {
  const tab = (WAIT_TABS as readonly string[]).includes(params.daraja ?? '') ? (params.daraja as WaitTab) : 'sariq';
  const ombor = params.ombor ?? '';
  const warehouseId = UUID.test(ombor) && opts.warehouseIds.includes(ombor) ? ombor : null;
  const raw = params.sotuvchi ?? '';
  const sellerId = !opts.seesAll ? null : raw === 'none' ? 'none' : UUID.test(raw) ? raw : null;
  return { tab, warehouseId, sellerId };
}

/** The days a tab starts at. */
export function tabMinDays(tab: WaitTab, t: WaitThresholds): number {
  return tab === 'qizil' ? t.alarm : tab === 'sariq' ? t.warn : 0;
}

/** A tab's rows out of the whole list — the page reads every tab off one read. */
export function rowsInTab<R extends { days: number | null }>(rows: readonly R[], tab: WaitTab, t: WaitThresholds): R[] {
  const min = tabMinDays(tab, t);
  return min === 0 ? [...rows] : rows.filter((row) => row.days !== null && row.days >= min);
}

/** Who is reading — the fields the book's scope is decided by. */
export interface UncollectedViewer {
  id: string;
  permissions: { has(code: string): boolean };
  warehouseScoped: boolean;
  warehouseIds: string[];
}

export interface UncollectedScope {
  /** Reads every client (`seesAllClients`), so the seller chip is theirs to use. */
  seesAll: boolean;
  ownerId: string | undefined;
  /** `warehouseScope`'s three answers as ids. */
  warehouseIds: string[] | undefined;
}

/**
 * Whose waiting cargo this viewer reads: every client for whoever reads the
 * whole book, their own for a seller, always inside `warehouseScope`. The
 * page's answer — asked by the logist's home row as well, so the number on
 * the row and the list it opens are counted over ONE book (#513).
 */
export function uncollectedScope(viewer: UncollectedViewer): UncollectedScope {
  const seesAll = seesAllClients(viewer);
  return {
    seesAll,
    ownerId: seesAll ? undefined : viewer.id,
    warehouseIds: viewer.warehouseScoped ? viewer.warehouseIds : undefined,
  };
}

/** The page's read, from its scope and its (validated) filters — everything waiting; the tabs slice it. */
export function uncollectedPageQuery(scope: UncollectedScope, filters: UncollectedFilters, asOf: Date): UncollectedQuery {
  return {
    asOf,
    minDays: 0,
    ownerId: scope.ownerId,
    warehouseIds: scope.warehouseIds,
    sellerId: filters.sellerId ?? undefined,
    warehouseId: filters.warehouseId ?? undefined,
  };
}

/**
 * Where a «my clients» home row points. The row counts the viewer's OWN
 * clients; the bare page opens on the viewer's BOOK — which for somebody who
 * reads every client is the whole company, and that is how the owner's own
 * accounts are set up («bir admin va sotuvchi», round 109): «3» on the row,
 * forty clients behind it. So for exactly those viewers the link names them
 * as the seller filter the page honours for them; for a seller the page is
 * already theirs and a `sotuvchi` would be ignored anyway (#514).
 */
export function myUncollectedHref(viewer: { id: string; seesAll: boolean }): string {
  const base = '/my-clients/olib-ketilmagan';
  return viewer.seesAll ? `${base}?sotuvchi=${viewer.id}` : base;
}

/** A row's key — one client at one warehouse. */
export function waitRowKey(row: { clientId: string; warehouseId: string }): string {
  return `${row.clientId}|${row.warehouseId}`;
}

/**
 * «Narxsiz» per row: how many of the row's cartons the counter would refuse
 * for want of a price — the 0104 gate's own question (`uncoveredBoxesOn` +
 * `gatedAt`), asked of the listed clients and never restated. Only issuable
 * cartons standing in the row's warehouse count. With the ban off nothing is
 * gated and nothing is read.
 *
 * Not a money answer (no sum, no price — the counter says the same to a
 * warehouse operator), so it needs no ledger door; it does read every carton
 * of the listed clients, so a company-wide caller runs it under `withoutJit`.
 */
export async function waitingPriceGate(
  exec: Exec,
  rows: readonly { clientId: string; warehouseId: string }[],
  gate: GateSince,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const clientIds = [...new Set(rows.map((row) => row.clientId))];
  if (clientIds.length === 0 || gate.state === 'off') return out;
  const wanted = new Set(rows.map(waitRowKey));
  const issuable = new Set<string>(ISSUABLE_STATUSES);
  for (const box of await uncoveredBoxesOn(exec, { kind: 'clients', clientIds }, { landedOnly: true })) {
    if (!box.warehouseId || !issuable.has(box.status)) continue;
    if (!gatedAt(box.roadLandedAt, gate)) continue;
    const key = waitRowKey({ clientId: box.clientId, warehouseId: box.warehouseId });
    if (wanted.has(key)) out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * «Qarz» per client: the handover gate's own debt (`blockingDebtUsd` over
 * `balancesForClients` — the balance less what a live deferral excuses), so
 * the tag says exactly what the counter will say. A money fact: the caller
 * shows it only where `mayOpenClientLedger` would.
 */
export async function waitingDebtors(clientIds: readonly string[]): Promise<Set<string>> {
  const balances = await balancesForClients([...clientIds]);
  const out = new Set<string>();
  for (const [clientId, money] of balances) {
    if (debtBlocks(money.balanceUsd, money.deferredUsd)) out.add(clientId);
  }
  return out;
}


/**
 * The warehouse chips: the issuing warehouses the viewer may read
 * (`warehouseScope`'s three answers — [] reads nothing, never everything).
 */
export async function issuingWarehouses(
  warehouseIds: string[] | undefined,
): Promise<{ id: string; code: string }[]> {
  if (warehouseIds && warehouseIds.length === 0) return [];
  return db
    .select({ id: warehouses.id, code: warehouses.code })
    .from(warehouses)
    .where(
      and(
        eq(warehouses.issuesToClients, true),
        eq(warehouses.active, true),
        warehouseIds ? inArray(warehouses.id, warehouseIds) : undefined,
      ),
    )
    .orderBy(asc(warehouses.code));
}
