import { and, asc, eq, gte, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import {
  dealWonOtherCurrencySql,
  dealWonUsdSql,
  leadCurrencySql,
  leadWonOtherCurrencySql,
  leadWonUsdSql,
} from './won-money';
import { db } from '../../platform/db/client';
import { deals, dealStages, leadIntakes, leads, leadSources, leadStages, users } from '../../platform/db/schema';
import { isServerBehind } from '../../platform/db/errors';
import { addDays, calendarDay, tashkentDay, tashkentDayStart, tashkentMonthStart } from '@/modules/platform/time/tashkent';

/**
 * The sales analytics page's one fetch (round 98, owner: «dunyo standartlarida
 * qanday malumotlar tahlili bolsa hammasini hohlayman»).
 *
 * Two clocks, deliberately:
 *  - «new» is `created_at` — when the enquiry ARRIVED;
 *  - «won/lost» is `closed_at` (0076) — when it was DECIDED.
 * A lead that arrived in June and closed in July counts once in each month's
 * respective column, which is how a sales report is read anywhere.
 *
 * Everything is a handful of grouped queries merged in JS (#432): the number
 * of leads is the business growing and must never become the number of
 * round trips.
 *
 * Days are Tashkent days (R5, the owner's answer a): the period's bounds,
 * the page's presets and the trend bars must all cut midnight in the same
 * place or the same lead lands on two different days on two screens. (The
 * tasks' all-day convention, round 47, is the one clock left on UTC — it is
 * not read here.)
 */

export type Period = { from: Date; to: Date };

/**
 * The page's filters beyond the period (owner: «filterlarni maximalna qoyish
 * mumkun bolgan narsalarga qoyib ber, source sotuvchi va boshqalar»).
 *
 * The shape is deliberately NARROW — no createdFrom/createdTo can exist in
 * it. The board's filter vocabulary carries `dan/gacha` as a created_at
 * range, and on THIS screen those two names are the period, applied to two
 * different clocks; a created_at bound smuggled into the closed-clock
 * queries would silently drop every lead that arrived before the period and
 * closed inside it.
 *
 * `source`/`owner` take a uuid or the literal 'none' — «—» is a first-class
 * row in both tables (no source = hand-entered; no owner = unclaimed), so it
 * must be a first-class filter too.
 */
export type AnalyticsFilters = {
  source?: string;
  owner?: string;
  amountMin?: number;
  amountMax?: number;
  volMin?: number;
  volMax?: number;
  kgMin?: number;
  kgMax?: number;
};

/**
 * `?manba/hodim/narx_min…` → validated filters, the board vocabulary's names
 * with the board's own rules (#514: everything out of a URL is checked or
 * dropped — a garbage `hodim` reaching `eq(uuid_col, …)` is a 22P02 500, not
 * a filter). `carried` echoes ONLY the validated values serialized back, so
 * links built from it cannot walk unparseable garbage from URL to URL.
 */
export function readAnalyticsFilters(params: Record<string, string | string[] | undefined>) {
  const get = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
  };
  const num = (key: string) => {
    const text = get(key).replace(',', '.');
    if (!text) return undefined;
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const pick = (key: string) => {
    const value = get(key);
    if (value === 'none') return 'none';
    return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? value : undefined;
  };

  const filters: AnalyticsFilters = {
    source: pick('manba'),
    owner: pick('hodim'),
    amountMin: num('narx_min'),
    amountMax: num('narx_max'),
    volMin: num('kub_min'),
    volMax: num('kub_max'),
    kgMin: num('kg_min'),
    kgMax: num('kg_max'),
  };

  const carried: Record<string, string> = {};
  if (filters.source) carried.manba = filters.source;
  if (filters.owner) carried.hodim = filters.owner;
  for (const [param, value] of [
    ['narx_min', filters.amountMin],
    ['narx_max', filters.amountMax],
    ['kub_min', filters.volMin],
    ['kub_max', filters.volMax],
    ['kg_min', filters.kgMin],
    ['kg_max', filters.kgMax],
  ] as const) {
    if (value !== undefined) carried[param] = String(value);
  }

  return { ...filters, carried, active: Object.keys(carried).length };
}

/**
 * The filter, said once and heard by every lead query (#513).
 *
 * The owner branch deliberately DIFFERS from `leadBoardWhere`: the board's
 * ownerId means «mine OR unclaimed» (round 74's shared-inbox rule — work
 * routing), while here a seller's numbers are that seller's ALONE. Copy the
 * board's or() and every seller's filtered scoreboard is inflated by the
 * same unowned pile, disagreeing with their own row in the table beneath it,
 * and «Egasiz» double-counts with every name. Analytics is attribution.
 *
 * A range condition drops leads whose quote is NULL (SQL: NULL >= x is not
 * true) — the board's ranges behave identically, and «leads above 10 kub»
 * honestly cannot include a lead nobody measured.
 */
function leadFilterConds(f: AnalyticsFilters): SQL[] {
  const conds: SQL[] = [];
  if (f.owner === 'none') conds.push(isNull(leads.ownerId));
  else if (f.owner) conds.push(eq(leads.ownerId, f.owner));
  if (f.source === 'none') conds.push(isNull(leads.sourceId));
  else if (f.source) conds.push(eq(leads.sourceId, f.source));
  // A price filter is typed in dollars, so it compares dollar quotes only
  // (audit A19) — «narx ≥ 1000» would otherwise match every so'm quote.
  if (f.amountMin !== undefined) conds.push(sql`(${leadCurrencySql()} = 'USD' AND ${leads.quotedAmount} >= ${f.amountMin})`);
  if (f.amountMax !== undefined) conds.push(sql`(${leadCurrencySql()} = 'USD' AND ${leads.quotedAmount} <= ${f.amountMax})`);
  if (f.volMin !== undefined) conds.push(sql`${leads.quotedVolumeM3} >= ${f.volMin}`);
  if (f.volMax !== undefined) conds.push(sql`${leads.quotedVolumeM3} <= ${f.volMax}`);
  if (f.kgMin !== undefined) conds.push(sql`${leads.quotedWeightKg} >= ${f.kgMin}`);
  if (f.kgMax !== undefined) conds.push(sql`${leads.quotedWeightKg} <= ${f.kgMax}`);
  return conds;
}

/** The deals' halves of the same filters. A deal carries no source at all. */
function dealFilterConds(f: AnalyticsFilters): SQL[] {
  const conds: SQL[] = [];
  if (f.owner === 'none') conds.push(isNull(deals.ownerId));
  else if (f.owner) conds.push(eq(deals.ownerId, f.owner));
  if (f.amountMin !== undefined) conds.push(sql`(${deals.quotedCurrency} = 'USD' AND ${deals.quotedAmount} >= ${f.amountMin})`);
  if (f.amountMax !== undefined) conds.push(sql`(${deals.quotedCurrency} = 'USD' AND ${deals.quotedAmount} <= ${f.amountMax})`);
  if (f.volMin !== undefined) conds.push(sql`${deals.quotedVolumeM3} >= ${f.volMin}`);
  if (f.volMax !== undefined) conds.push(sql`${deals.quotedVolumeM3} <= ${f.volMax}`);
  if (f.kgMin !== undefined) conds.push(sql`${deals.quotedWeightKg} >= ${f.kgMin}`);
  if (f.kgMax !== undefined) conds.push(sql`${deals.quotedWeightKg} <= ${f.kgMax}`);
  return conds;
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

function money(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

export type SalesAnalytics = Awaited<ReturnType<typeof salesAnalytics>>;

/** The ARRIVAL clock (`created_at`) over a period, under the filters. */
function arrivedWhere({ from, to }: Period, f: AnalyticsFilters) {
  return and(gte(leads.createdAt, from), lt(leads.createdAt, to), ...leadFilterConds(f));
}

/** The DECISION clock (`closed_at`, 0076) over a period, under the filters. */
function decidedWhere({ from, to }: Period, f: AnalyticsFilters) {
  return and(isNotNull(leads.closedAt), gte(leads.closedAt, from), lt(leads.closedAt, to), ...leadFilterConds(f));
}

/**
 * Leads that ARRIVED in the period — the scoreboard's «Yangi» cell, and the
 * dashboard's funnel line (O13). `salesAnalytics` calls this rather than
 * holding its own copy, so the tahlil screen and the dashboard it links to
 * cannot print two numbers for one period.
 */
export async function leadArrivals(period: Period, f: AnalyticsFilters = {}): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(arrivedWhere(period, f));
  return Number(row?.n ?? 0);
}

export interface LeadDecisions {
  won: number;
  lost: number;
  /** Won quotes in dollars only (`won-money.ts`, audit A19). */
  wonUsd: number;
  /** Won leads quoted in another currency — counted, never added to the dollars. */
  wonOther: number;
  /** Arrival → decision, averaged over the WON ones, in days to one decimal. */
  cycleDays: number;
}

/**
 * Decisions in the period: the win rate's denominator, the won money, and
 * the cycle — arrival to decision, the only honest «how fast do we sell»
 * there is (averaged over WON: a lost lead's speed is not a speed anybody
 * wants more of). The scoreboard's decided cells, shared with the dashboard
 * (O13) the way `leadArrivals` is.
 */
export async function leadDecisions(period: Period, f: AnalyticsFilters = {}): Promise<LeadDecisions> {
  const [row] = await db
    .select({
      won: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'won')`,
      lost: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'lost')`,
      wonUsd: leadWonUsdSql(),
      wonOther: leadWonOtherCurrencySql(),
      cycleDays: sql<string>`coalesce(avg(extract(epoch from ${leads.closedAt} - ${leads.createdAt})) FILTER (WHERE ${leadStages.kind} = 'won'), 0)`,
    })
    .from(leads)
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .where(decidedWhere(period, f));
  return {
    won: Number(row?.won ?? 0),
    lost: Number(row?.lost ?? 0),
    wonUsd: money(row?.wonUsd),
    wonOther: Number(row?.wonOther ?? 0),
    cycleDays: Math.round((Number(row?.cycleDays ?? 0) / 86400) * 10) / 10,
  };
}

/**
 * Won/lost by the DECISION clock, for the admin home (round 107). The same
 * predicate as the scoreboard's `decided` cell above and — since round 107
 * moved it — `salesSnapshot`'s month counts: `closed_at` + the stage's kind,
 * never `updated_at` (round 98's two clocks). It IS `leadDecisions` with no
 * filters, in the admin home's field names — one lean query, because the home
 * page is the most-opened screen and `salesAnalytics` is ~14.
 *
 * `wonUsd` is dollars only (`won-money.ts`): this comment used to call the
 * sum safe unfiltered because «a lead's quote is USD-only», and the lead form
 * offers UZS and CNY — audit A19.
 */
export async function decidedLeadCounts(from: Date, to: Date) {
  const decided = await leadDecisions({ from, to });
  return {
    won: decided.won,
    lost: decided.lost,
    wonUsd: decided.wonUsd,
    wonOtherCurrency: decided.wonOther,
  };
}

export interface DecidedMonth {
  month: string;
  won: number;
  lost: number;
  wonUsd: number;
  wonOtherCurrency: number;
  /** Days 1..mtdDay of that month only — the like-for-like comparison. */
  wonMtd: number;
  lostMtd: number;
  wonUsdMtd: number;
}

/**
 * `decidedLeadCounts`, one row per Tashkent month over a window, in ONE
 * statement — the dashboard's 12-month won trend and its «vs the same days
 * last month» (the `*Mtd` columns) without twelve round trips. Same clock
 * (`closed_at`), same predicate, same dollars-only rule: each row equals
 * `decidedLeadCounts` over that month, and a test says so.
 */
export async function decidedLeadsByMonth(from: Date, to: Date, mtdDay = 31): Promise<DecidedMonth[]> {
  const monthExpr = sql`to_char(${leads.closedAt} AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM')`;
  const dom = sql`extract(day FROM ${leads.closedAt} AT TIME ZONE 'Asia/Tashkent') <= ${mtdDay}`;
  const rows = await db
    .select({
      month: sql<string>`${monthExpr}`,
      won: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'won')`,
      lost: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'lost')`,
      wonUsd: leadWonUsdSql(),
      wonOther: leadWonOtherCurrencySql(),
      wonMtd: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'won' AND ${dom})`,
      lostMtd: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'lost' AND ${dom})`,
      wonUsdMtd: leadWonUsdSql(dom),
    })
    .from(leads)
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .where(and(isNotNull(leads.closedAt), gte(leads.closedAt, from), lt(leads.closedAt, to)))
    .groupBy(monthExpr)
    .orderBy(monthExpr);
  return rows.map((row) => ({
    month: row.month,
    won: Number(row.won),
    lost: Number(row.lost),
    wonUsd: money(row.wonUsd),
    wonOtherCurrency: Number(row.wonOther),
    wonMtd: Number(row.wonMtd),
    lostMtd: Number(row.lostMtd),
    wonUsdMtd: money(row.wonUsdMtd),
  }));
}

/** One seller's «Birinchi aloqa» cell. */
export interface FirstContactStat {
  /** Median minutes from the clock to the first contact, over the contacted. */
  medianMinutes: number | null;
  /** How many arrivals that median covers. */
  measured: number;
  /** Arrivals first reached more than an hour / a day after the clock — or not yet. */
  lateHour: number;
  lateDay: number;
}

/**
 * How fast each seller first reached their advert leads (0113, the owner's
 * 5a) — the sellers table's «Birinchi aloqa» column.
 *
 * Keyed on the arrival's `assigned_user_id` — whom it was HANDED to — and not
 * on today's `leads.owner_id`: a lead reassigned after its deadline must not
 * move that missed deadline onto the person who inherited it. That is a
 * different key from the rest of the row (the table counts by owner), so the
 * cell prints how many arrivals it covers, and a seller whose only advert
 * lead was later handed away still gets a row carrying just this figure
 * (design judge, 15).
 *
 * Only `created` arrivals with a clock: a joined re-enquiry is the same
 * person again, and everything before 0113 has no clock to measure from.
 * The median covers the CONTACTED ones, in minutes from the clock (office
 * time — a lead that landed at 23:00 starts at 09:00); the late counts also
 * take the still-untouched, whose wait runs until «now» — but only while
 * their lead is still OPEN. A lead decided without anybody reaching it (the
 * office moving spam to lost) stopped waiting the moment it was decided, so
 * its wait ends at `closed_at`: the reminder stops asking about a decided
 * lead (`claimUntouched`), and the seller's «late» figure must not go on
 * counting one for ever. A closed lead with no `closed_at` (older than the
 * column) has no known end and is counted by nothing. `extract(epoch …)`
 * because `percentile_cont` over an interval hands back TEXT and
 * `Number('00:12:30')` is NaN (design judge, 13).
 */
export async function firstContactBySeller(
  { from, to }: Period,
  f: AnalyticsFilters = {},
  now: Date = new Date(),
): Promise<Map<string | null, FirstContactStat>> {
  const at = now.toISOString();
  // The seller filter names the person the arrival was HANDED to, for the
  // reason above; every other filter is the lead's, through the shared conds.
  const seller =
    f.owner === 'none'
      ? isNull(leadIntakes.assignedUserId)
      : f.owner
        ? eq(leadIntakes.assignedUserId, f.owner)
        : undefined;
  const waitedUntil = sql`coalesce(${leadIntakes.contactedAt}, CASE WHEN ${leadStages.kind} = 'open' THEN ${at}::timestamptz ELSE ${leads.closedAt} END)`;
  const waited = sql`${waitedUntil} - ${leadIntakes.contactClockAt}`;
  const rows = await db
    .select({
      assignedUserId: leadIntakes.assignedUserId,
      median: sql<string | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM greatest(interval '0', ${leadIntakes.contactedAt} - ${leadIntakes.contactClockAt})) / 60) FILTER (WHERE ${leadIntakes.contactedAt} IS NOT NULL)`,
      measured: sql<number>`count(*) FILTER (WHERE ${leadIntakes.contactedAt} IS NOT NULL)`,
      lateHour: sql<number>`count(*) FILTER (WHERE ${waited} > interval '1 hour')`,
      lateDay: sql<number>`count(*) FILTER (WHERE ${waited} > interval '24 hours')`,
    })
    .from(leadIntakes)
    .innerJoin(leads, eq(leads.id, leadIntakes.leadId))
    .innerJoin(leadStages, eq(leadStages.id, leads.stageId))
    .where(
      and(
        eq(leadIntakes.outcome, 'created'),
        isNotNull(leadIntakes.contactClockAt),
        gte(leadIntakes.createdAt, from),
        lt(leadIntakes.createdAt, to),
        seller,
        ...leadFilterConds({ ...f, owner: undefined }),
      ),
    )
    .groupBy(leadIntakes.assignedUserId);
  return new Map(
    rows.map((row) => [
      row.assignedUserId,
      {
        medianMinutes: row.median === null ? null : Math.round(Number(row.median)),
        measured: Number(row.measured),
        lateHour: Number(row.lateHour),
        lateDay: Number(row.lateDay),
      },
    ]),
  );
}

export async function salesAnalytics(period: Period, f: AnalyticsFilters = {}) {
  const { from, to } = period;
  const extra = leadFilterConds(f);
  const created = arrivedWhere(period, f);
  const closed = decidedWhere(period, f);
  // The snapshots (open now, funnel) take the filters but deliberately not
  // the period — «what is in hand» has no date range.
  const openWhere = and(eq(leadStages.kind, 'open'), ...extra);
  // A deal has no source column: under a source filter the block would be
  // numbers that ignore the active filter, which is read as filtered. It is
  // hidden instead, and the page says why.
  const dealsApply = !f.source;

  const [arrived, decided, openNow, perDayNew, perDayWon, sourceNew, sourceDecided, sellerNew, sellerDecided, sellerOpen, reasons, stageRows, dealsRow, people, firstContact] =
    await Promise.all([
      // Arrivals in the period (who they came from rides in sourceNew), and
      // the decisions — the dashboard reads these two same functions (O13).
      leadArrivals(period, f),
      leadDecisions(period, f),

      db
        .select({ n: sql<number>`count(*)` })
        .from(leads)
        .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
        .where(openWhere),

      // The trend: arrivals and wins per Tashkent day, drawn as bars.
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${leads.createdAt} AT TIME ZONE 'Asia/Tashkent'), 'YYYY-MM-DD')`,
          n: sql<number>`count(*)`,
        })
        .from(leads)
        .where(created)
        .groupBy(sql`1`)
        .orderBy(sql`1`),

      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${leads.closedAt} AT TIME ZONE 'Asia/Tashkent'), 'YYYY-MM-DD')`,
          n: sql<number>`count(*)`,
        })
        .from(leads)
        .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
        .where(and(closed, eq(leadStages.kind, 'won')))
        .groupBy(sql`1`)
        .orderBy(sql`1`),

      // Grouped by ID beside the name: the id is what a row's filter link
      // carries, and grouping by name alone would fold two renamed sources'
      // histories into one row.
      db
        .select({
          id: leads.sourceId,
          name: sql<string>`coalesce(${leadSources.name}, '—')`,
          n: sql<number>`count(*)`,
        })
        .from(leads)
        .leftJoin(leadSources, eq(leads.sourceId, leadSources.id))
        .where(created)
        .groupBy(leads.sourceId, sql`2`),

      db
        .select({
          id: leads.sourceId,
          name: sql<string>`coalesce(${leadSources.name}, '—')`,
          won: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'won')`,
          lost: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'lost')`,
          wonUsd: leadWonUsdSql(),
        })
        .from(leads)
        .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
        .leftJoin(leadSources, eq(leads.sourceId, leadSources.id))
        .where(closed)
        .groupBy(leads.sourceId, sql`2`),

      // The sellers' table. `owner_id` NULL is a real row — an unclaimed lead
      // is nobody's work and hiding it would make the totals disagree with
      // the scoreboard above.
      db
        .select({ ownerId: leads.ownerId, n: sql<number>`count(*)` })
        .from(leads)
        .where(created)
        .groupBy(leads.ownerId),

      db
        .select({
          ownerId: leads.ownerId,
          won: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'won')`,
          lost: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'lost')`,
          wonUsd: leadWonUsdSql(),
          cycleDays: sql<string>`coalesce(avg(extract(epoch from ${leads.closedAt} - ${leads.createdAt})) FILTER (WHERE ${leadStages.kind} = 'won'), 0)`,
        })
        .from(leads)
        .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
        .where(closed)
        .groupBy(leads.ownerId),

      db
        .select({ ownerId: leads.ownerId, n: sql<number>`count(*)` })
        .from(leads)
        .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
        .where(openWhere)
        .groupBy(leads.ownerId),

      // Why we lose — grouped on the recorded TEXT, which after 0076 is a
      // dictionary label; older free-text reasons keep their own rows rather
      // than being folded into a guess.
      db
        .select({
          reason: sql<string>`coalesce(nullif(trim(${leads.lostReason}), ''), '—')`,
          n: sql<number>`count(*)`,
        })
        .from(leads)
        .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
        .where(and(closed, eq(leadStages.kind, 'lost')))
        .groupBy(sql`1`)
        .orderBy(sql`count(*) DESC`),

      // Where the OPEN work sits right now — a snapshot, deliberately not
      // period-bound: the funnel today is the answer to «what is in hand».
      // The filters ride in the JOIN, not the WHERE: an empty stage must
      // keep its row, or a narrow filter makes columns vanish instead of
      // reading zero.
      db
        .select({
          id: leadStages.id,
          name: leadStages.name,
          color: leadStages.color,
          n: sql<number>`count(${leads.id})`,
        })
        .from(leadStages)
        .leftJoin(leads, and(eq(leads.stageId, leadStages.id), ...extra))
        .where(eq(leadStages.kind, 'open'))
        .groupBy(leadStages.id, leadStages.name, leadStages.color, leadStages.sortOrder)
        .orderBy(asc(leadStages.sortOrder), asc(leadStages.name)),

      // The deals' half of the same month: jobs decided, and the agreed
      // service price they carried. Quoted money, not the ledger — the charge
      // engine owns real revenue and `dealProfit` already reports it.
      // The OR wears its own parentheses: and() embeds members verbatim, so
      // a bare `open OR closed` ANDed with a filter renders
      // `(filter AND open) OR closed` — measured, not assumed — and the WON
      // cells quietly count the whole company while the open cell looks
      // filtered.
      dealsApply
        ? db
            .select({
              won: sql<number>`count(*) FILTER (WHERE ${dealStages.kind} = 'won')`,
              lost: sql<number>`count(*) FILTER (WHERE ${dealStages.kind} = 'lost')`,
              wonUsd: dealWonUsdSql(),
              wonOther: dealWonOtherCurrencySql(),
              open: sql<number>`count(*) FILTER (WHERE ${dealStages.kind} NOT IN ('won','lost'))`,
            })
            .from(deals)
            .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
            .where(
              and(
                ...dealFilterConds(f),
                sql`((${dealStages.kind} NOT IN ('won','lost')) OR (${deals.closedAt} >= ${from.toISOString()}::timestamptz AND ${deals.closedAt} < ${to.toISOString()}::timestamptz))`,
              ),
            )
        : Promise.resolve([]),

      db
        .select({ id: users.id, name: users.fullName })
        .from(users),

      // Soft: on a database one migration behind (0113) the column reads «—»
      // and the rest of the page stands.
      firstContactBySeller(period, f).catch((err: unknown) => {
        if (isServerBehind(err)) return null;
        throw err;
      }),
    ]);

  const nameOf = new Map(people.map((p) => [p.id, p.name]));

  const sellers = new Map<
    string,
    {
      id: string | null;
      name: string;
      fresh: number;
      won: number;
      lost: number;
      wonUsd: number;
      cycleDays: number;
      open: number;
      firstContact: FirstContactStat | null;
    }
  >();
  const seller = (ownerId: string | null) => {
    const key = ownerId ?? '';
    let row = sellers.get(key);
    if (!row) {
      row = {
        id: ownerId,
        name: ownerId ? (nameOf.get(ownerId) ?? '?') : '—',
        fresh: 0,
        won: 0,
        lost: 0,
        wonUsd: 0,
        cycleDays: 0,
        open: 0,
        firstContact: null,
      };
      sellers.set(key, row);
    }
    return row;
  };
  for (const row of sellerNew) seller(row.ownerId).fresh = Number(row.n);
  for (const row of sellerDecided) {
    const s = seller(row.ownerId);
    s.won = Number(row.won);
    s.lost = Number(row.lost);
    s.wonUsd = money(row.wonUsd);
    s.cycleDays = Math.round((Number(row.cycleDays) / 86400) * 10) / 10;
  }
  for (const row of sellerOpen) seller(row.ownerId).open = Number(row.n);
  // May CREATE a row: a seller measured on arrivals later handed to others.
  for (const [assignedUserId, stat] of firstContact ?? []) seller(assignedUserId).firstContact = stat;

  const sources = new Map<
    string,
    { id: string | null; name: string; fresh: number; won: number; lost: number; wonUsd: number }
  >();
  const source = (id: string | null, name: string) => {
    const key = id ?? '';
    let row = sources.get(key);
    if (!row) {
      row = { id, name, fresh: 0, won: 0, lost: 0, wonUsd: 0 };
      sources.set(key, row);
    }
    return row;
  };
  for (const row of sourceNew) source(row.id, row.name).fresh = Number(row.n);
  for (const row of sourceDecided) {
    const s = source(row.id, row.name);
    s.won = Number(row.won);
    s.lost = Number(row.lost);
    s.wonUsd = money(row.wonUsd);
  }

  const { won, lost } = decided;
  const stageTotal = stageRows.reduce((sum, row) => sum + Number(row.n), 0);
  const d = dealsRow[0];

  return {
    totals: {
      fresh: arrived,
      won,
      lost,
      winRate: pct(won, won + lost),
      wonUsd: decided.wonUsd,
      wonOtherCurrency: decided.wonOther,
      cycleDays: decided.cycleDays,
      open: Number(openNow[0]?.n ?? 0),
    },
    perDay: (() => {
      // One row per day that saw EITHER an arrival or a win — a period's
      // quiet days are dropped rather than drawn as 90 empty slots.
      const days = new Map<string, { day: string; fresh: number; won: number }>();
      const at = (day: string) => {
        let row = days.get(day);
        if (!row) {
          row = { day, fresh: 0, won: 0 };
          days.set(day, row);
        }
        return row;
      };
      for (const row of perDayNew) at(row.day).fresh = Number(row.n);
      for (const row of perDayWon) at(row.day).won = Number(row.n);
      return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
    })(),
    sources: [...sources.values()]
      .map((row) => ({ ...row, winRate: pct(row.won, row.won + row.lost) }))
      .sort((a, b) => b.fresh - a.fresh || b.won - a.won),
    sellers: [...sellers.values()].sort((a, b) => b.won - a.won || b.fresh - a.fresh),
    lostReasons: reasons.map((row) => ({ reason: row.reason, n: Number(row.n), share: pct(Number(row.n), lost) })),
    stages: stageRows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      n: Number(row.n),
      share: pct(Number(row.n), stageTotal),
    })),
    // null = «a deal has no source, so this block has no honest answer under
    // a source filter» — the page prints the sentence instead of numbers.
    deals: dealsApply
      ? {
          won: Number(d?.won ?? 0),
          lost: Number(d?.lost ?? 0),
          wonUsd: money(d?.wonUsd),
          wonOtherCurrency: Number(d?.wonOther ?? 0),
          open: Number(d?.open ?? 0),
          winRate: pct(Number(d?.won ?? 0), Number(d?.won ?? 0) + Number(d?.lost ?? 0)),
        }
      : null,
  };
}

/**
 * `?dan=YYYY-MM-DD&gacha=YYYY-MM-DD` → the period, validated the board
 * filters' way (#514: everything out of a URL is checked or dropped). The
 * screen's `gacha` is INCLUSIVE — a person asking «up to the 12th» means the
 * 12th's evening — so the query bound is the next midnight, exclusive.
 * Default: the current month, in Tashkent — and every bound is a TASHKENT
 * midnight (R5): a lead won at 02:00 on the 1st belongs to the new month,
 * not the old one. An impossible calendar day ('2026-02-30') is DROPPED, not parsed:
 * V8 quietly rolls it over to March 2nd, so without the round-trip check a
 * typo'd date read as a silently shifted period.
 */
export function readPeriod(
  params: { dan?: string; gacha?: string },
  now: Date = new Date(),
): Period & { dan: string; gacha: string } {
  // The shared calendar reader (U43) — it also drops year 0000, which V8
  // round-trips and postgres refuses.
  const dayOf = (value: string | undefined) => calendarDay(value) ?? undefined;

  const dan = dayOf(params.dan) ?? tashkentMonthStart(now);
  let gacha = dayOf(params.gacha) ?? tashkentDay(now);
  if (gacha < dan) gacha = dan;

  return {
    from: tashkentDayStart(dan),
    to: tashkentDayStart(addDays(gacha, 1)),
    dan,
    gacha,
  };
}
