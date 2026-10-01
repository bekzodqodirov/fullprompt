import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { getSetting } from '../../platform/settings/service';
import { logger } from '../../platform/logger';
import type { ScopedActor } from '../../platform/rbac/scope';
import { tashkentDay } from '../../platform/time/tashkent';
import type { BatchLot } from '../batches/lots';
import { batchEndsInScopeSql } from '../batches/card-door';
import { riderCtesSql, riderRowsSql } from '../batches/riders';
import { productKey, productKeySql, tnvedFor } from '../tnved/service';
import { offTruckPrices } from './off-truck';
import { PRICING_CHARGE_TYPES } from './pricing-view';

/**
 * «📈 Oldingi narx» — what we charged for the same goods on past trucks
 * (owner, 2026-09-29, answers 16a/17a/18a/28a).
 *
 * THE FIGURE IS A PAST TRUCK'S PRICE FOR A CLIENT, never a per-goods price.
 * The price is one number per client per truck (his 1c), so a row divides the
 * client's whole charge on that truck by the client's whole load aboard it —
 * the riders (`batches/riders.ts`, #440), kg and m³ as each box's share of its
 * lot, the base the truck's own bills are split over. When the client had
 * several goods on that truck the row says so («aralash: N xil tovar»): the
 * figure is then a blend, and printing it bare would be a claim about these
 * goods that nobody made.
 *
 * «THE SAME GOODS» is found the free way, in ONE read, as four indexed arms
 * UNIONed and never an OR (#152): the exact Chinese name (`productKeySql`,
 * which renders `receipt_lots_product_key_idx`'s own expression), the same
 * FULL 10-digit TNVED code through `tnved_assignments` (a 4-digit heading is
 * every shoe), and a close Russian or Chinese name by `similarity` — never
 * `word_similarity`, which is asymmetric and gives men's jackets women's
 * price (#934/#936). `%` beside each comparison is what reads the trigram
 * indexes; the threshold is set for the TRANSACTION from the same setting.
 * The model is asked only on a press, only when this finds nothing
 * (`similar-ai.ts`, 18a).
 *
 * WHICH TRUCKS: departed, within twelve Tashkent months, not this truck, one
 * the reader could open (`batchEndsInScopeSql`, the card door's twin), a
 * live charge of that client on it (PRICING_CHARGE_TYPES — this page's own
 * «price»), and the past lot must really have ridden it. A charge's dollars
 * are always known: `client_transactions.amount_usd` is NOT NULL and a charge
 * with no FX rate is refused at the door (`fx_missing`), so there is no
 * «unconverted» price to skip or count. Unclaimed cargo has no client and no
 * price.
 *
 * There is no tannarx and no margin in a row, so the accountant and the VED
 * read the same shape (Q19): a past truck price is the kind of figure the VED
 * types on this very page.
 */

export type PriceMatch = 'exact' | 'code' | 'name' | 'ai';

export interface PriceHistoryRow {
  batchId: string;
  batchCode: string;
  /** The Tashkent day the truck left — the row's date. */
  departedDay: string;
  clientId: string | null;
  clientCode: string | null;
  /** The needle's own client — his 16a: «avval shu mijozniki». */
  own: boolean;
  match: PriceMatch;
  /** Null at m³ = 0, never Infinity or $0. */
  usdPerM3: number | null;
  /** Null at kg = 0. */
  usdPerKg: number | null;
  kg: number;
  m3: number;
  kgPerM3: number | null;
  goodsKinds: number;
  /** The price's cargo left that truck after it was set (0104): a warning, not a figure to trust bare. */
  cargoMoved: 'no_cargo' | 'partial' | null;
  pastLotId: string;
}

export interface PriceHistory {
  rows: PriceHistoryRow[];
  /** The read timed out or failed: the page says so and keeps rendering. */
  failed: boolean;
}

/**
 * «aralash» (his 17a): the client had more than one kind of goods on that
 * truck, so the per-cube figure is a blend of them. One kind is not mixed,
 * and neither is «we do not know» (0).
 */
export function isMixed(row: { goodsKinds: number }): boolean {
  return row.goodsKinds > 1;
}

/** His 28a: the last five, within twelve months. */
export const PRICE_HISTORY_CAP = 5;

/**
 * Past lots probed per needle, own client first, then the strongest match,
 * then the newest — the read's bound, stated. Each probed lot costs a riders
 * walk over its cartons, and that walk is the whole bill: MEASURED on the
 * shaped copy (every one of its 4,026 lots carries one name, so every lot
 * matches every needle), a four-lot truck read in ~650 ms at 300 and ~270 ms
 * at 100. Five rows are wanted; a hundred candidates leave room for ninety-
 * five that were never priced.
 */
const MATCHED_LOTS_CAP = 100;

const STRENGTH: Record<Exclude<PriceMatch, 'ai'>, number> = { exact: 3, code: 2, name: 1 };
const MATCH_OF = (strength: number): PriceMatch => (strength >= 3 ? 'exact' : strength === 2 ? 'code' : 'name');

export interface PriceCandidate {
  batchId: string;
  batchCode: string;
  departedDay: string;
  clientId: string | null;
  clientCode: string | null;
  own: boolean;
  match: PriceMatch;
  chargeUsd: number;
  kg: number;
  m3: number;
  goodsKinds: number;
  cargoMoved: 'no_cargo' | 'partial' | null;
  pastLotId: string;
}

const matchRank = (m: PriceMatch) => (m === 'ai' ? 0 : STRENGTH[m]);

/**
 * The list as the icon prints it, pure: own client first (16a), then how
 * strong the match is, then the newest truck; five at most (28a). The
 * divisions refuse a zero — a truck whose rider m³ is 0 has no $/m³, it does
 * not have an infinite one.
 */
export function rankPriceHistory(rows: PriceCandidate[], cap = PRICE_HISTORY_CAP): PriceHistoryRow[] {
  return [...rows]
    .sort(
      (a, b) =>
        Number(b.own) - Number(a.own) ||
        matchRank(b.match) - matchRank(a.match) ||
        b.departedDay.localeCompare(a.departedDay) ||
        a.batchId.localeCompare(b.batchId),
    )
    .slice(0, cap)
    .map((row) => ({
      batchId: row.batchId,
      batchCode: row.batchCode,
      departedDay: row.departedDay,
      clientId: row.clientId,
      clientCode: row.clientCode,
      own: row.own,
      match: row.match,
      usdPerM3: row.m3 > 0 ? Math.round((row.chargeUsd / row.m3) * 100) / 100 : null,
      usdPerKg: row.kg > 0 ? Math.round((row.chargeUsd / row.kg) * 100) / 100 : null,
      kg: Math.round(row.kg * 10) / 10,
      m3: Math.round(row.m3 * 1000) / 1000,
      kgPerM3: row.m3 > 0 ? Math.round(row.kg / row.m3) : null,
      goodsKinds: row.goodsKinds,
      cargoMoved: row.cargoMoved,
      pastLotId: row.pastLotId,
    }));
}

/**
 * `months` back from today's Tashkent midnight, as an ISO instant (R5; #156:
 * a bound Date reaches postgres.js untyped). Shared with the AI's candidate
 * list, which must stand in the same window.
 */
export function windowStart(months: number): string {
  const [y, m, d] = tashkentDay().split('-').map(Number) as [number, number, number];
  const start = new Date(Date.UTC(y, m - 1 - months, d));
  // Tashkent midnight is 19:00 UTC the day before.
  return new Date(start.getTime() - 5 * 3_600_000).toISOString();
}

const uuidList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

const CHARGE_TYPES = sql.raw(`(${PRICING_CHARGE_TYPES.map((t) => `'${t}'`).join(', ')})`);

/**
 * WHICH TRUCK a past lot's price may come from, as one sentence over the
 * alias `b` — the free list, the AI's picks and the AI's candidate list all
 * say it through here (#513): a departed truck that is not this one, within
 * twelve Tashkent months, one the reader could open, carrying a live charge
 * of `client` (the SQL column naming the past lot's client). Were the model
 * offered a truck the free list would refuse, the reader would be shown a
 * name whose price the page then declines to print.
 */
export function pricedTruckSql(batchId: string, actor: ScopedActor, client: SQL): SQL {
  return sql`b.id <> ${batchId}::uuid
    AND b.departed_at IS NOT NULL
    AND b.departed_at >= ${windowStart(12)}::timestamptz
    AND ${batchEndsInScopeSql(actor, 'b')}
    AND EXISTS (
      SELECT 1 FROM client_transactions c
       WHERE c.client_id = ${client} AND c.batch_id = b.id
         AND c.type IN ${CHARGE_TYPES} AND c.voided_at IS NULL
    )`;
}

/**
 * Every statement a hint issues gets this ceiling (ms), set for the
 * transaction the reads share. A hint is not the page: the accountant prices
 * trucks on this screen, and a slow «what did we charge last time» must
 * become a sentence («hozir hisoblab bo'lmadi»), never a hung or broken tab.
 */
export const HINT_STATEMENT_MS = 1500;

type ReadTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * One short read transaction under the ceiling — every statement of the
 * hint, not only the first: the riders walk and `offTruckPrices` after the
 * match are where a wide truck spends its time. `threshold` sets the trigram
 * operator's cut-off for the same transaction.
 */
export async function underCeiling<T>(fn: (tx: ReadTx) => Promise<T>, threshold?: number): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      threshold === undefined
        ? sql`SELECT set_config('statement_timeout', ${String(HINT_STATEMENT_MS)}, true)`
        : sql`SELECT set_config('pg_trgm.similarity_threshold', ${String(threshold)}, true),
                     set_config('statement_timeout', ${String(HINT_STATEMENT_MS)}, true)`,
    );
    return fn(tx);
  });
}

type PairRow = {
  needle: number;
  client_id: string;
  client_code: string | null;
  batch_id: string;
  batch_code: string;
  departed_at: string;
  past_lot_id: string;
  strength: number;
  own: boolean;
};

/**
 * Query 2 and 3 for a set of (client, truck) pairs — the prices' ONE home,
 * used by the free list and by the AI's picks alike: the client's whole load
 * aboard as rider shares, how many kinds of goods it was, the pair's charges
 * in dollars, and whether the cargo left the truck after the price.
 *
 * Lot tarkibi (docs/LOT-TARKIBI.md §6): a composed lot counts as its LINES —
 * a line is its own kind (its id), so a lot of two lines makes the pair
 * mixed and its blended price is never served as a clean precedent. The
 * kinds have their own CTE and the lines stay OUT of `load`: `load` only
 * collects each pair's DISTINCT lot ids, and `kinds` joins the lines to
 * those — so the join multiplies lots, never cartons. A join in `load` would
 * multiply every carton row by the line count and double the kg the
 * per-cube figure divides by (#432's fan-out). The live lines, not a sent
 * truck's frozen copy: a precedent is about what the cargo WAS, and the
 * latest statement is the best knowledge.
 *
 * MEASURED on a migrated copy of gsr_card_perf (3,629 priced pairs; median
 * of five): the spec's first shape — a second CTE re-reading `members` —
 * made postgres materialise `members` and cost +30-60 % (300 pairs: 520 →
 * 820 ms). Reading the lot ids out of `load` instead is the old statement's
 * cost or less (300 pairs: 520 → 500 ms), and answers the same kg, m³ and
 * kinds on every one of the 3,629 pairs.
 *
 * Exported as a TEST SEAM (its public callers pass through `pricedTruckSql`,
 * which needs a second «needle» truck, a 12-month window and a live charge).
 */
export async function pricePairs(
  exec: ReadTx,
  pairs: { clientId: string; batchId: string }[],
): Promise<Map<string, { kg: number; m3: number; kinds: number; usd: number; moved: 'no_cargo' | 'partial' | null }>> {
  const out = new Map<string, { kg: number; m3: number; kinds: number; usd: number; moved: 'no_cargo' | 'partial' | null }>();
  const unique = [...new Map(pairs.map((p) => [`${p.clientId}:${p.batchId}`, p])).values()];
  if (unique.length === 0) return out;
  const batchIds = [...new Set(unique.map((p) => p.batchId))];
  const values = sql.join(
    unique.map((p) => sql`(${p.clientId}::uuid, ${p.batchId}::uuid)`),
    sql`, `,
  );
  const rows = await exec.execute<{ batch_id: string; client_id: string; kg: string; m3: string; kinds: number; usd: string }>(sql`
    WITH ${riderCtesSql(uuidList(batchIds))},
    pairs(client_id, batch_id) AS (VALUES ${values}),
    load AS (
      SELECT m.batch_id, rr.client_id,
             coalesce(sum(rl.total_weight_kg / rl.box_count), 0) AS kg,
             coalesce(sum(rl.total_volume_m3 / rl.box_count), 0) AS m3,
             array_agg(DISTINCT rl.id) AS lot_ids
        FROM members m
        JOIN boxes bx ON bx.id = m.box_id
        JOIN receipt_lots rl ON rl.id = bx.lot_id
        JOIN receipts rr ON rr.id = rl.receipt_id
        JOIN pairs p ON p.client_id = rr.client_id AND p.batch_id = m.batch_id
       GROUP BY m.batch_id, rr.client_id
    ),
    kinds AS (
      SELECT l.batch_id, l.client_id,
             count(DISTINCT coalesce(g.id::text, ${productKeySql(sql`lk.product_name_zh`)}))::int AS kinds
        FROM load l
        CROSS JOIN LATERAL unnest(l.lot_ids) AS u(lot_id)
        JOIN receipt_lots lk ON lk.id = u.lot_id
        LEFT JOIN lot_composition_lines g ON g.lot_id = u.lot_id
       GROUP BY l.batch_id, l.client_id
    ),
    money AS (
      SELECT c.batch_id, c.client_id, sum(c.amount_usd) AS usd
        FROM client_transactions c
        JOIN pairs p ON p.client_id = c.client_id AND p.batch_id = c.batch_id
       WHERE c.type IN ${CHARGE_TYPES} AND c.voided_at IS NULL
       GROUP BY c.batch_id, c.client_id
    )
    SELECT l.batch_id::text AS batch_id, l.client_id::text AS client_id, l.kg, l.m3, kd.kinds, mo.usd
      FROM load l JOIN money mo ON mo.batch_id = l.batch_id AND mo.client_id = l.client_id
      JOIN kinds kd ON kd.batch_id = l.batch_id AND kd.client_id = l.client_id
  `);
  const moved = await offTruckPrices(exec, { batchIds }, { changes: false });
  const movedOf = new Map(
    moved
      .filter((row) => row.kind === 'no_cargo' || row.kind === 'partial')
      .map((row) => [`${row.clientId}:${row.batchId}`, row.kind as 'no_cargo' | 'partial']),
  );
  for (const r of rows) {
    const key = `${r.client_id}:${r.batch_id}`;
    out.set(key, {
      kg: Number(r.kg),
      m3: Number(r.m3),
      kinds: Number(r.kinds),
      usd: Number(r.usd),
      moved: movedOf.get(key) ?? null,
    });
  }
  return out;
}

const dayOf = (at: string) =>
  new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });

export interface Needle {
  key: string;
  zh: string;
  ru: string | null;
  code: string | null;
  clientId: string | null;
}

/**
 * The one read behind the icon, as a statement — exported so a test can
 * EXPLAIN the very text the page runs: the indexes are the design, and only
 * a plan can say they are read. The caller sets the trigram threshold for
 * the transaction; `%` beside each `similarity` is what reaches the indexes.
 */
export function historyPairsSql(input: {
  needles: Needle[];
  pageLotIds: string[];
  minSim: number;
  batchId: string;
  actor: ScopedActor;
}): SQL {
  const { needles, minSim, batchId, actor } = input;
  // The cargo on THIS page is what is being priced, never its own precedent.
  const pageLots = uuidList([...new Set(input.pageLotIds)]);
  const needleValues = sql.join(
    needles.map(
      (n, i) =>
        sql`(${i}::int, ${n.key}::text, ${n.zh}::text, ${n.ru}::text, ${n.code}::text, ${n.clientId}::uuid)`,
    ),
    sql`, `,
  );

  return sql`
        WITH needles(needle, nkey, nzh, nru, ncode, nclient) AS (VALUES ${needleValues})
        SELECT n.needle, h.client_id::text AS client_id, h.client_code, h.batch_id::text AS batch_id,
               h.batch_code, h.departed_at, h.past_lot_id::text AS past_lot_id, h.strength, h.own
          FROM needles n
          CROSS JOIN LATERAL (
            SELECT w.*
              FROM (
                SELECT DISTINCT ON (ml.client_id, b.id)
                       ml.client_id, cl.client_code, b.id AS batch_id, b.code AS batch_code, b.departed_at,
                       ml.past_lot_id, ml.strength, ml.own
                  FROM (
                    SELECT x.past_lot_id, max(x.strength) AS strength, pr.client_id,
                           coalesce(pr.client_id = n.nclient, false) AS own
                      FROM (
                        SELECT pl.id AS past_lot_id, 3 AS strength FROM receipt_lots pl
                         WHERE ${productKeySql(sql`pl.product_name_zh`)} = n.nkey
                        UNION ALL
                        SELECT pl.id, 2 FROM receipt_lots pl
                         WHERE n.ncode IS NOT NULL
                           AND ${productKeySql(sql`pl.product_name_zh`)} IN (
                             SELECT ta.product_key FROM tnved_assignments ta
                              WHERE ta.tnved_code = n.ncode AND length(ta.tnved_code) = 10)
                        UNION ALL
                        SELECT pl.id, 1 FROM receipt_lots pl
                         WHERE n.nru IS NOT NULL AND pl.product_name_ru % n.nru
                           AND similarity(pl.product_name_ru, n.nru) >= ${minSim}
                        UNION ALL
                        SELECT pl.id, 1 FROM receipt_lots pl
                         WHERE pl.product_name_zh % n.nzh
                           AND similarity(pl.product_name_zh, n.nzh) >= ${minSim}
                      ) x
                      JOIN receipt_lots pl2 ON pl2.id = x.past_lot_id
                      JOIN receipts pr ON pr.id = pl2.receipt_id
                     WHERE pr.client_id IS NOT NULL AND pr.voided_at IS NULL AND pr.status = 'confirmed'
                       AND pr.confirmed_at >= ${windowStart(13)}::timestamptz
                       AND x.past_lot_id NOT IN (${pageLots})
                     GROUP BY x.past_lot_id, pr.client_id, pr.confirmed_at
                     ORDER BY coalesce(pr.client_id = n.nclient, false) DESC, max(x.strength) DESC, pr.confirmed_at DESC
                     LIMIT ${MATCHED_LOTS_CAP}
                  ) ml
                  JOIN LATERAL (
                    SELECT DISTINCT rides.batch_id FROM (
                      ${riderRowsSql({ boxes: sql`SELECT lb.id FROM boxes lb WHERE lb.lot_id = ml.past_lot_id` })}
                    ) rides
                  ) rode ON true
                  JOIN batches b ON b.id = rode.batch_id
                  JOIN clients cl ON cl.id = ml.client_id
                 WHERE ${pricedTruckSql(batchId, actor, sql`ml.client_id`)}
                 ORDER BY ml.client_id, b.id, ml.strength DESC, ml.past_lot_id
              ) w
             -- His 28a, in SQL: the cap per needle, own client first (16a),
             -- then the stronger match, then the newest truck.
             ORDER BY w.own DESC, w.strength DESC, w.departed_at DESC, w.batch_id
             LIMIT ${PRICE_HISTORY_CAP}
          ) h
      `;
}

/**
 * The icon's list for every lot on the page — one read transaction for all
 * the needles, then one price read for the survivors. `actor` is REQUIRED:
 * a warehouse-scoped reader sees only trucks whose card they could open, and
 * an optional scope fails OPEN (#790).
 */
export async function priceHistoryForLots(
  lots: BatchLot[],
  batchId: string,
  actor: ScopedActor,
): Promise<Map<string, PriceHistory>> {
  const out = new Map<string, PriceHistory>();
  if (lots.length === 0) return out;

  // Before any transaction (#714): the setting and the code memory ride the pool.
  const configured = Number(await getSetting('price_history_min_sim'));
  const minSim = Number.isFinite(configured) && configured > 0 ? configured : 0.6;
  const codes = await tnvedFor(lots.map((lot) => lot.productNameZh));

  const needleFor = (lot: BatchLot): Needle => {
    const key = productKey(lot.productNameZh);
    const code = codes.get(key)?.tnvedCode ?? null;
    return {
      key,
      zh: lot.productNameZh,
      ru: lot.productNameRu?.trim() ? lot.productNameRu : null,
      // A 4-digit heading is every shoe: only the full declaration code matches.
      code: code && /^\d{10}$/.test(code) ? code : null,
      clientId: lot.clientId,
    };
  };

  // Lots with the same name, code and client ask the same question once.
  const needles: Needle[] = [];
  const needleOf = new Map<string, number>();
  const lotNeedle = new Map<string, number>();
  for (const lot of lots) {
    const needle = needleFor(lot);
    const id = JSON.stringify(needle);
    if (!needleOf.has(id)) {
      needleOf.set(id, needles.length);
      needles.push(needle);
    }
    lotNeedle.set(lot.lotId, needleOf.get(id)!);
    out.set(lot.lotId, { rows: [], failed: false });
  }
  // ONE read transaction for all of it — the match, the riders walk and the
  // off-truck read — so the ceiling covers every statement and one catch
  // covers every failure: the list is a hint beside the money, and the page
  // must go on rendering without it.
  let read: { pairs: PairRow[]; priced: Awaited<ReturnType<typeof pricePairs>> };
  try {
    read = await underCeiling(async (tx) => {
      const pairs = await tx.execute<PairRow>(
        historyPairsSql({ needles, pageLotIds: lots.map((lot) => lot.lotId), minSim, batchId, actor }),
      );
      const priced = await pricePairs(
        tx,
        pairs.map((row) => ({ clientId: row.client_id, batchId: row.batch_id })),
      );
      return { pairs: [...pairs], priced };
    }, minSim);
  } catch (err) {
    // A timeout or any failure is a sentence on the page, never a broken one.
    logger.warn({ err, batchId }, '[price-history] read failed');
    for (const history of out.values()) history.failed = true;
    return out;
  }
  const { pairs, priced } = read;

  const byNeedle = new Map<number, PairRow[]>();
  for (const row of pairs) {
    const list = byNeedle.get(Number(row.needle)) ?? [];
    list.push(row);
    byNeedle.set(Number(row.needle), list);
  }

  const historyOf = new Map<number, PriceHistory>();
  for (const [needle, rows] of byNeedle) {
    const candidates: PriceCandidate[] = [];
    for (const row of rows) {
      const p = priced.get(`${row.client_id}:${row.batch_id}`);
      if (!p) continue;
      candidates.push({
        batchId: row.batch_id,
        batchCode: row.batch_code,
        departedDay: dayOf(row.departed_at),
        clientId: row.client_id,
        clientCode: row.client_code,
        own: row.own,
        match: MATCH_OF(Number(row.strength)),
        chargeUsd: p.usd,
        kg: p.kg,
        m3: p.m3,
        goodsKinds: p.kinds,
        cargoMoved: p.moved,
        pastLotId: row.past_lot_id,
      });
    }
    historyOf.set(needle, { rows: rankPriceHistory(candidates), failed: false });
  }
  for (const lot of lots) {
    const found = historyOf.get(lotNeedle.get(lot.lotId)!);
    if (found) out.set(lot.lotId, found);
  }
  return out;
}

/** The AI's rows, and which of the named lots reached a row THIS reader may see. */
export interface PickedHistory extends PriceHistory {
  /**
   * The picked lots that landed on a priced, in-scope truck for this reader —
   * what a stored reason may be printed against. A reason names a past lot's
   * goods, chosen from the PRESSER's trucks; printed to a reader whose door
   * refuses those trucks, it would be another client's goods name from a
   * truck they cannot open.
   */
  reachedLotIds: string[];
}

/**
 * The priced rows for lots the MODEL named (0119, 18a) — the same frame and
 * the same price read as the free list, so an AI row and a free row can
 * never disagree about a price: the model picks lots, the ledger prices them.
 * Soft like the free list: under the same ceiling, and `failed` rather than
 * a thrown page.
 */
export async function pricedRowsForLots(
  pastLotIds: string[],
  batchId: string,
  actor: ScopedActor,
  ownClientId: string | null,
): Promise<PickedHistory> {
  const ids = [...new Set(pastLotIds)].filter(Boolean);
  if (ids.length === 0) return { rows: [], failed: false, reachedLotIds: [] };
  type Hit = {
    client_id: string;
    client_code: string | null;
    batch_id: string;
    batch_code: string;
    departed_at: string;
    past_lot_id: string;
  };
  let hits: Hit[];
  let priced: Awaited<ReturnType<typeof pricePairs>>;
  try {
    ({ hits, priced } = await underCeiling(async (tx) => {
      // Every (lot, truck) and not one per pair: which LOTS reached a row is
      // what the reasons are filtered by.
      const found = [
        ...(await tx.execute<Hit>(sql`
          SELECT pr.client_id::text AS client_id, cl.client_code, b.id::text AS batch_id, b.code AS batch_code,
                 b.departed_at, pl.id::text AS past_lot_id
            FROM receipt_lots pl
            JOIN receipts pr ON pr.id = pl.receipt_id AND pr.client_id IS NOT NULL AND pr.voided_at IS NULL
            JOIN clients cl ON cl.id = pr.client_id
            JOIN LATERAL (
              SELECT DISTINCT rides.batch_id FROM (
                ${riderRowsSql({ boxes: sql`SELECT lb.id FROM boxes lb WHERE lb.lot_id = pl.id` })}
              ) rides
            ) rode ON true
            JOIN batches b ON b.id = rode.batch_id
           WHERE pl.id IN (${uuidList(ids)})
             AND ${pricedTruckSql(batchId, actor, sql`pr.client_id`)}
           ORDER BY pr.client_id, b.id, pl.id
        `)),
      ];
      const prices = await pricePairs(
        tx,
        found.map((row) => ({ clientId: row.client_id, batchId: row.batch_id })),
      );
      return { hits: found, priced: prices };
    }));
  } catch (err) {
    logger.warn({ err, batchId }, '[price-history] picked rows failed');
    return { rows: [], failed: true, reachedLotIds: [] };
  }
  const candidates = new Map<string, PriceCandidate>();
  const reached = new Set<string>();
  for (const row of hits) {
    const key = `${row.client_id}:${row.batch_id}`;
    const p = priced.get(key);
    if (!p) continue;
    reached.add(row.past_lot_id);
    if (candidates.has(key)) continue;
    candidates.set(key, {
      batchId: row.batch_id,
      batchCode: row.batch_code,
      departedDay: dayOf(row.departed_at),
      clientId: row.client_id,
      clientCode: row.client_code,
      own: ownClientId !== null && row.client_id === ownClientId,
      match: 'ai',
      chargeUsd: p.usd,
      kg: p.kg,
      m3: p.m3,
      goodsKinds: p.kinds,
      cargoMoved: p.moved,
      pastLotId: row.past_lot_id,
    });
  }
  return { rows: rankPriceHistory([...candidates.values()]), failed: false, reachedLotIds: [...reached] };
}

/**
 * The model's words about one candidate, and the past lots that candidate
 * stood for. The lots are what the reason is printed against: a reader sees
 * a reason only when one of its lots reached a row priced for THEM.
 */
export interface SimilarPickReason {
  name: string;
  reason: string;
  lotIds: string[];
}

/** A stored AI pick for a lot (0119): the past lots it named and why. */
export interface SimilarPickRecord {
  pickedLotIds: string[];
  reasons: SimilarPickReason[];
}

/**
 * The `model` a pick row carries while its model call is still out — the
 * route's CLAIM on the lot (one press pays once, however many tabs press),
 * written before the call and replaced by the answer or deleted on a
 * failure. A claim older than `SIMILAR_CLAIM_STALE_MS` is a process that died
 * mid-call, and the next press takes it over (the workspace lock's window).
 */
export const SIMILAR_PICK_PENDING = 'pending';
export const SIMILAR_CLAIM_STALE_MS = 10 * 60_000;

/**
 * Which of a pick's reasons THIS reader may be shown: those whose candidate
 * reached one of the reader's priced rows. Pure — the filter is the fence.
 */
export function visibleReasons(pick: SimilarPickRecord, reachedLotIds: string[]): SimilarPickReason[] {
  const reached = new Set(reachedLotIds);
  return pick.reasons.filter((r) => r.lotIds.some((id) => reached.has(id)));
}

/** The page's picks in ONE query, keyed by the lot they were asked for; a claim still out is not a pick. */
export async function similarPicksFor(lotIds: string[]): Promise<Map<string, SimilarPickRecord>> {
  const out = new Map<string, SimilarPickRecord>();
  const ids = [...new Set(lotIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const rows = await db.execute<{ lot_id: string; picked_lot_ids: string[] | null; reasons: unknown }>(sql`
    SELECT lot_id::text AS lot_id, picked_lot_ids::text[] AS picked_lot_ids, reasons
      FROM lot_similar_picks WHERE lot_id IN (${uuidList(ids)}) AND model <> ${SIMILAR_PICK_PENDING}
  `);
  for (const r of rows) {
    out.set(r.lot_id, {
      pickedLotIds: r.picked_lot_ids ?? [],
      reasons: Array.isArray(r.reasons)
        ? (r.reasons as { name?: unknown; reason?: unknown; lotIds?: unknown }[]).map((x) => ({
            name: String(x.name ?? ''),
            reason: String(x.reason ?? ''),
            lotIds: Array.isArray(x.lotIds) ? x.lotIds.map(String) : [],
          }))
        : [],
    });
  }
  return out;
}
