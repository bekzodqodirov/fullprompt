import { sql, type SQL } from 'drizzle-orm';
import type { db } from '../../platform/db/client';
import { getSetting } from '../../platform/settings/service';
import { parseDayOrInstant, tashkentDayStart } from '../../platform/time/tashkent';
import { FOUND_BACK_CAUSES, RIDE_CAUSES, leftBehindSql, rideMovementSql } from '../batches/riders';
import { sameCountryLegSql } from '../batches/internal';
import { ISSUABLE_STATUSES } from '../issue/parties';

/**
 * «Narxi yozilmagan yuk» — the ONE rule for which cargo has no price (owner,
 * 2026-09-25: Q3b «ruxsat berilmasa olib ketolmasin, taqiq tursin», Q4c the
 * list covers all history, Q2 the found-back carton, Q1 the local leg; answer
 * 7 of the dashboard round for the prixod split over two trucks).
 *
 * Four readers ask it and must never answer differently (#513): the handover
 * gate (`issueBoxes`), the accountant's list (`/finance/narxsiz`), the
 * dashboard's «yetib kelgan, narx yozilmagan» (`unbilledArrived`), and the
 * Balans line «narxi hali yozilmagan yukka sarflangan» (U03), which sums the
 * cost of exactly the cartons this fragment calls uncovered. Two screens one
 * tap apart that disagree about which cargo is unpriced are worse than either
 * alone — the operator refused at the counter looks for the row, the
 * accountant clears the row and expects the counter to open.
 *
 * The grain is the CARTON. A carton k of a confirmed prixod R with a client C
 * is COVERED when a live charge of C satisfies clause 1 or clause 2, and —
 * whenever that charge names a truck — passes clauses 3 and 4:
 *
 *   1. Deal: the charge is on R's deal.
 *   2. Truck: the charge is on a truck some carton of R RODE, by the money
 *      rule (`rideMovementSql`: a departure or an unscanned landing that was
 *      not later found back at the truck's origin). The live pointer never
 *      counts — a planned carton can still be short-loaded (Q21), so its
 *      truck's price may yet move. Any truck of the prixod covers the whole
 *      prixod (answer 7).
 *   3. Road (Q1): a truck charge applies only when the truck CROSSES a border
 *      or R was received in Uzbekistan. Every Tashkent-bound prixod rides
 *      Andijan → Tashkent, and a price on that local leg would otherwise clear
 *      the unpriced China truck off the list and open the gate. Asked through
 *      EITHER clause, because R3a stamps the deal onto a truck charge and the
 *      deal clause would let the local leg back in.
 *   4. Found back (Q2): a charge on truck T does not cover a carton that
 *      departed on T and was found back at T's origin (`leftBehindSql`) —
 *      «yo'lkira narxi yozilmasin, B partiyada yozilsin» — even when its
 *      sibling cartons rode T. Also through either clause.
 *
 * A charge typed on the card with neither a truck nor a deal covers NOTHING:
 * it names no cargo, and letting it cover would let an old storage fee open
 * the door for months of new cargo. Its money is reported beside the list
 * per CLIENT (`unattachedChargesByClient`), never per prixod.
 *
 * Nothing here is stored. Coverage, the landing, the «price sits on another
 * truck» tag and the gate are derived from `box_movements`, the box's live
 * pointer and `client_transactions` every time they are asked.
 *
 * Every reader takes the executor as a REQUIRED first argument and never
 * touches the module pool: the gate runs these on its own transaction's
 * connection (#714 — `tests/unit/tx-pool.test.ts`), the screens pass `db`.
 * Raw rows carry timestamps as TEXT (#923) and every one is mapped through
 * `new Date(…)` — `gatedAt` throws on anything else, because a string
 * compared with a Date is NaN, false, and a silently open gate.
 */

export type Exec = Pick<typeof db, 'execute'>;

/**
 * Which cartons a reader asks about. REQUIRED keys throughout: an optional
 * scope fails OPEN (the whole company where one client was meant).
 * `ownerId` is round 91's `moneyOwnerFilter(actor)` and must be passed
 * explicitly — undefined for every client, a seller's id for their book.
 */
export type UnpricedScope =
  | { kind: 'boxes'; boxIds: string[] }
  | { kind: 'client'; clientId: string }
  | { kind: 'clients'; clientIds: string[] }
  | { kind: 'receipts'; receiptIds: string[] }
  | {
      kind: 'company';
      warehouseIds: string[] | undefined;
      ownerId: string | undefined;
      /** `YYYY-MM-DD` (Tashkent): only cartons that landed on or after that day. */
      landedFrom: string | undefined;
    };

export interface UncoveredBox {
  boxId: string;
  receiptId: string;
  clientId: string;
  status: string;
  warehouseId: string | null;
  /** First movement INTO a UZ warehouse from elsewhere; null = never landed. */
  landedAt: Date | null;
  /** The first such movement one of OUR trucks made; null = a walk-in. */
  roadLandedAt: Date | null;
  /**
   * A live charge of the client sits on a truck this prixod touched and does
   * not cover this carton — «narx YW-001 da», the accountant's to move. Not
   * set by a truck the carton was found back from before that truck was
   * priced (Q2: that price is where it belongs).
   */
  elsewhere: boolean;
}

export interface UnpricedReceipt {
  receiptId: string;
  number: string | null;
  clientId: string;
  clientCode: string;
  clientName: string;
  dealId: string | null;
  dealCode: string | null;
  goods: string;
  /** Uncovered LANDED cartons of the prixod. */
  boxes: number;
  /** …of them already handed over — the money most at risk. */
  issuedBoxes: number;
  /** …of them still issuable and behind the ban (`gatedAt`). */
  gatedBoxes: number;
  kg: number;
  m3: number;
  firstLandedAt: Date;
  /** The trucks whose landing brought the listed cartons in — the pricing door. */
  arrivalTrucks: { batchId: string; code: string }[];
  /** Live charges of the client on trucks this prixod touched that cover none of the listed cartons. */
  elsewhere: { batchId: string; code: string; usd: number }[];
  /** No listed carton ever landed by road — received straight into a UZ warehouse. */
  walkIn: boolean;
}

export type GateSince = { state: 'off' } | { state: 'on'; since: Date } | { state: 'invalid' };

/** The ban switched off — for a reader that never prints the gated count. */
export const GATE_OFF: GateSince = { state: 'off' };

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const FOUND_BACK = sql.raw(`(${FOUND_BACK_CAUSES.map((cause) => `'${cause}'`).join(', ')})`);

/** The statuses a carton can be in and still be cargo to bill. */
const CARGO_STATUSES = sql`('in_stock', 'planned', 'loading', 'in_transit', 'ready_for_pickup', 'issued')`;

/**
 * The WHERE over `b` (boxes), `rl` (its lot), `r` (its receipt) and `lm`
 * (its landing movement) for a scope. Exported so U03's Balans line can ask
 * the fragment about the same cartons without writing a scope by hand.
 */
export function unpricedScopeSql(scope: UnpricedScope): SQL {
  switch (scope.kind) {
    case 'boxes':
      return scope.boxIds.length ? sql`b.id IN (${idList(scope.boxIds)})` : sql`false`;
    case 'client':
      return sql`r.client_id = ${scope.clientId}::uuid`;
    case 'clients':
      return scope.clientIds.length ? sql`r.client_id IN (${idList(scope.clientIds)})` : sql`false`;
    case 'receipts':
      return scope.receiptIds.length ? sql`rl.receipt_id IN (${idList(scope.receiptIds)})` : sql`false`;
    case 'company': {
      const owner =
        scope.ownerId !== undefined
          ? sql`AND r.client_id IN (SELECT oc.id FROM clients oc WHERE oc.sales_manager_id = ${scope.ownerId}::uuid)`
          : sql``;
      // Today's dashboard clause, unchanged: cargo standing here now, or
      // handed over here.
      const wh = scope.warehouseIds?.length
        ? sql`AND (b.current_warehouse_id IN (${idList(scope.warehouseIds)}) OR (b.status = 'issued' AND lm.to_warehouse_id IN (${idList(scope.warehouseIds)})))`
        : sql``;
      return sql`true ${owner} ${wh}`;
    }
  }
}

/**
 * The five CTEs every reader continues from: `u_box` (the cartons asked
 * about, with their landing), `u_rcpt`, `u_charge` (every live charge of
 * those clients — the only money that can cover), `u_touch` (per prixod and
 * CHARGED truck: did a carton touch it, did one ride it) and `u_cov` (per
 * carton: `covered`, and `elsewhere_tx` — the ids of the client's live truck
 * charges that sit on a truck the prixod touched and do not cover this
 * carton). Written as `WITH ${uncoveredCtes(…)}`; «uncovered» is
 * `u_cov WHERE NOT covered`.
 *
 * `landedOnly` = only cartons that have landed in Uzbekistan (the gate, the
 * list); false keeps cargo still in China (the client card's trip chip, the
 * Balans line — money spent carrying cargo that has no price yet counts
 * before it arrives).
 *
 * Cost is bounded by the CHARGED trucks: `u_touch` is driven from the
 * client's own charges through `box_movements_ref_idx`, so a nearly empty
 * ledger costs nothing and no reader enumerates the riders of every truck;
 * the found-back probe runs only on ride rows (the CASE), and the leftover
 * probe only for a charge that already covers by clause 1 or 2.
 */
export function uncoveredCtes(boxScope: SQL, opts: { landedOnly: boolean }): SQL {
  return sql`
    u_box AS (
      SELECT b.id AS box_id, b.status, b.current_warehouse_id, rl.receipt_id, r.client_id, r.deal_id,
             (upper(trim(rw.country)) = 'UZ') AS received_in_uz,
             rl.total_volume_m3 / rl.box_count AS m3, rl.total_weight_kg / rl.box_count AS kg,
             min(lm.created_at) AS landed_at,
             min(lm.created_at) FILTER (WHERE lm.cause <> 'receipt') AS road_landed_at,
             (array_agg(lm.ref_id ORDER BY lm.created_at, lm.id)
                FILTER (WHERE lm.ref_type = 'batch' AND lm.cause <> 'receipt'))[1] AS arrival_batch_id
        FROM boxes b
        JOIN receipt_lots rl ON rl.id = b.lot_id
        JOIN receipts r ON r.id = rl.receipt_id AND r.status = 'confirmed' AND r.client_id IS NOT NULL
        JOIN warehouses rw ON rw.id = r.warehouse_id
        ${opts.landedOnly ? sql`JOIN` : sql`LEFT JOIN`} (box_movements lm
             JOIN warehouses lw ON lw.id = lm.to_warehouse_id AND upper(trim(lw.country)) = 'UZ')
          ON lm.box_id = b.id
         AND lm.from_warehouse_id IS DISTINCT FROM lm.to_warehouse_id
         AND lm.to_status <> 'in_transit'
         AND lm.cause <> 'found_at_origin'
       WHERE b.status IN ${CARGO_STATUSES}
         AND (${boxScope})
       GROUP BY b.id, b.status, b.current_warehouse_id, rl.receipt_id, r.client_id, r.deal_id,
                rw.country, rl.total_volume_m3, rl.total_weight_kg, rl.box_count
    ),
    u_rcpt AS (SELECT DISTINCT receipt_id, client_id FROM u_box),
    u_charge AS (
      SELECT ct.id, ct.client_id, ct.batch_id, ct.deal_id, ct.amount_usd, ct.created_at,
             -- An empty country is an unknown border, and an unknown border
             -- is treated as crossed (batches/internal.ts's own rule).
             CASE WHEN ct.batch_id IS NULL THEN NULL
                  ELSE coalesce(NOT ${sameCountryLegSql('co', 'cd')}, true) END AS crosses
        FROM client_transactions ct
        LEFT JOIN batches cb ON cb.id = ct.batch_id
        LEFT JOIN warehouses co ON co.id = cb.origin_warehouse_id
        LEFT JOIN warehouses cd ON cd.id = cb.dest_warehouse_id
       WHERE ct.type = 'charge' AND ct.voided_at IS NULL
         AND ct.client_id IN (SELECT client_id FROM u_rcpt)
    ),
    u_ctruck AS (SELECT DISTINCT client_id, batch_id FROM u_charge WHERE batch_id IS NOT NULL),
    u_touch AS (
      SELECT t.receipt_id, t.batch_id, bool_or(t.rode) AS rode
        FROM (
          SELECT ur.receipt_id, tm.ref_id AS batch_id,
                 -- The rider rule's own causes and its own probe (#513): a
                 -- departure, or an unscanned landing (U25), not found back.
                 -- The CASE runs the probe only on a ride row.
                 CASE WHEN tm.cause IN ${RIDE_CAUSES}
                      THEN ${rideMovementSql('tm')} ELSE false END AS rode
            FROM u_ctruck ut
            JOIN box_movements tm ON tm.ref_type = 'batch' AND tm.ref_id = ut.batch_id
            JOIN boxes tb ON tb.id = tm.box_id AND tb.status <> 'void'
            JOIN receipt_lots tl ON tl.id = tb.lot_id
            JOIN u_rcpt ur ON ur.receipt_id = tl.receipt_id AND ur.client_id = ut.client_id
          UNION ALL
          -- Planned or loading on a charged truck: a TOUCH, never a ride.
          SELECT ur.receipt_id, tb.current_batch_id, false
            FROM u_ctruck ut
            JOIN boxes tb ON tb.current_batch_id = ut.batch_id AND tb.status <> 'void'
            JOIN receipt_lots tl ON tl.id = tb.lot_id
            JOIN u_rcpt ur ON ur.receipt_id = tl.receipt_id AND ur.client_id = ut.client_id
        ) t
       GROUP BY t.receipt_id, t.batch_id
    ),
    u_cov AS (
      SELECT ub.*,
             EXISTS (
               SELECT 1 FROM u_charge uc
                WHERE uc.client_id = ub.client_id
                  AND CASE
                        WHEN NOT (
                          (ub.deal_id IS NOT NULL AND uc.deal_id = ub.deal_id)
                          OR EXISTS (SELECT 1 FROM u_touch ct
                                      WHERE ct.receipt_id = ub.receipt_id AND ct.batch_id = uc.batch_id AND ct.rode)
                        ) THEN false
                        WHEN uc.batch_id IS NULL THEN true
                        WHEN NOT (uc.crosses OR ub.received_in_uz) THEN false
                        ELSE NOT ${leftBehindSql(sql`uc.batch_id`, 'kb')}
                      END
             ) AS covered,
             -- The charges that sit on a truck this prixod touched and yet do
             -- not cover this carton — «narx YW-001 da» — with ONE exception:
             -- a carton found back at a truck's origin BEFORE that truck was
             -- priced. Its siblings rode, the price was typed seeing the truck
             -- without it, so that price is right where it is and this carton
             -- is priced on the truck it really rides (Q2); naming the price
             -- as «on another truck» would send the accountant to move money
             -- that belongs where it is. A void and re-entry after the find
             -- clears the tag for the same reason.
             ARRAY(
               SELECT uc.id FROM u_charge uc
                 JOIN u_touch et ON et.batch_id = uc.batch_id AND et.receipt_id = ub.receipt_id
                WHERE uc.client_id = ub.client_id
                  AND NOT (et.rode AND EXISTS (
                        SELECT 1 FROM box_movements fb
                          JOIN batches fbt ON fbt.id = uc.batch_id
                         WHERE fb.box_id = ub.box_id
                           AND fb.cause IN ${FOUND_BACK}
                           AND fb.to_warehouse_id = fbt.origin_warehouse_id
                           AND fb.created_at < uc.created_at))
             ) AS elsewhere_tx
        FROM u_box ub
        JOIN boxes kb ON kb.id = ub.box_id
    )`;
}

type Ts = string | Date | null;
const toDate = (value: Ts): Date | null => (value === null ? null : new Date(value));

/** The uncovered cartons of a scope — the gate's and the counter's question. */
export async function uncoveredBoxesOn(
  exec: Exec,
  scope: UnpricedScope,
  opts: { landedOnly: boolean },
): Promise<UncoveredBox[]> {
  const rows = (await exec.execute(sql`
    WITH ${uncoveredCtes(unpricedScopeSql(scope), opts)}
    SELECT box_id, receipt_id, client_id, status, current_warehouse_id, landed_at, road_landed_at,
           cardinality(elsewhere_tx) > 0 AS elsewhere
      FROM u_cov
     WHERE NOT covered
  `)) as unknown as {
    box_id: string;
    receipt_id: string;
    client_id: string;
    status: string;
    current_warehouse_id: string | null;
    landed_at: Ts;
    road_landed_at: Ts;
    elsewhere: boolean;
  }[];
  return rows.map((row) => ({
    boxId: row.box_id,
    receiptId: row.receipt_id,
    clientId: row.client_id,
    status: row.status,
    warehouseId: row.current_warehouse_id,
    landedAt: toDate(row.landed_at),
    roadLandedAt: toDate(row.road_landed_at),
    elsewhere: Boolean(row.elsewhere),
  }));
}

/**
 * The list: every prixod with at least one uncovered, LANDED, non-void,
 * non-lost carton, all history (Q4 c). `gatedBoxes` counts the issuable
 * cartons behind the ban, decided by `gatedAt` against the gate passed in.
 */
export async function unpricedReceiptsOn(
  exec: Exec,
  scope: UnpricedScope,
  gate: GateSince,
): Promise<UnpricedReceipt[]> {
  const from =
    scope.kind === 'company' && scope.landedFrom
      ? sql`AND landed_at >= ${tashkentDayStart(scope.landedFrom).toISOString()}::timestamptz`
      : sql``;
  const issuable = sql.raw(`(${ISSUABLE_STATUSES.map((s) => `'${s}'`).join(', ')})`);
  const rows = (await exec.execute(sql`
    WITH ${uncoveredCtes(unpricedScopeSql(scope), { landedOnly: true })},
    u_list AS (SELECT * FROM u_cov WHERE NOT covered AND landed_at IS NOT NULL ${from})
    SELECT l.receipt_id, r.number, l.client_id, c.client_code, c.name AS client_name,
           r.deal_id, d.code AS deal_code,
           (SELECT string_agg(coalesce(nullif(gl.product_name_ru, ''), gl.product_name_zh), ', ' ORDER BY gl.seq)
              FROM receipt_lots gl WHERE gl.receipt_id = l.receipt_id) AS goods,
           count(*)::int AS boxes,
           count(*) FILTER (WHERE l.status = 'issued')::int AS issued_boxes,
           coalesce(sum(l.kg), 0) AS kg, coalesce(sum(l.m3), 0) AS m3,
           min(l.landed_at) AS first_landed_at,
           bool_and(l.road_landed_at IS NULL) AS walk_in,
           -- Per issuable carton, its road landing — counted against the
           -- gate by \`gatedAt\` in JS, the gate's own predicate.
           coalesce(array_agg(l.road_landed_at::text) FILTER (WHERE l.status IN ${issuable}), '{}') AS issuable_road,
           coalesce((SELECT json_agg(json_build_object('batchId', ab.id, 'code', ab.code) ORDER BY ab.code)
                       FROM batches ab
                      WHERE ab.id IN (SELECT la.arrival_batch_id FROM u_list la WHERE la.receipt_id = l.receipt_id)), '[]') AS arrival_trucks,
           coalesce((SELECT json_agg(json_build_object('batchId', x.batch_id, 'code', x.code, 'usd', x.usd) ORDER BY x.code)
                       FROM (SELECT uc.batch_id, eb.code, sum(uc.amount_usd) AS usd
                               FROM u_charge uc
                               JOIN batches eb ON eb.id = uc.batch_id
                              WHERE uc.id IN (SELECT unnest(le.elsewhere_tx) FROM u_list le
                                               WHERE le.receipt_id = l.receipt_id)
                              GROUP BY uc.batch_id, eb.code) x), '[]') AS elsewhere
      FROM u_list l
      JOIN receipts r ON r.id = l.receipt_id
      JOIN clients c ON c.id = l.client_id
      LEFT JOIN deals d ON d.id = r.deal_id
     GROUP BY l.receipt_id, r.number, l.client_id, c.client_code, c.name, r.deal_id, d.code
  `)) as unknown as {
    receipt_id: string;
    number: string | null;
    client_id: string;
    client_code: string;
    client_name: string;
    deal_id: string | null;
    deal_code: string | null;
    goods: string | null;
    boxes: number;
    issued_boxes: number;
    kg: string;
    m3: string;
    first_landed_at: Ts;
    walk_in: boolean;
    issuable_road: (string | null)[];
    arrival_trucks: { batchId: string; code: string }[];
    elsewhere: { batchId: string; code: string; usd: string | number }[];
  }[];
  return rows.map((row) => ({
    receiptId: row.receipt_id,
    number: row.number,
    clientId: row.client_id,
    clientCode: row.client_code,
    clientName: row.client_name,
    dealId: row.deal_id,
    dealCode: row.deal_code,
    goods: row.goods ?? '',
    boxes: Number(row.boxes),
    issuedBoxes: Number(row.issued_boxes),
    gatedBoxes: row.issuable_road.filter((at) => gatedAt(toDate(at), gate)).length,
    kg: Math.round(Number(row.kg) * 10) / 10,
    m3: Math.round(Number(row.m3) * 1000) / 1000,
    firstLandedAt: new Date(row.first_landed_at!),
    arrivalTrucks: row.arrival_trucks,
    elsewhere: row.elsewhere.map((e) => ({ batchId: e.batchId, code: e.code, usd: Math.round(Number(e.usd) * 100) / 100 })),
    walkIn: Boolean(row.walk_in),
  }));
}

/**
 * Money already in each client's receivable that names no covered cargo —
 * per CLIENT, never per prixod, or one $50 card charge is counted once for
 * every unpriced prixod the client has (the money lens's defect 5).
 *
 * - `cardOnlyUsd`: live charges with neither a truck nor a deal, dated on or
 *   after the day (Tashkent) the client's OLDEST uncovered prixod was
 *   confirmed — an older card charge was for older cargo.
 * - `elsewhereUsd`: the distinct live truck charges (each counted once) that
 *   sit on a truck one of the client's uncovered prixods touched.
 *
 * U03's netting, stated here so it is not reinvented: WIP(client) =
 * max(0, Σ uncovered cost − cardOnlyUsd − elsewhereUsd). Each dollar in the
 * receivable retires at most one dollar of cost — an under-count, never a
 * double count.
 */
export async function unattachedChargesByClient(
  exec: Exec,
  clientIds: string[],
): Promise<Map<string, { cardOnlyUsd: number; elsewhereUsd: number }>> {
  const out = new Map<string, { cardOnlyUsd: number; elsewhereUsd: number }>();
  if (clientIds.length === 0) return out;
  const rows = (await exec.execute(sql`
    WITH ${uncoveredCtes(unpricedScopeSql({ kind: 'clients', clientIds }), { landedOnly: false })},
    u_open AS (
      SELECT uv.client_id, uv.receipt_id FROM u_cov uv WHERE NOT uv.covered GROUP BY uv.client_id, uv.receipt_id
    ),
    u_since AS (
      SELECT uo.client_id, min((ur.confirmed_at AT TIME ZONE 'Asia/Tashkent')::date) AS since
        FROM u_open uo JOIN receipts ur ON ur.id = uo.receipt_id
       GROUP BY uo.client_id
    )
    SELECT s.client_id,
           coalesce((SELECT sum(uc.amount_usd) FROM u_charge uc JOIN client_transactions cx ON cx.id = uc.id
                      WHERE uc.client_id = s.client_id AND uc.batch_id IS NULL AND uc.deal_id IS NULL
                        AND cx.tx_date >= s.since), 0) AS card_only,
           coalesce((SELECT sum(uc.amount_usd) FROM u_charge uc
                      WHERE uc.id IN (SELECT unnest(uv.elsewhere_tx) FROM u_cov uv
                                       WHERE uv.client_id = s.client_id AND NOT uv.covered)), 0) AS elsewhere
      FROM u_since s
  `)) as unknown as { client_id: string; card_only: string; elsewhere: string }[];
  for (const row of rows) {
    out.set(row.client_id, {
      cardOnlyUsd: Math.round(Number(row.card_only) * 100) / 100,
      elsewhereUsd: Math.round(Number(row.elsewhere) * 100) / 100,
    });
  }
  return out;
}

/** How many prixods have landed cargo with no price — the accountant's home row. */
export async function unpricedCount(exec: Exec, ownerId: string | undefined): Promise<number> {
  const [row] = (await exec.execute(sql`
    WITH ${uncoveredCtes(
      unpricedScopeSql({ kind: 'company', warehouseIds: undefined, ownerId, landedFrom: undefined }),
      { landedOnly: true },
    )}
    SELECT count(DISTINCT receipt_id)::int AS n FROM u_cov WHERE NOT covered AND landed_at IS NOT NULL
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}

/**
 * The setting `unpriced_gate_since`, read. '' switches the ban off; a day or
 * an instant switches it on from then; ANYTHING ELSE FAILS CLOSED — every
 * uncovered carton that landed by road is gated, and the screens say the
 * setting is broken. The save door refuses such a value in words
 * (`SETTING_VALIDATORS`), so only a hand edit of the database reaches it, and
 * a typo must not silently lift the owner's ban.
 */
export function parseGateSince(value: unknown): GateSince {
  if (typeof value !== 'string') return { state: 'invalid' };
  const parsed = parseDayOrInstant(value);
  if (parsed === 'empty') return { state: 'off' };
  if (parsed === null) return { state: 'invalid' };
  return { state: 'on', since: parsed };
}

/** The ban as configured — POOL, so read BEFORE any transaction opens (#714). */
export async function unpricedGate(): Promise<GateSince> {
  return parseGateSince(await getSetting('unpriced_gate_since'));
}

/**
 * Is a carton that landed by road at `roadLandedAt` behind the ban?
 *
 * A walk-in (null) never is: it rode none of our roads, so no truck price
 * can exist for it, and its deal is linked by a door the accountant does not
 * hold. The deploy's own moment is the line (0104): cargo standing in the
 * warehouses before it was never priced through the system by construction.
 */
export function gatedAt(roadLandedAt: Date | null, gate: GateSince): boolean {
  if (roadLandedAt === null) return false;
  if (!(roadLandedAt instanceof Date)) {
    throw new TypeError('gatedAt: roadLandedAt must be a Date (a raw row timestamp is TEXT, #923)');
  }
  if (gate.state === 'off') return false;
  if (gate.state === 'invalid') return true;
  return roadLandedAt.getTime() >= gate.since.getTime();
}
