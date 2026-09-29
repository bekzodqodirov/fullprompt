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
 * «price»), and the past lot must really have ridden it. A (client, truck)
 * with an UNCONVERTED charge is never a row — its dollars are unknown, and
 * «$0» or a partial sum would be a price nobody asked — it is counted into
 * `noFx` and said in the footer. Unclaimed cargo has no client and no price.
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
  /** (client, truck) pairs skipped for a charge with no FX rate. */
  noFx: number;
  /** The read timed out or failed: the page says so and keeps rendering. */
  failed: boolean;
}

/** His 28a: the last five, within twelve months. */
export const PRICE_HISTORY_CAP = 5;

/** Past lots probed per needle, newest-and-own first — the read's bound, stated. */
const MATCHED_LOTS_CAP = 300;

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

/** The truck frame every arm shares: which (client, truck) a past lot's price may come from. */
function truckFrame(batchId: string, actor: ScopedActor): SQL {
  return sql`b.id <> ${batchId}::uuid
    AND b.departed_at IS NOT NULL
    AND b.departed_at >= ${windowStart(12)}::timestamptz
    AND ${batchEndsInScopeSql(actor, 'b')}`;
}

const CHARGE_TYPES = sql.raw(`(${PRICING_CHARGE_TYPES.map((t) => `'${t}'`).join(', ')})`);

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
  unconverted: boolean;
  no_fx: number;
};

/**
 * Query 2 and 3 for a set of (client, truck) pairs — the prices' ONE home,
 * used by the free list and by the AI's picks alike: the client's whole load
 * aboard as rider shares, how many kinds of goods it was, the pair's charges
 * in dollars, and whether the cargo left the truck after the price.
 */
async function pricePairs(
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
  const rows = await db.execute<{ batch_id: string; client_id: string; kg: string; m3: string; kinds: number; usd: string | null }>(sql`
    WITH ${riderCtesSql(uuidList(batchIds))},
    pairs(client_id, batch_id) AS (VALUES ${values}),
    load AS (
      SELECT m.batch_id, rr.client_id,
             coalesce(sum(rl.total_weight_kg / rl.box_count), 0) AS kg,
             coalesce(sum(rl.total_volume_m3 / rl.box_count), 0) AS m3,
             count(DISTINCT ${productKeySql(sql`rl.product_name_zh`)})::int AS kinds
        FROM members m
        JOIN boxes bx ON bx.id = m.box_id
        JOIN receipt_lots rl ON rl.id = bx.lot_id
        JOIN receipts rr ON rr.id = rl.receipt_id
        JOIN pairs p ON p.client_id = rr.client_id AND p.batch_id = m.batch_id
       GROUP BY m.batch_id, rr.client_id
    ),
    money AS (
      SELECT c.batch_id, c.client_id, sum(c.amount_usd) AS usd
        FROM client_transactions c
        JOIN pairs p ON p.client_id = c.client_id AND p.batch_id = c.batch_id
       WHERE c.type IN ${CHARGE_TYPES} AND c.voided_at IS NULL
       GROUP BY c.batch_id, c.client_id
    )
    SELECT l.batch_id::text AS batch_id, l.client_id::text AS client_id, l.kg, l.m3, l.kinds, mo.usd
      FROM load l JOIN money mo ON mo.batch_id = l.batch_id AND mo.client_id = l.client_id
  `);
  const moved = await offTruckPrices(db, { batchIds }, { changes: false });
  const movedOf = new Map(
    moved
      .filter((row) => row.kind === 'no_cargo' || row.kind === 'partial')
      .map((row) => [`${row.clientId}:${row.batchId}`, row.kind as 'no_cargo' | 'partial']),
  );
  for (const r of rows) {
    if (r.usd === null) continue;
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

interface Needle {
  key: string;
  zh: string;
  ru: string | null;
  code: string | null;
  clientId: string | null;
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

  // Lots with the same name, code and client ask the same question once.
  const needles: Needle[] = [];
  const needleOf = new Map<string, number>();
  for (const lot of lots) {
    const key = productKey(lot.productNameZh);
    const code = codes.get(key)?.tnvedCode ?? null;
    const needle: Needle = {
      key,
      zh: lot.productNameZh,
      ru: lot.productNameRu?.trim() ? lot.productNameRu : null,
      // A 4-digit heading is every shoe: only the full declaration code matches.
      code: code && /^\d{10}$/.test(code) ? code : null,
      clientId: lot.clientId,
    };
    const id = JSON.stringify(needle);
    if (!needleOf.has(id)) {
      needleOf.set(id, needles.length);
      needles.push(needle);
    }
    out.set(lot.lotId, { rows: [], noFx: 0, failed: false });
  }
  const lotNeedle = new Map(
    lots.map((lot) => {
      const key = productKey(lot.productNameZh);
      const code = codes.get(key)?.tnvedCode ?? null;
      return [
        lot.lotId,
        needleOf.get(
          JSON.stringify({
            key,
            zh: lot.productNameZh,
            ru: lot.productNameRu?.trim() ? lot.productNameRu : null,
            code: code && /^\d{10}$/.test(code) ? code : null,
            clientId: lot.clientId,
          }),
        )!,
      ];
    }),
  );
  // The cargo on THIS page is what is being priced, never its own precedent.
  const pageLots = uuidList([...new Set(lots.map((lot) => lot.lotId))]);
  const needleValues = sql.join(
    needles.map(
      (n, i) =>
        sql`(${i}::int, ${n.key}::text, ${n.zh}::text, ${n.ru}::text, ${n.code}::text, ${n.clientId}::uuid)`,
    ),
    sql`, `,
  );

  let pairs: PairRow[];
  try {
    pairs = await db.transaction(async (tx) => {
      // One statement for both: the trigram operator's threshold from the same
      // setting the comparison uses, and a ceiling on the read — a page must
      // never hang on its own hint.
      await tx.execute(sql`
        SELECT set_config('pg_trgm.similarity_threshold', ${String(minSim)}, true),
               set_config('statement_timeout', '1500', true)`);
      return tx.execute<PairRow>(sql`
        WITH needles(needle, nkey, nzh, nru, ncode, nclient) AS (VALUES ${needleValues})
        SELECT n.needle, h.client_id::text AS client_id, h.client_code, h.batch_id::text AS batch_id,
               h.batch_code, h.departed_at, h.past_lot_id::text AS past_lot_id, h.strength, h.own,
               h.unconverted, h.no_fx
          FROM needles n
          CROSS JOIN LATERAL (
            SELECT w.*, count(*) FILTER (WHERE w.unconverted) OVER () AS no_fx,
                   row_number() OVER (
                     PARTITION BY w.unconverted
                     ORDER BY w.own DESC, w.strength DESC, w.departed_at DESC, w.batch_id
                   ) AS rk
              FROM (
                SELECT DISTINCT ON (ml.client_id, b.id)
                       ml.client_id, cl.client_code, b.id AS batch_id, b.code AS batch_code, b.departed_at,
                       ml.past_lot_id, ml.strength, ml.own,
                       EXISTS (
                         SELECT 1 FROM client_transactions cu
                          WHERE cu.client_id = ml.client_id AND cu.batch_id = b.id
                            AND cu.type IN ${CHARGE_TYPES} AND cu.voided_at IS NULL AND cu.amount_usd IS NULL
                       ) AS unconverted
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
                 WHERE ${truckFrame(batchId, actor)}
                   AND EXISTS (
                     SELECT 1 FROM client_transactions c
                      WHERE c.client_id = ml.client_id AND c.batch_id = b.id
                        AND c.type IN ${CHARGE_TYPES} AND c.voided_at IS NULL
                   )
                 ORDER BY ml.client_id, b.id, ml.strength DESC, ml.past_lot_id
              ) w
          ) h
         WHERE (NOT h.unconverted AND h.rk <= ${PRICE_HISTORY_CAP}) OR (h.unconverted AND h.rk = 1)
      `);
    });
  } catch (err) {
    // A timeout or any failure is a sentence on the page, never a broken one.
    logger.warn({ err, batchId }, '[price-history] read failed');
    for (const history of out.values()) history.failed = true;
    return out;
  }

  const byNeedle = new Map<number, PairRow[]>();
  for (const row of pairs) {
    const list = byNeedle.get(Number(row.needle)) ?? [];
    list.push(row);
    byNeedle.set(Number(row.needle), list);
  }
  const survivors = pairs.filter((row) => !row.unconverted);
  const priced = await pricePairs(survivors.map((row) => ({ clientId: row.client_id, batchId: row.batch_id })));

  const historyOf = new Map<number, PriceHistory>();
  for (const [needle, rows] of byNeedle) {
    const candidates: PriceCandidate[] = [];
    for (const row of rows) {
      if (row.unconverted) continue;
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
    historyOf.set(needle, {
      rows: rankPriceHistory(candidates),
      noFx: Number(rows[0]?.no_fx ?? 0),
      failed: false,
    });
  }
  for (const lot of lots) {
    const found = historyOf.get(lotNeedle.get(lot.lotId)!);
    if (found) out.set(lot.lotId, found);
  }
  return out;
}

/**
 * The priced rows for lots the MODEL named (0119, 18a) — the same frame and
 * the same price read as the free list, so an AI row and a free row can
 * never disagree about a price: the model picks lots, the ledger prices them.
 */
export async function pricedRowsForLots(
  pastLotIds: string[],
  batchId: string,
  actor: ScopedActor,
  ownClientId: string | null,
): Promise<PriceHistory> {
  const ids = [...new Set(pastLotIds)].filter(Boolean);
  if (ids.length === 0) return { rows: [], noFx: 0, failed: false };
  const pairs = await db.execute<{
    client_id: string;
    client_code: string | null;
    batch_id: string;
    batch_code: string;
    departed_at: string;
    past_lot_id: string;
    unconverted: boolean;
  }>(sql`
    SELECT DISTINCT ON (pr.client_id, b.id)
           pr.client_id::text AS client_id, cl.client_code, b.id::text AS batch_id, b.code AS batch_code,
           b.departed_at, pl.id::text AS past_lot_id,
           EXISTS (
             SELECT 1 FROM client_transactions cu
              WHERE cu.client_id = pr.client_id AND cu.batch_id = b.id
                AND cu.type IN ${CHARGE_TYPES} AND cu.voided_at IS NULL AND cu.amount_usd IS NULL
           ) AS unconverted
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
       AND ${truckFrame(batchId, actor)}
       AND EXISTS (
         SELECT 1 FROM client_transactions c
          WHERE c.client_id = pr.client_id AND c.batch_id = b.id
            AND c.type IN ${CHARGE_TYPES} AND c.voided_at IS NULL
       )
     ORDER BY pr.client_id, b.id, pl.id
  `);
  const convertible = pairs.filter((row) => !row.unconverted);
  const priced = await pricePairs(convertible.map((row) => ({ clientId: row.client_id, batchId: row.batch_id })));
  const candidates: PriceCandidate[] = [];
  for (const row of convertible) {
    const p = priced.get(`${row.client_id}:${row.batch_id}`);
    if (!p) continue;
    candidates.push({
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
  return {
    rows: rankPriceHistory(candidates),
    noFx: pairs.length - convertible.length,
    failed: false,
  };
}

/** A stored AI pick for a lot (0119): the past lots it named and why. */
export interface SimilarPickRecord {
  pickedLotIds: string[];
  reasons: { name: string; reason: string }[];
}

/** The page's picks in ONE query, keyed by the lot they were asked for. */
export async function similarPicksFor(lotIds: string[]): Promise<Map<string, SimilarPickRecord>> {
  const out = new Map<string, SimilarPickRecord>();
  const ids = [...new Set(lotIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const rows = await db.execute<{ lot_id: string; picked_lot_ids: string[] | null; reasons: unknown }>(sql`
    SELECT lot_id::text AS lot_id, picked_lot_ids::text[] AS picked_lot_ids, reasons
      FROM lot_similar_picks WHERE lot_id IN (${uuidList(ids)})
  `);
  for (const r of rows) {
    out.set(r.lot_id, {
      pickedLotIds: r.picked_lot_ids ?? [],
      reasons: Array.isArray(r.reasons)
        ? (r.reasons as { name?: unknown; reason?: unknown }[]).map((x) => ({
            name: String(x.name ?? ''),
            reason: String(x.reason ?? ''),
          }))
        : [],
    });
  }
  return out;
}
