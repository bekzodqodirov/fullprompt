/**
 * «Hisob vs haqiqat» — what a calculation said the customs would cost, and
 * what it actually cost (VED phase E1, docs/VED.md phase E).
 *
 * ---------------------------------------------------------------------------
 * THE ONE DECISION THIS FILE RESTS ON: the comparison is CUSTOMS ONLY.
 * ---------------------------------------------------------------------------
 *
 * The design asked for `total_usd` against the landed cost, and that number
 * is gross margin wearing a VED's name. `freightFor`'s own docstring says
 * `freight_usd` is «the list price of the road, before any concession» while
 * `cost_allocations.amount_usd` is what the road actually cost us. Price minus
 * cost is profit. Measured on the owner's own tariff: a 30 m³ / 200 kg/m³
 * cn-zone load quotes $4,800 from row [151,200,160,100] while the truck costs
 * roughly $2,700 — **+78 %, permanently, on a calculation executed exactly as
 * quoted.** Against any threshold at all, every sealed version would trip for
 * ever and the list would be worthless by the second week.
 *
 * Customs is a different kind of number: `customsFor` = duty + VAT + fee is
 * money payable to the STATE, and the accountant types the same payment into
 * the cost grid. Both sides are the same fact measured twice, so a gap is an
 * error and not a margin. It is also where the model's only money-bearing
 * proposal lands — `ai_duty_pct` — which is what closes the owner's loop:
 * the AI proposes the duty, the duty drives the customs figure, and this is
 * where confirming it blind turns into money.
 *
 * Freight gets a BAND CHECK instead (`freightBandCheck`) — a deterministic,
 * free re-lookup at the density the cargo actually arrived at. That is the
 * decision the VED really makes, and it is checkable.
 *
 * Nothing here is stored. `voidCostEntry` deletes allocations and a late FX
 * rate re-prices an entry, so a figure frozen the night the truck landed is
 * the lie the screen would then repeat for ever.
 */

import { sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { getSetting } from '@/modules/platform/settings/service';
import { compareQuote } from '../deals/deviation';
import { ARRIVED_ON_A_TRUCK } from '../documents/arrivals';
import { freightFor, sectionParts, type CalcSectionName, type FreightBand } from './pricing';
import { bandsAsOf, tariffHistory } from './dictionaries';
import { LINK_IMPLAUSIBLE_FACTOR, measurableLinkSql } from './link';
import { measurableRequestSql } from './version-set';

/**
 * Why a bucket cannot be scored. **A bucket that cannot be compared is never
 * scored** — every one of these would otherwise read as a −100 % saving or a
 * +∞ overrun, and a person would be measured by it.
 */
export type ActualRefusal =
  /** The client cleared this cargo through their own firm. No cost of ours. */
  | 'customs_by_client'
  /** A yolkira quote has no customs line to compare. */
  | 'section_has_no_customs'
  /** An entry has no FX rate yet, so `amount_usd` is NULL (`recomputeEntry`
   *  returns before allocating). Reading that as $0 makes a missing rate look
   *  like a saving. */
  | 'unconverted'
  /** Converted, but nothing was allocated — a `direct_to_client` entry filed
   *  against a client who owns none of these boxes writes no rows at all, and
   *  a $1,800 bill on the wrong client would otherwise read as $1,800 saved. */
  | 'unallocated'
  /** Nobody has typed the rastamojka yet. Not an error — a wait. */
  | 'no_actual_yet'
  /** There ARE costs on this cargo, but none under a type the customs bucket
   *  maps to. Names what it found, so the mapping is discoverable. */
  | 'no_actual_cost'
  /** Less cargo arrived than was quoted, beyond the deal threshold: comparing
   *  a full quote against half a shipment measures the truck, not the VED. */
  | 'cargo_incomplete'
  /** Σ linked cargo is wildly bigger than the quote — somebody has confirmed
   *  a year of shipments onto one calculation. */
  | 'link_implausible'
  /** Nothing is linked to this calculation at all. */
  | 'not_linked';

export interface FreightBandCheck {
  /** The band the quote was priced in. */
  quotedMin: number | null;
  quotedRate: number | null;
  /** The band the cargo would fall in at its arrived density. */
  arrivedMin: number | null;
  arrivedRate: number | null;
  arrivedDensity: number | null;
  /** Same band, or nothing to say (no freight in this section, no measures). */
  ok: boolean | null;
  /**
   * Why the band could not be looked up, when that is a fact about the TABLE
   * rather than about this quote. Collapsing `band_missing` and
   * `band_ambiguous` into the same silence as «this section has no freight»
   * broke phase B's own rule — ⚠ and a reason, never nothing — and hid the
   * one case a person must act on: those two refusals are properties of a
   * tariff the owner edits, so a hole or an overlap he has just created
   * would have removed the freight line from every affected row with
   * nothing on screen to say the table now contradicts itself.
   */
  refusal: 'band_missing' | 'band_ambiguous' | null;
}

export interface CalcActualRow {
  requestId: string;
  versionId: string;
  versionNo: number;
  sealedAt: Date;
  sealedBy: string;
  sealedByName: string | null;
  section: CalcSectionName;
  entityType: 'deal' | 'lead';
  entityId: string;
  clientCode: string | null;
  clientName: string | null;
  /** How much cargo the quote was written for. */
  quotedVolumeM3: number | null;
  quotedWeightKg: number | null;
  /** What the linked prixods actually measured. */
  actualVolumeM3: number;
  actualWeightKg: number;
  receiptCount: number;
  /** The quote's own customs figure. */
  quotedCustomsUsd: number;
  /** What was actually paid, when it can be said at all. */
  actualCustomsUsd: number | null;
  /** Signed: +12 means the rastamojka cost 12 % more than the quote said. */
  customsPct: number | null;
  /**
   * Is the gap big enough to be worth a person's time?
   *
   * `calc_customs_deviation_pct` is the owner's own number and it shipped
   * with NO reader at all — a live row on /admin/settings that changed
   * nothing, which is 0064's `tg_peer_index` mistake in a new place. The
   * screen was colouring on the SIGN, so a 0.4 % overrun looked exactly as
   * alarming as a 60 % one.
   */
  customsOffThreshold: boolean;
  refusal: ActualRefusal | null;
  /** The cost types found on this cargo when none of them mapped. */
  foundCostTypes: string[];
  band: FreightBandCheck;
  /** When the cargo landed in Uzbekistan; null while it is still travelling. */
  arrivedAt: Date | null;
  settled: boolean;
  warnedGroups: number;
  aiBlindGroups: number;
  aiRateTakenGroups: number;
}

/** Which cost types are «rastamojka». DATA, because the owner mints his own. */
export async function customsCostCodes(): Promise<string[]> {
  const raw = (await getSetting('calc_customs_cost_type_codes')) ?? '["customs"]';
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    if (!Array.isArray(parsed)) return ['customs'];
    const codes = parsed.map((c) => String(c).trim()).filter(Boolean);
    return codes.length > 0 ? codes : ['customs'];
  } catch {
    // A hand-edited setting must not take the screen down. The default IS the
    // seeded code, so a broken value degrades to the shipped behaviour.
    return ['customs'];
  }
}

/**
 * Has the accountant had time to type it?
 *
 * The clock starts when the cargo LANDS, not when the price was sealed. The
 * road is a 10.5-day floor and about 17 days typically, and a quote may sit
 * up to 30 days before the cargo even ships — so a sealed-at clock would make
 * every accuracy table empty until roughly the 18th of any month.
 */
export function settledFor(
  arrivedAt: Date | null,
  settleDays: number,
  now: Date = new Date(),
): boolean {
  if (!arrivedAt) return false;
  return now.getTime() - arrivedAt.getTime() >= settleDays * 86_400_000;
}

/**
 * Which band would this cargo fall in at the density it actually arrived at?
 *
 * The freight decision restated, not the freight money. Deterministic, free,
 * and the thing the VED can actually be wrong about: a quote priced in the
 * 151-200 band for cargo that lands at 96 kg/m³ was priced in the wrong row
 * of the owner's own table, and that is a sentence he can act on.
 */
export function freightBandCheck(input: {
  section: CalcSectionName;
  tariff: FreightBand[];
  zone: string | null;
  quotedMin: number | null;
  quotedRate: number | null;
  actualWeightKg: number;
  actualVolumeM3: number;
}): FreightBandCheck {
  const empty: FreightBandCheck = {
    quotedMin: input.quotedMin,
    quotedRate: input.quotedRate,
    arrivedMin: null,
    arrivedRate: null,
    arrivedDensity: null,
    ok: null,
    refusal: null,
  };
  if (!sectionParts(input.section).freight) return empty;
  if (!(input.actualVolumeM3 > 0) || !(input.actualWeightKg > 0)) return empty;
  const found = freightFor(input.tariff, {
    zone: input.zone,
    weightKg: input.actualWeightKg,
    volumeM3: input.actualVolumeM3,
  });
  if (!found.ok) {
    return {
      ...empty,
      refusal:
        found.reason === 'band_missing' || found.reason === 'band_ambiguous'
          ? found.reason
          : null,
    };
  }
  return {
    quotedMin: input.quotedMin,
    quotedRate: input.quotedRate,
    arrivedMin: found.band.minDensity,
    arrivedRate: found.band.priceUsd,
    arrivedDensity: found.density,
    refusal: null,
    // A band with no quoted min is a quote whose freight was never resolved;
    // there is nothing to agree or disagree with.
    ok: input.quotedMin === null ? null : Math.abs(found.band.minDensity - input.quotedMin) < 0.005,
  };
}

/**
 * The one refusal ladder, in the order the questions actually arise.
 *
 * Pure, so the whole table is unit-testable without a database — which is
 * what makes each of these a red proof rather than an assertion about SQL.
 */
export function bucketRefusal(facts: {
  section: CalcSectionName;
  linkedReceipts: number;
  anyCustomsByClient: boolean;
  cargoIncomplete: boolean;
  linkImplausible: boolean;
  /** Any non-void cost entry at all on this cargo. */
  entriesFound: number;
  /** Of those, the ones under a mapped customs type. */
  mappedEntries: number;
  /** Of the mapped ones, how many have no `amount_usd` yet. */
  unconvertedEntries: number;
  /** Of the mapped, converted ones, how many allocated nothing. */
  unallocatedEntries: number;
}): ActualRefusal | null {
  if (facts.linkedReceipts === 0) return 'not_linked';
  if (facts.linkImplausible) return 'link_implausible';
  if (!sectionParts(facts.section).customs) return 'section_has_no_customs';
  if (facts.anyCustomsByClient) return 'customs_by_client';
  if (facts.cargoIncomplete) return 'cargo_incomplete';
  if (facts.entriesFound === 0) return 'no_actual_yet';
  if (facts.mappedEntries === 0) return 'no_actual_cost';
  // Both of these mean the figure that IS there is smaller than the truth,
  // and a smaller-than-truth actual reads as the VED having overcharged.
  if (facts.unconvertedEntries > 0) return 'unconverted';
  if (facts.unallocatedEntries > 0) return 'unallocated';
  return null;
}

export interface ActualsScope {
  scope: 'all' | 'own';
  actorId: string;
}

/**
 * ONE grouped query. Never a per-row aggregate on a list (#432/#526): the
 * length of this list is the business growing.
 */
export async function calcActuals(
  who: ActualsScope,
  opts: { since?: Date; limit?: number; settledOnly?: boolean } = {},
): Promise<CalcActualRow[]> {
  const [codes, settleDaysRaw, thresholdRaw, customsPctRaw, tariff] = await Promise.all([
    customsCostCodes(),
    getSetting('calc_actual_settle_days'),
    getSetting('deal_deviation_threshold_pct'),
    getSetting('calc_customs_deviation_pct'),
    // The whole tariff HISTORY, not today's table. The band a quote was
    // priced in came from the tariff in force when it was SEALED, and the
    // owner edits his table by adding a dated row — so comparing every
    // historical row against today's boundaries makes correct old quotes
    // start reporting the wrong band the morning after any edit. That is the
    // same failure this round exists to avoid: a check that fires on work
    // nobody got wrong.
    tariffHistory(),
  ]);
  const settleDays = Number(settleDaysRaw ?? 7);
  const threshold = Number(thresholdRaw ?? 10);
  const customsThreshold = Number(customsPctRaw ?? 15);
  const since = opts.since ?? new Date(Date.now() - 90 * 86_400_000);
  const limit = opts.limit ?? 200;

  // A JS array bound into a raw fragment does not become a postgres array.
  const codeList = sql.join(codes.map((c) => sql`${c}`), sql`, `);
  const ownFilter = who.scope === 'own' ? sql`AND v.sealed_by = ${who.actorId}` : sql``;
  // The settle gate belongs in SQL, BEFORE the LIMIT, and that is not a
  // performance nicety. The two clocks run in opposite directions: a settled
  // row is by construction an OLD seal (the road is a ten-day floor and the
  // quote may stand a month before the cargo ships) while `ORDER BY sealed_at
  // DESC LIMIT n` keeps the NEWEST. Filtered afterwards in JS, the busier the
  // company gets the more certainly every scoreable row falls outside the
  // slice — so the screen would print «hali solishtiradigan narsa yo'q»
  // under a coverage line reporting a full month of work. That is the exact
  // «we have no errors» / «we have no data» confusion the section order was
  // designed to prevent.
  const settledFilter = opts.settledOnly
    ? sql`AND arrival.arrived_at IS NOT NULL
          AND arrival.arrived_at <= now() - make_interval(days => ${settleDays})`
    : sql``;

  const rows = await db.execute<Record<string, unknown>>(sql`
    WITH
    -- The requests the outer SELECT can possibly return, computed FIRST and
    -- joined into every CTE below.
    --
    -- Without it, linked selected every receipt that had ever carried a
    -- confirmed link, and arrival, entries, scoped and money all fanned
    -- out from there — walking box_movements and cost_allocations over the
    -- company's whole history to produce at most 200 rows from the last 90
    -- days. That is the #432/#526 shape this codebase has paid for four
    -- times: the work grew with the business while the output did not.
    want AS (
      SELECT v.request_id
        FROM calc_versions v
        JOIN calc_requests r ON r.id = v.request_id
       WHERE ${currentVersion()}
         AND ${measurableRequestSql()}
         AND v.sealed_at >= ${since.toISOString()}::timestamptz
         ${ownFilter}
    ),
    linked AS (
      SELECT r.calc_request_id AS request_id,
             r.id              AS receipt_id,
             -- THREE states, not two, and effectiveCustoms is the system's
             -- one definition of them: an explicit answer on the prixod wins
             -- (false is an answer -- «we clear this one»), NULL is silence
             -- and the TRUCK's answer applies. A bare coalesce to false made
             -- «mijoz o'z firmasi bilan» set once on the batch card invisible
             -- here, so a shared truck the client cleared themselves was
             -- scored against a rastamojka we never paid.
             CASE
               WHEN r.customs_by_client IS NOT NULL OR r.customs_partner_id IS NOT NULL
                 THEN r.customs_by_client IS TRUE
               ELSE coalesce((
                 SELECT bool_or(ba.customs_by_client)
                   FROM receipt_lots rl0
                   JOIN boxes b0 ON b0.lot_id = rl0.id
                   JOIN box_movements bm0 ON bm0.box_id = b0.id
                        AND bm0.ref_type = 'batch' AND bm0.cause = 'batch_departed'
                   JOIN batches ba ON ba.id = bm0.ref_id
                  WHERE rl0.receipt_id = r.id
               ), false)
             END AS by_client
        FROM receipts r
        JOIN want ON want.request_id = r.calc_request_id
       WHERE ${measurableLinkSql('r')}
    ),
    cargo AS (
      SELECT l.request_id,
             count(DISTINCT l.receipt_id)          AS receipts,
             coalesce(sum(rl.total_volume_m3), 0)  AS volume_m3,
             coalesce(sum(rl.total_weight_kg), 0)  AS weight_kg,
             bool_or(l.by_client)                  AS any_by_client
        FROM linked l
        LEFT JOIN receipt_lots rl ON rl.receipt_id = l.receipt_id
       GROUP BY l.request_id
    ),
    -- The cargo LANDED. Through box_movements and never the live pointer
    -- (#440): landing nulls current_batch_id and an unloaded truck's boxes
    -- point at nothing.
    --
    -- The predicate is documents/arrivals.ts's, restated here as SQL rather
    -- than re-derived, and the first version of it was WRONG in the way that
    -- file's own comment warns about. It asked for to_status = 'in_stock',
    -- which unloading NEVER writes: a customs or distribution warehouse puts
    -- cargo straight into 'ready_for_pickup' (unload.ts), and in Uzbekistan
    -- every destination is one of those two. Measured on real rows: every
    -- unload_scan into a UZ warehouse is 'ready_for_pickup', so the CTE
    -- matched walk-in receipts alone and settled was false FOR EVER -- the
    -- whole comparison this round exists for would have rendered empty on
    -- every truck, for months, with nothing on screen to say why.
    --
    --   * the CAUSES are «a truck brought this box here»; found_here counts
    --     (round 89's failed-scanner path: it rode the truck, it was simply
    --     never scanned off it), found_at_origin does not.
    --   * from IS DISTINCT FROM to keeps plan_approved, load_scan and
    --     crate_packed out -- they carry the box's own warehouse on both
    --     sides and are status changes, not journeys. MEASURED redundant
    --     today (0 of 234 rows under the three causes above have from = to),
    --     and kept anyway so this rule and documents/arrivals.ts read as the
    --     same sentence: the cause list is what actually fences it, and a
    --     cause added to that list tomorrow may not be a journey.
    arrival AS (
      SELECT l.request_id, max(m.created_at) AS arrived_at
        FROM linked l
        JOIN receipt_lots rl ON rl.receipt_id = l.receipt_id
        JOIN boxes b  ON b.lot_id = rl.id
        JOIN box_movements m ON m.box_id = b.id
        JOIN warehouses w    ON w.id = m.to_warehouse_id
       WHERE w.country = 'UZ'
         AND m.cause IN (${sql.join(ARRIVED_ON_A_TRUCK.map((c) => sql`${c}`), sql`, `)})
         AND m.from_warehouse_id IS DISTINCT FROM m.to_warehouse_id
       GROUP BY l.request_id
    ),
    -- Every non-void cost entry that touches this cargo, at ANY scope: the
    -- accountant's per-prixod grid writes receipt-scope rows, while shared
    -- customs on the export truck is one batch-scope row spread over boxes.
    -- Allocations are the only grain that sees both.
    entries AS (
      SELECT DISTINCT l.request_id, ce.id, ce.amount_usd, ct.code, ct.name
        FROM linked l
        JOIN receipt_lots rl ON rl.receipt_id = l.receipt_id
        JOIN boxes b ON b.lot_id = rl.id AND b.status <> 'void'
        JOIN cost_allocations ca ON ca.box_id = b.id
        JOIN cost_entries ce ON ce.id = ca.cost_entry_id
        JOIN cost_types   ct ON ct.id = ce.cost_type_id
       WHERE ce.voided_at IS NULL
    ),
    -- An entry whose FX rate has not arrived writes NO allocation rows at
    -- all, so the entries CTE cannot see it. Looked up on its own, or a
    -- missing rate reads as a saving.
    -- Entries that NAME one of our prixods, seen WITHOUT going through
    -- cost_allocations. Two ways a real customs bill goes missing from the
    -- comparison, and the entries CTE above can see neither of them, because
    -- both write no allocation rows at all:
    --
    --   * no FX rate yet -> recomputeEntry returns before allocating
    --   * converted, but allocated to NOBODY -- a direct_to_client entry
    --     filed against a client who owns none of these boxes
    --
    -- Both make the actual read LOWER than the truth, which puts the VED in
    -- the wrong on a bill they had nothing to do with. Receipt scope only:
    -- an entry naming our prixod and allocating nothing to it is unambiguous,
    -- while a BATCH-scope entry on a truck our boxes rode may legitimately
    -- allocate to other clients' cargo and nothing is wrong with that.
    scoped AS (
      SELECT DISTINCT l.request_id, ce.id, ce.amount_usd,
             EXISTS (
               SELECT 1
                 FROM cost_allocations ca
                 JOIN boxes b2 ON b2.id = ca.box_id
                 JOIN receipt_lots rl2 ON rl2.id = b2.lot_id
                WHERE ca.cost_entry_id = ce.id
                  AND rl2.receipt_id = l.receipt_id
             ) AS allocated
        FROM linked l
        JOIN cost_entries ce ON ce.receipt_id = l.receipt_id
        JOIN cost_types   ct ON ct.id = ce.cost_type_id
       WHERE ce.voided_at IS NULL
         AND ct.code IN (${codeList})

      UNION

      -- The BATCH-scope half, and only for an entry that converted to
      -- NOTHING. Round 29's agreed method puts shared rastamojka on the
      -- export truck as ONE batch-scope row, so restricting this CTE to
      -- receipt scope hid the commonest customs bill there is whenever its
      -- FX rate had not arrived: recomputeEntry returns before allocating,
      -- so no allocation row exists and every other CTE is blind to it, and
      -- the screen scored a green «-70 %» against a VED on a bill of ours
      -- worth more than the quote.
      --
      -- Only the unconverted ones, deliberately: a CONVERTED batch entry
      -- that allocated nothing to our boxes is not an error at all -- a
      -- truck carries several clients and direct_to_client legitimately
      -- lands elsewhere.
      SELECT DISTINCT l.request_id, ce.id, ce.amount_usd, false AS allocated
        FROM linked l
        JOIN receipt_lots rl3 ON rl3.receipt_id = l.receipt_id
        JOIN boxes b3 ON b3.lot_id = rl3.id
        JOIN box_movements bm ON bm.box_id = b3.id
             AND bm.ref_type = 'batch' AND bm.cause = 'batch_departed'
        JOIN cost_entries ce ON ce.batch_id = bm.ref_id
        JOIN cost_types   ct ON ct.id = ce.cost_type_id
       WHERE ce.voided_at IS NULL
         AND ce.amount_usd IS NULL
         AND ct.code IN (${codeList})
    ),
    money AS (
      SELECT l.request_id, sum(ca.amount_usd) AS actual_usd
        FROM linked l
        JOIN receipt_lots rl ON rl.receipt_id = l.receipt_id
        JOIN boxes b ON b.lot_id = rl.id AND b.status <> 'void'
        JOIN cost_allocations ca ON ca.box_id = b.id
        JOIN cost_entries ce ON ce.id = ca.cost_entry_id
        JOIN cost_types   ct ON ct.id = ce.cost_type_id
       WHERE ce.voided_at IS NULL
         AND ct.code IN (${codeList})
       GROUP BY l.request_id
    ),
    -- One pass over the scoped CTE, not three correlated counts in the
    -- select list: a materialised CTE has no index, so a scalar subquery
    -- over it is a scan
    -- per output row — the #152 shape, three times over.
    --
    -- scoped_entries is what the allocation table cannot see AT ALL, and it
    -- never double-counts an entry that DID allocate: a converted, allocated
    -- entry is already in entries_found and mapped_entries.
    scoped_health AS (
      SELECT request_id,
             count(*) FILTER (WHERE amount_usd IS NULL) AS unconverted_entries,
             count(*) FILTER (WHERE amount_usd IS NOT NULL AND NOT allocated)
               AS unallocated_entries,
             count(*) FILTER (WHERE amount_usd IS NULL OR NOT allocated)
               AS scoped_entries
        FROM scoped
       GROUP BY request_id
    ),
    health AS (
      SELECT e.request_id,
             count(*)                                          AS entries_found,
             count(*) FILTER (WHERE e.code IN (${codeList}))    AS mapped_entries,
             array_agg(DISTINCT e.name)                         AS found_names
        FROM entries e
       GROUP BY e.request_id
    )
    SELECT v.id            AS version_id,
           v.request_id,
           v.version_no,
           v.sealed_at,
           v.sealed_by,
           u.full_name     AS sealed_by_name,
           v.section,
           v.customs_usd,
           v.volume_m3     AS quoted_volume_m3,
           v.weight_kg     AS quoted_weight_kg,
           v.freight_band_min,
           v.freight_rate,
           v.warned_groups,
           v.ai_blind_groups,
           v.ai_rate_taken_groups,
           r.entity_type,
           r.entity_id,
           r.freight_zone,
           c.client_code,
           c.name          AS client_name,
           coalesce(cargo.receipts, 0)   AS receipts,
           coalesce(cargo.volume_m3, 0)  AS actual_volume_m3,
           coalesce(cargo.weight_kg, 0)  AS actual_weight_kg,
           coalesce(cargo.any_by_client, false) AS any_by_client,
           arrival.arrived_at,
           money.actual_usd,
           coalesce(health.entries_found, 0) AS entries_found,
           coalesce(health.mapped_entries, 0) AS mapped_entries,
           coalesce(health.found_names, ARRAY[]::text[]) AS found_names,
           coalesce(sh.unconverted_entries, 0) AS unconverted_entries,
           coalesce(sh.unallocated_entries, 0)  AS unallocated_entries,
           coalesce(sh.scoped_entries, 0)       AS scoped_entries
      FROM calc_versions v
      JOIN calc_requests r ON r.id = v.request_id
      LEFT JOIN users  u ON u.id = v.sealed_by
      LEFT JOIN deals  d ON d.id = r.entity_id AND r.entity_type = 'deal'
      LEFT JOIN clients c ON c.id = d.client_id
      LEFT JOIN cargo   ON cargo.request_id = v.request_id
      LEFT JOIN arrival ON arrival.request_id = v.request_id
      LEFT JOIN money   ON money.request_id = v.request_id
      LEFT JOIN health  ON health.request_id = v.request_id
      LEFT JOIN scoped_health sh ON sh.request_id = v.request_id
     WHERE ${currentVersion()}
       AND ${measurableRequestSql()}
       AND v.sealed_at >= ${since.toISOString()}::timestamptz
       ${ownFilter}
       ${settledFilter}
     ORDER BY v.sealed_at DESC
     LIMIT ${limit}
  `);

  const now = new Date();
  return rows.map((row) => {
    const section = String(row.section) as CalcSectionName;
    const quotedVolumeM3 = num(row.quoted_volume_m3);
    const quotedWeightKg = num(row.quoted_weight_kg);
    const actualVolumeM3 = Number(row.actual_volume_m3 ?? 0);
    const actualWeightKg = Number(row.actual_weight_kg ?? 0);
    const receiptCount = Number(row.receipts ?? 0);
    const quotedCustomsUsd = Number(row.customs_usd ?? 0);
    const actualUsd = row.actual_usd === null || row.actual_usd === undefined ? null : Number(row.actual_usd);

    // Cargo completeness, through `compareQuote` verbatim rather than a
    // second definition of «how far out are we» (#513). The settle gate only
    // proves the LINKED prixods landed — it says nothing about the 12 m³ that
    // are still on a truck or arrived with no deal on them at all.
    //
    // On the VOLUME alone, and that was found by LOOKING at the screen rather
    // than by a test. `compareQuote` takes whichever measure moved further in
    // EITHER direction, which is right for the question it was written for
    // («should somebody ring the client») and wrong for this one. Cargo that
    // arrives at the quoted 30 m³ weighing 2,900 kg instead of 5,400 is not
    // half a shipment — it is all of it, at a density the VED got wrong, and
    // that is precisely the error this screen exists to show. Reading it as
    // «not all the cargo arrived» refuses the comparison at the moment it has
    // the most to say. Missing cargo is a VOLUME shortfall; a weight-only one
    // is a mis-estimate, and the band check below names it.
    const deviation = compareQuote(
      { volumeM3: quotedVolumeM3, weightKg: quotedWeightKg, amount: null },
      { volumeM3: actualVolumeM3, weightKg: actualWeightKg },
      threshold,
    );
    //
    // WEIGHT is the fallback and not an afterthought: a rastamojka quote
    // needs no volume at all (`sectionParts().freight` is false, so no
    // blocker asks for one and `calc_requests.volume_m3` is nullable), and
    // measured on the real functions a volume-only rule leaves such a quote
    // with NO completeness guard whatsoever — one 300 kg prixod against a
    // 5,000 kg quote scored −94 % in green against the person who priced it
    // correctly. So: volume when there is one, weight when there is not.
    const shortPct = deviation.volumePct ?? deviation.weightPct;
    const cargoIncomplete = receiptCount > 0 && shortPct !== null && shortPct < -threshold;

    // The same fallback, for the same reason: without it a rastamojka quote
    // could have a year of shipments confirmed onto it and still be scored.
    const implausibleOf = (quoted: number | null, actual: number) =>
      quoted !== null && quoted > 0 && actual > quoted * LINK_IMPLAUSIBLE_FACTOR;
    const linkImplausible =
      receiptCount > 0 &&
      (quotedVolumeM3 !== null && quotedVolumeM3 > 0
        ? implausibleOf(quotedVolumeM3, actualVolumeM3)
        : implausibleOf(quotedWeightKg, actualWeightKg));

    const refusal = bucketRefusal({
      section,
      linkedReceipts: receiptCount,
      anyCustomsByClient: Boolean(row.any_by_client),
      cargoIncomplete,
      linkImplausible,
      // Both counts have to learn about the invisible entries, or the ladder
      // answers «nobody has typed the rastamojka» about a bill that is
      // sitting on the prixod — and «not entered yet» is a wait while
      // «entered and lost» is an error.
      entriesFound: Number(row.entries_found ?? 0) + Number(row.scoped_entries ?? 0),
      // A mapped entry counts as FOUND whether or not it reached an
      // allocation: `entries` sees only the allocated ones, so on its own it
      // would report «no cost of the right type» about a bill that is sitting
      // right there on the prixod, unconverted or unallocated.
      mappedEntries: Number(row.mapped_entries ?? 0) + Number(row.scoped_entries ?? 0),
      unconvertedEntries: Number(row.unconverted_entries ?? 0),
      unallocatedEntries: Number(row.unallocated_entries ?? 0),
    });

    const arrivedAt = row.arrived_at ? new Date(String(row.arrived_at)) : null;
    const customsPct =
      refusal === null && actualUsd !== null && quotedCustomsUsd > 0
        ? Math.round(((actualUsd - quotedCustomsUsd) / quotedCustomsUsd) * 1000) / 10
        : null;

    return {
      requestId: String(row.request_id),
      versionId: String(row.version_id),
      versionNo: Number(row.version_no),
      sealedAt: new Date(String(row.sealed_at)),
      sealedBy: String(row.sealed_by),
      sealedByName: row.sealed_by_name ? String(row.sealed_by_name) : null,
      section,
      entityType: String(row.entity_type) as 'deal' | 'lead',
      entityId: String(row.entity_id),
      clientCode: row.client_code ? String(row.client_code) : null,
      clientName: row.client_name ? String(row.client_name) : null,
      quotedVolumeM3,
      quotedWeightKg,
      actualVolumeM3,
      actualWeightKg,
      receiptCount,
      quotedCustomsUsd,
      actualCustomsUsd: refusal === null ? actualUsd : null,
      customsPct,
      refusal,
      customsOffThreshold:
        customsPct !== null && Math.abs(customsPct) > customsThreshold,
      foundCostTypes: refusal === 'no_actual_cost' ? toNames(row.found_names) : [],
      band: freightBandCheck({
        section,
        tariff: bandsAsOf(tariff, String(row.sealed_at).slice(0, 10)),
        zone: row.freight_zone ? String(row.freight_zone) : null,
        quotedMin: num(row.freight_band_min),
        quotedRate: num(row.freight_rate),
        actualWeightKg,
        actualVolumeM3,
      }),
      arrivedAt,
      settled: settledFor(arrivedAt, settleDays, now),
      warnedGroups: Number(row.warned_groups ?? 0),
      aiBlindGroups: Number(row.ai_blind_groups ?? 0),
      aiRateTakenGroups: Number(row.ai_rate_taken_groups ?? 0),
    };
  });
}

/** `currentVersionSql` under this query's own alias — same clause, one home. */
function currentVersion() {
  return sql`v.version_no = (
    SELECT max(v2.version_no) FROM calc_versions v2
     WHERE v2.request_id = v.request_id
  )`;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

const toNames = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((n) => String(n)).filter(Boolean) : [];

// ---------------------------------------------------------------------------
// The two lists the control screen is built out of, and the one number that
// makes the join get filled.
// ---------------------------------------------------------------------------

export interface CalcCoverage {
  /** Sealed in the period. */
  sealed: number;
  /** Of those, how many have at least one CONFIRMED prixod on them. */
  linked: number;
  /** Waiting for somebody to say yes or no to a guess. */
  suggested: number;
}

/**
 * How much of the month can be measured at all.
 *
 * The honest headline, and deliberately the FIRST thing on the screen: with
 * no confirmed links every other number below it is about nothing, and a
 * screen that hides that reads as «we have no errors» when it means «we have
 * no data».
 */
export async function calcCoverage(who: ActualsScope, since: Date): Promise<CalcCoverage> {
  const ownFilter = who.scope === 'own' ? sql`AND v.sealed_by = ${who.actorId}` : sql``;
  const [row] = await db.execute<{ sealed: string; linked: string; suggested: string }>(sql`
    SELECT count(*)                                              AS sealed,
           count(*) FILTER (WHERE lk.confirmed > 0)              AS linked,
           count(*) FILTER (WHERE lk.suggested > 0)              AS suggested
      FROM calc_versions v
      JOIN calc_requests r ON r.id = v.request_id
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (
                 WHERE rc.calc_link_confirmed_at IS NOT NULL
                   AND rc.status = 'confirmed' AND rc.voided_at IS NULL
               ) AS confirmed,
               count(*) FILTER (
                 WHERE rc.calc_link_confirmed_at IS NULL
                   AND rc.status = 'confirmed' AND rc.voided_at IS NULL
               ) AS suggested
          FROM receipts rc WHERE rc.calc_request_id = v.request_id
      ) lk ON true
     WHERE ${currentVersion()}
       AND ${measurableRequestSql()}
       AND v.sealed_at >= ${since.toISOString()}::timestamptz
       ${ownFilter}
  `);
  return {
    sealed: Number(row?.sealed ?? 0),
    linked: Number(row?.linked ?? 0),
    suggested: Number(row?.suggested ?? 0),
  };
}

export interface LinkSuggestion {
  receiptId: string;
  receiptNumber: string | null;
  requestId: string;
  clientCode: string | null;
  confirmedAt: Date | null;
  section: CalcSectionName;
  quotedVolumeM3: number | null;
  quotedWeightKg: number | null;
  actualVolumeM3: number;
  actualWeightKg: number;
}

/**
 * The guesses waiting for a person. This queue IS the feature: nothing below
 * it on the screen can say anything until somebody works it.
 *
 * The row prints quoted against measured, because that is the whole question
 * — «is this the cargo that quote was about?» — and a person can answer it in
 * a second from two pairs of numbers.
 */
export async function linkSuggestions(who: ActualsScope, limit = 50): Promise<LinkSuggestion[]> {
  const ownFilter = who.scope === 'own' ? sql`AND v.sealed_by = ${who.actorId}` : sql``;
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT rc.id AS receipt_id, rc.number, rc.confirmed_at,
           v.request_id, v.section, v.volume_m3, v.weight_kg,
           c.client_code,
           coalesce(m.volume_m3, 0) AS actual_volume_m3,
           coalesce(m.weight_kg, 0) AS actual_weight_kg
      FROM receipts rc
      JOIN calc_versions v ON v.request_id = rc.calc_request_id
      JOIN calc_requests r ON r.id = v.request_id
      LEFT JOIN clients c ON c.id = rc.client_id
      LEFT JOIN LATERAL (
        SELECT sum(rl.total_volume_m3) AS volume_m3, sum(rl.total_weight_kg) AS weight_kg
          FROM receipt_lots rl WHERE rl.receipt_id = rc.id
      ) m ON true
     WHERE rc.calc_link_confirmed_at IS NULL
       AND rc.status = 'confirmed'
       AND rc.voided_at IS NULL
       AND ${currentVersion()}
       ${ownFilter}
     ORDER BY rc.confirmed_at DESC
     LIMIT ${limit}
  `);
  return rows.map((row) => ({
    receiptId: String(row.receipt_id),
    receiptNumber: row.number ? String(row.number) : null,
    requestId: String(row.request_id),
    clientCode: row.client_code ? String(row.client_code) : null,
    confirmedAt: row.confirmed_at ? new Date(String(row.confirmed_at)) : null,
    section: String(row.section) as CalcSectionName,
    quotedVolumeM3: num(row.volume_m3),
    quotedWeightKg: num(row.weight_kg),
    actualVolumeM3: Number(row.actual_volume_m3 ?? 0),
    actualWeightKg: Number(row.actual_weight_kg ?? 0),
  }));
}

export interface WarnedGroup {
  requestId: string;
  versionNo: number;
  sealedAt: Date;
  sealedByName: string | null;
  entityType: 'deal' | 'lead';
  entityId: string;
  groupLabel: string;
  tnvedCode: string | null;
  /** The VED's own answer, written on the group and rendered nowhere before. */
  note: string | null;
  warnings: string[];
  confirmVia: 'single' | 'bulk' | null;
}

/**
 * What was confirmed OVER a warning, in the period.
 *
 * The list is per GROUP because that is the grain the person worked at, and
 * it carries `calc_groups.note` — which the VED has been able to write since
 * 0086 and which nothing has ever displayed. It is their answer to this
 * screen's question, already captured, at zero schema cost; and the row's
 * «Lug'atga qo'shish» link is what makes the list empty by being WORKED
 * rather than by being ignored.
 */
export async function warnedGroups(who: ActualsScope, since: Date, limit = 100): Promise<WarnedGroup[]> {
  const ownFilter = who.scope === 'own' ? sql`AND v.sealed_by = ${who.actorId}` : sql``;
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT g.request_id, g.label, g.tnved_code, g.note, g.confirmed_warnings, g.confirm_via,
           v.version_no, v.sealed_at, u.full_name AS sealed_by_name,
           r.entity_type, r.entity_id
      FROM calc_groups g
      JOIN calc_versions v ON v.request_id = g.request_id
      JOIN calc_requests r ON r.id = v.request_id
      LEFT JOIN users u ON u.id = v.sealed_by
     WHERE g.confirmed_warnings IS NOT NULL
       AND jsonb_array_length(g.confirmed_warnings) > 0
       AND ${currentVersion()}
       AND v.sealed_at >= ${since.toISOString()}::timestamptz
       ${ownFilter}
     ORDER BY v.sealed_at DESC, g.seq ASC
     LIMIT ${limit}
  `);
  return rows.map((row) => ({
    requestId: String(row.request_id),
    versionNo: Number(row.version_no),
    sealedAt: new Date(String(row.sealed_at)),
    sealedByName: row.sealed_by_name ? String(row.sealed_by_name) : null,
    entityType: String(row.entity_type) as 'deal' | 'lead',
    entityId: String(row.entity_id),
    groupLabel: String(row.label),
    tnvedCode: row.tnved_code ? String(row.tnved_code) : null,
    note: row.note ? String(row.note) : null,
    warnings: Array.isArray(row.confirmed_warnings) ? row.confirmed_warnings.map(String) : [],
    confirmVia: (row.confirm_via as 'single' | 'bulk' | null) ?? null,
  }));
}
