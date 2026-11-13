import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgSelect } from 'drizzle-orm/pg-core';
import { lotChecks, receiptLots } from '../../platform/db/schema';
import type { CheckFilter } from './lot-check-face';
import { lotClientConfirmsReady, lotClientMeasuresReady, lotTickMeasuresReady } from './lot-check-ready';
import { lotRuShownSql } from './lot-name';

export {
  LOT_CHECK_STATES,
  chipFace,
  inCheckFilter,
  readCheckFilter,
  type CheckFilter,
  type LotCheckState,
} from './lot-check-face';

/**
 * «Yuk ma'lumoti tekshirildi» (0123, docs/YUK-TEKSHIRUV.md) — the ONE sentence
 * for whether a lot's information is confirmed, read by the stock table, its
 * Σ and its chip counts, the Ostatka XLSX, the plan editor, the prixod card,
 * the client card's «Yuklar» and the homes' counts (#513). Nothing else may
 * restate it; `tests/unit/lot-check-wire.test.ts` says so.
 *
 * Two bases, and neither is a flag somebody has to remember to clear:
 *
 *  · the PERSON's (the owner's 2b) — a `lot_checks` row whose snapshot still
 *    equals the lot: the goods name (both spellings), the carton count and
 *    the client. A rename, a count correction, the QR-siz count growth or a
 *    new client make it read «stale» by COMPARISON — and a take-back to the
 *    vouched count reads checked again by itself, which a clear-on-write
 *    could never do. Since 0147 the tick also remembers the lot's kilos and
 *    cubic metres, at the precision a list prints them, and a re-weigh makes
 *    it «stale» as it does the client's own ✅ (the owner's «2 b» of
 *    2026-11-12: «xodim qo'ygan ✅ ham kg/kub o'zgarsa «o'zgardi» bo'lsin» —
 *    which reverses 0123's «a re-weigh is the warehouse's correction, not
 *    "what is it"»). The Russian name compared is
 *    the one the screens SHOW (`lotRuShownSql` — the tarkib's label while one
 *    is written, standing or not): a person confirms what the card printed,
 *    so a tarkib written, changed or cleared after the tick makes it «stale»,
 *    and a tick pressed under a stale tarkib is for the label it was pressed
 *    under (docs/TARKIB-TUZATISH.md §9.3);
 *  · the TARKIB's (his 3a) — a lot tarkibi that still stands: the same
 *    three terms `isStale` (composition-math.ts) compares, restated here in
 *    SQL and pinned against it by `lot-check.integration.test.ts`. ANY
 *    standing tarkib vouches (2026-11-10, docs/TARKIB-TUZATISH.md §3.5 — the
 *    recorded reversal of his 8.6): a one-line tarkib naming another good
 *    used to leave ❓, because the warehouse screens went on printing the
 *    lot's own name and a ✅ beside it would have vouched for the name the
 *    tarkib contradicts. The screens print the tarkib's name now
 *    (`receipts/lot-name.ts`), so what the ✅ stands beside IS what a person
 *    stated. With or without a document: 0143 made the file optional, and
 *    this sentence never read it. Only the composition's STATE leaves this
 *    module — never a line.
 *
 *  · the CLIENT's own (0144, docs/TARKIB-TAKLIFLAR.md §4 — his 5b) — a
 *    `lot_client_confirms` row: the ✅ or ❌ the client pressed in Telegram,
 *    with what the message SHOWED them. A ✅ is the same kind of snapshot,
 *    compared the same way, plus the tarkib's goods as printed
 *    (`goods_key`) and — when the question asked about them (0146, the
 *    owner's «4 ha»: «og'irlik va hajmga urg'u berilsin») — the lot's kilos
 *    and cubic metres as the customer reads them: while it matches the lot
 *    reads «checked» and nobody has to telephone. A ❌ is a VETO, and it
 *    stands against exactly what it
 *    rejected: a tarkib does not vouch for the goods the client rejected,
 *    and a colleague's tick does not vouch unless it was pressed AFTER the
 *    ❌ (`lotCheckStateSql` spells the four ways it ends). No fourth state:
 *    a disputed lot belongs on the ❓ worklist.
 *
 * Every reader LEFT JOINs `lot_checks`, `lotTarkibJoinSql()` and the
 * client's row on the lot and asks `lotCheckStateSql`. A JOIN and never a
 * correlated subquery in a WHERE: the design review measured that shape at
 * 3.3 s on an 18k-carton copy against 41 ms for the join. Every join is at
 * most one row per lot, so none can fan a count out.
 *
 * `lot`, `receipt`, `check` are table REFERENCES, never columns (#128): pass
 * `sql\`${receiptLots}\`` for a joined table or `sql\`l\`` for an alias
 * (`qrlessRowSql`'s shape).
 */

/** The derived per-lot composition totals' alias. */
export const LOT_TARKIB = sql.raw('lot_tarkib');

/**
 * The lot tarkibi's totals, one row per composed lot, as a join source:
 * `.leftJoin(lotTarkibJoinSql(), lotTarkibOnSql(sql\`${receiptLots}\`))`. The table is
 * small (compositions are rare) and grouped once per statement.
 *
 * `goods_key` is the goods AS A QUESTION PRINTS THEM — every line's name and
 * pieces, in order — and it is what the client's answer is compared with
 * (0144). Deliberately not the composition's `rev`: that token moves on
 * every save AND on every TNVED code typed on the Bojxona tab, so a client's
 * ✅ would read «eskirgan» after routine coding and a ❌ would be lifted by
 * it — the design judge's blocker. A LINE's kg, m³, cartons and codes are not
 * in it: the client is not shown them. (The LOT's own kilos and cubic metres
 * are shown, and since 0146 they are part of the answer — as two figures of
 * their own, `shown_kg` / `shown_m3`, never inside this digest: arm 1 below
 * asks whether a ❌ was given on the very GOODS a tarkib still lists, and a
 * re-weigh must not answer that.)
 */
export function lotTarkibJoinSql(): SQL {
  return sql`(
    SELECT c.lot_id, c.seen_box_count, sum(l.weight_kg) AS kg, sum(l.volume_m3) AS m3,
           md5(string_agg(l.name || chr(31) || coalesce(l.pieces::text, ''), chr(30) ORDER BY l.seq)) AS goods_key
      FROM lot_compositions c
      JOIN lot_composition_lines l ON l.lot_id = c.lot_id
     GROUP BY c.lot_id, c.seen_box_count
  ) AS ${LOT_TARKIB}`;
}

export function lotTarkibOnSql(lot: SQL): SQL {
  return sql`${LOT_TARKIB}.lot_id = ${lot}.id`;
}

/** The client's own answer's alias (0144) — at most one row per lot. */
export const LOT_CLIENT = sql.raw('lot_client');

export function lotClientJoinSql(): SQL {
  return sql`lot_client_confirms AS ${LOT_CLIENT}`;
}

export function lotClientOnSql(lot: SQL): SQL {
  return sql`${LOT_CLIENT}.lot_id = ${lot}.id`;
}

export interface LotCheckRefs {
  lot: SQL;
  receipt: SQL;
  check: SQL;
}

/** The composition stands: the SQL twin of `!isStale(...)`. */
export function tarkibStandsSql(lot: SQL): SQL {
  return sql`(${LOT_TARKIB}.lot_id IS NOT NULL
    AND ${LOT_TARKIB}.seen_box_count = ${lot}.box_count
    AND ${LOT_TARKIB}.kg = ${lot}.total_weight_kg
    AND ${LOT_TARKIB}.m3 = ${lot}.total_volume_m3)`;
}

/**
 * The person's snapshot, term by term — the card names WHICH one moved, and
 * the state below is their conjunction, so the two cannot disagree.
 * `NULLIF(…, '')` on the lot's Russian name: the column stores an absent name
 * as NULL, and a row written before that rule must not read «renamed». The
 * SHOWN Russian name, never the stored one alone: with the stored name here a
 * tick made as «Клавиатура», then a one-line tarkib «Мышь» and a re-weigh,
 * read ✅ «mijoz tasdiqladi» beside «键盘 (Мышь)».
 */
export function checkTermsSql(refs: LotCheckRefs): { name: SQL; count: SQL; client: SQL; measures: SQL } {
  const { lot, receipt, check } = refs;
  return {
    name: sql`(${check}.seen_name_zh = ${lot}.product_name_zh
      AND ${check}.seen_name_ru IS NOT DISTINCT FROM NULLIF(${lotRuShownSql(lot)}, ''))`,
    count: sql`(${check}.seen_box_count = ${lot}.box_count)`,
    client: sql`(${check}.seen_client_id IS NOT DISTINCT FROM ${receipt}.client_id)`,
    measures: tickMeasuresHoldSql(refs),
  };
}

/**
 * The kilos and cubic metres the colleague's tick remembered still stand
 * (0147, the owner's «2 b» of 2026-11-12) — compared at the precision a list
 * PRINTS them, through the very two expressions the client's full ✅ is
 * compared with (`lotShownKgSql` / `lotShownM3Sql`, rounded by the database on
 * both sides, #1708): one rule for «the figures a ✅ vouched for». A change
 * below what a list prints (40.004 kg after 40.000) moves nothing. NULL = a
 * tick that said nothing about them — one written by an old process in the
 * minutes between the migration and its restart — and it holds on its other
 * three terms, as a pre-0146 answer does. Location-free, like every term here
 * (his 3a: a ✅ is for the figures it was given, wherever the cargo stands).
 * Named columns, so only where they exist (`lotTickMeasuresReady()`).
 */
function tickMeasuresHoldSql(refs: Pick<LotCheckRefs, 'lot' | 'check'>): SQL {
  if (!lotTickMeasuresReady()) return sql`TRUE`;
  const { lot, check } = refs;
  return sql`(${check}.seen_kg IS NULL
    OR (${check}.seen_kg = ${lotShownKgSql(lot)} AND ${check}.seen_m3 = ${lotShownM3Sql(lot)}))`;
}

/**
 * The lot's kilos and cubic metres AS A CUSTOMER READS THEM — two places and
 * three (`roundKg` / `roundM3`'s). ONE pair of expressions for what a
 * question remembers (`client-confirm.ts` reads them into `shown_kg` /
 * `shown_m3`) and for what the sentence compares them with, both rounded by
 * the DATABASE: a figure rounded in JavaScript on one side and in SQL on the
 * other differs on a half (100.005 kg), and such a lot's ✅ could never match.
 */
export function lotShownKgSql(lot: SQL): SQL {
  return sql`round(${lot}.total_weight_kg, 2)`;
}

export function lotShownM3Sql(lot: SQL): SQL {
  return sql`round(${lot}.total_volume_m3, 3)`;
}

/**
 * The measures the client confirmed still stand (0146). NULL = the question
 * did not ask about them — every answer given before 0146 and every press on
 * a button sent before it — and such an answer holds on the five 0144 terms
 * alone. Named columns, so only where they exist (`lotClientMeasuresReady()`;
 * `lot-check-ready.ts` says why not `to_jsonb`).
 */
export function clientMeasuresHoldSql(lot: SQL): SQL {
  if (!lotClientMeasuresReady()) return sql`TRUE`;
  return sql`(${LOT_CLIENT}.shown_kg IS NULL
    OR (${LOT_CLIENT}.shown_kg = ${lotShownKgSql(lot)} AND ${LOT_CLIENT}.shown_m3 = ${lotShownM3Sql(lot)}))`;
}

/**
 * The client's answer is about what the lists still show (0144): the five
 * things the question printed — the carton count, the owner, the tarkib's
 * goods (`goods_key`; NULL on both sides = no tarkib then, none now) and
 * both name spellings — and, for a question that asked about them (0146),
 * the lot's kilos and cubic metres. A rename, a count correction, a new
 * owner, a tarkib written, changed or cleared afterwards, a re-weigh a
 * customer would see — and a ✅ is about data that no longer exists. The
 * SHOWN Russian name, as on the person's tick, and LAST: it is the one term
 * that costs a subquery, and the sentence runs once per carton on the lists
 * (the design judge measured 4.5 → 48 ms with it first).
 */
export function clientHoldsSql(refs: Pick<LotCheckRefs, 'lot' | 'receipt'>): SQL {
  const { early, late } = clientFactTerms(refs);
  return sql`(${early}
    AND ${clientMeasuresHoldSql(refs.lot)}
    AND ${late})`;
}

/**
 * The five 0144 terms, written ONCE — in two halves, because the measures sit
 * between them in the state's sentence and the term that costs a subquery
 * must stay last. `clientHoldsSql` and `clientFactsHoldSql` are both built
 * from these: they used to be two hand copies, and a sixth term added to one
 * would have made the card and the state disagree with nothing red (#513;
 * the as-built review of 0146, CA-2).
 */
function clientFactTerms(refs: Pick<LotCheckRefs, 'lot' | 'receipt'>): { early: SQL; late: SQL } {
  const { lot, receipt } = refs;
  return {
    early: sql`${LOT_CLIENT}.lot_id IS NOT NULL
    AND ${LOT_CLIENT}.shown_count = ${lot}.box_count
    AND ${LOT_CLIENT}.shown_client_id IS NOT DISTINCT FROM ${receipt}.client_id`,
    late: sql`${LOT_CLIENT}.shown_goods_key IS NOT DISTINCT FROM ${LOT_TARKIB}.goods_key
    AND ${LOT_CLIENT}.shown_zh = ${lot}.product_name_zh
    AND ${LOT_CLIENT}.shown_ru IS NOT DISTINCT FROM NULLIF(${lotRuShownSql(lot)}, '')`,
  };
}

/**
 * The 0144 half alone — the five things every question has printed — for
 * the CARD, which says WHY a ✅ stopped holding: «og'irlik yoki hajm
 * o'zgardi» only when these still stand and the measures are what moved
 * (pinned: a lot renamed AND re-weighed blames the name, never the weight).
 * The lists never ask it; the state is `clientHoldsSql`'s — these same terms
 * (`clientFactTerms`) AND `clientMeasuresHoldSql`.
 */
export function clientFactsHoldSql(refs: Pick<LotCheckRefs, 'lot' | 'receipt'>): SQL {
  const { early, late } = clientFactTerms(refs);
  return sql`(${early}
    AND ${late})`;
}

/**
 * A ❌ of the prixod's CURRENT owner is on the lot (0144). Two-valued on
 * purpose — it is negated below, and `NOT NULL` would make a lot with no
 * answer at all fall out of its ✅. A previous owner's ❌ is nobody's: the
 * prixod was corrected to another client, who has said nothing.
 */
export function clientDisputeSql(refs: Pick<LotCheckRefs, 'receipt'>): SQL {
  return sql`(${LOT_CLIENT}.verdict IS NOT DISTINCT FROM 'no'
    AND ${LOT_CLIENT}.shown_client_id IS NOT DISTINCT FROM ${refs.receipt}.client_id)`;
}

/**
 * The state. A ❌ stands against exactly what it rejected, whatever else has
 * moved since (0144, the design judge — a veto tied to the whole snapshot
 * was too weak AND too strong: a typo fixed in the Chinese name lifted it
 * and the untouched tarkib the client had rejected read ✅ again, while a
 * colleague who phoned the client and ticked could not lift it at all):
 *
 *  1. a standing composition vouches (the client's own document, his 3a — on
 *     unclaimed cargo too) UNLESS this owner's ❌ was given on the very goods
 *     it still lists;
 *  2. cargo with no client has nobody to ask and its own list (/unclaimed);
 *  3. the person's snapshot vouches UNLESS this owner's ❌ is not older than
 *     the tick — a colleague who ticks AFTER the ❌ has heard the client;
 *  4. the client's own ✅, while it is about what the lists still show;
 *  5. a ❌ nothing vouches past reads ❓ — «none», never «o'zgardi»: the lot
 *     is not something that WAS confirmed;
 *  6. anything that was confirmed and no longer matches is «stale».
 *
 * So a ❌ ends four ways and no fifth: the rejected goods are changed, a
 * colleague ticks after it, the client answers again, or «E'tirozni yopish».
 * kg and m³ lift no ❌ — a complaint about a weight is closed by a person;
 * they are compared in TWO places, each against the figures its own ✅
 * remembered: arm 3, a colleague's tick (0147, his «2 b»), and arm 4, a ✅
 * given to a question that asked about them (0146) — either stops vouching
 * once they move.
 *
 * On a server whose 0144 has not landed (`lotClientConfirmsReady()`, #472)
 * this is the two-source sentence that shipped with 0123, word for word.
 */
export function lotCheckStateSql(refs: LotCheckRefs): SQL {
  const terms = checkTermsSql(refs);
  const ticked = sql`(${refs.check}.lot_id IS NOT NULL AND ${terms.name} AND ${terms.count} AND ${terms.client} AND ${terms.measures})`;
  if (!lotClientConfirmsReady()) {
    return sql`(CASE
      WHEN ${tarkibStandsSql(refs.lot)} THEN 'checked'
      WHEN ${refs.receipt}.client_id IS NULL THEN 'unclaimed'
      WHEN ${ticked} THEN 'checked'
      WHEN ${refs.check}.lot_id IS NOT NULL OR ${LOT_TARKIB}.lot_id IS NOT NULL THEN 'stale'
      ELSE 'none'
    END)`;
  }
  const dispute = clientDisputeSql(refs);
  return sql`(CASE
    WHEN ${tarkibStandsSql(refs.lot)}
      AND NOT (${dispute} AND ${LOT_CLIENT}.shown_goods_key IS NOT DISTINCT FROM ${LOT_TARKIB}.goods_key) THEN 'checked'
    WHEN ${refs.receipt}.client_id IS NULL THEN 'unclaimed'
    WHEN ${ticked}
      AND NOT (${dispute} AND ${refs.check}.checked_at <= ${LOT_CLIENT}.answered_at) THEN 'checked'
    WHEN ${LOT_CLIENT}.verdict = 'yes' AND ${clientHoldsSql(refs)} THEN 'checked'
    WHEN ${dispute} THEN 'none'
    WHEN ${refs.check}.lot_id IS NOT NULL OR ${LOT_TARKIB}.lot_id IS NOT NULL
      OR ${LOT_CLIENT}.verdict = 'yes' THEN 'stale'
    ELSE 'none'
  END)`;
}

/**
 * «Askable» (his 4a): the ❓ list is cargo standing in a CHINESE warehouse —
 * the information is needed for the invoice, and the invoice is made before
 * the truck leaves China. Cargo already in Uzbekistan shows ✅ when it was
 * checked and nothing otherwise.
 */
export function askableSql(warehouse: SQL): SQL {
  return sql`(${warehouse}.country = 'CN')`;
}

/**
 * «Askable» for ONE lot — the prixod card's question, which has no row's
 * warehouse to ask (a lot can stand in two places): is any of its live
 * cartons still in China — on a Chinese shelf, or on a truck that left a
 * Chinese warehouse and has not unloaded yet? The invoice is made before the
 * border and the mismatch is usually found after loading (his lot tarkibi
 * 3b), so a carton on the road out of China is still worth asking about.
 * Once every carton stands in Uzbekistan (or is handed over), the card shows
 * ✅ when it was checked and nothing otherwise — the lists' rule (his 4a).
 * «On the road» is the truck's own status: a carton an unload declared
 * missing keeps its truck and no warehouse, and an UNLOADED truck is not
 * carrying anything out of China any more (the fix review).
 * Read per lot for the card's few lots; never a list's WHERE (§4).
 */
export function lotAskableSql(lot: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM boxes ab
      LEFT JOIN warehouses aw ON aw.id = ab.current_warehouse_id
      LEFT JOIN batches abt ON abt.id = ab.current_batch_id
      LEFT JOIN warehouses ao ON ao.id = abt.origin_warehouse_id
     WHERE ab.lot_id = ${lot}.id
       AND ab.status NOT IN ('issued', 'lost', 'void')
       AND (aw.country = 'CN'
            OR (ab.current_warehouse_id IS NULL AND ao.country = 'CN' AND abt.status IN ('loading', 'in_transit', 'arrived')))
  )`;
}

/**
 * The filter over a state and an «askable» — ONE function for the row level
 * (`lotCheckStateSql`, `askableSql`) and the grouped level (`g.state`,
 * `g.askable`), so the table and its Σ cannot answer two different questions.
 */
export function checkFilterSql(tek: CheckFilter, state: SQL, askable: SQL): SQL {
  return tek === 'ha'
    ? sql`(${state} = 'checked')`
    : sql`(${state} IN ('none', 'stale') AND ${askable})`;
}

/**
 * The joins every list reader makes, on a `$dynamic()` query — or none when
 * `on` is false (`lotChecksReady()` said the tables are not there yet, #472):
 * the reader then runs its pre-0123 shape and draws no chip. The client's
 * answers are the third join only where their table exists (0144) — the
 * sentence asks the same question and never names an alias that was not
 * joined.
 */
export function withLotCheckJoins<T extends PgSelect>(qb: T, on: boolean): T {
  if (!on) return qb;
  const two = qb
    .leftJoin(lotChecks, eq(lotChecks.lotId, receiptLots.id))
    .leftJoin(lotTarkibJoinSql(), lotTarkibOnSql(sql`${receiptLots}`));
  if (!lotClientConfirmsReady()) return two as unknown as T;
  return two.leftJoin(lotClientJoinSql(), lotClientOnSql(sql`${receiptLots}`)) as unknown as T;
}

/** The state where the joins were made, NULL where they were not (no chip, never ❓). */
export function lotCheckStateOrNullSql(on: boolean, refs: LotCheckRefs): SQL {
  return on ? lotCheckStateSql(refs) : sql`NULL::text`;
}
