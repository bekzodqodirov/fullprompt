import { and, asc, eq, gte, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { deals, dealStages, leads, leadSources, leadStages, users } from '../../platform/db/schema';

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
 * Days are UTC days — the house convention (round 47): `/bugun`, `parseDue`
 * and the trend here must all cut midnight in the same place or the same
 * lead lands on two different days on two screens.
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
  if (f.amountMin !== undefined) conds.push(sql`${leads.quotedAmount} >= ${f.amountMin}`);
  if (f.amountMax !== undefined) conds.push(sql`${leads.quotedAmount} <= ${f.amountMax}`);
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
  if (f.amountMin !== undefined) conds.push(sql`${deals.quotedAmount} >= ${f.amountMin}`);
  if (f.amountMax !== undefined) conds.push(sql`${deals.quotedAmount} <= ${f.amountMax}`);
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

/**
 * Won/lost by the DECISION clock, for the admin home (round 107). The same
 * predicate as the scoreboard's `decided` cell above and — since round 107
 * moved it — `salesSnapshot`'s month counts: `closed_at` + the stage's kind,
 * never `updated_at` (round 98's two clocks). One lean query, because the
 * home page is the most-opened screen and `salesAnalytics` is ~14.
 *
 * `wonUsd` is safe unfiltered here: a LEAD's quote currency is USD-only when
 * priced (round 71) — unlike deals, where the sum must filter.
 */
export async function decidedLeadCounts(from: Date, to: Date) {
  const [row] = await db
    .select({
      won: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'won')`,
      lost: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'lost')`,
      wonUsd: sql<string>`coalesce(sum(${leads.quotedAmount}) FILTER (WHERE ${leadStages.kind} = 'won'), 0)`,
    })
    .from(leads)
    .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
    .where(and(isNotNull(leads.closedAt), gte(leads.closedAt, from), lt(leads.closedAt, to)));
  return {
    won: Number(row?.won ?? 0),
    lost: Number(row?.lost ?? 0),
    wonUsd: money(row?.wonUsd),
  };
}

export async function salesAnalytics({ from, to }: Period, f: AnalyticsFilters = {}) {
  const extra = leadFilterConds(f);
  const created = and(gte(leads.createdAt, from), lt(leads.createdAt, to), ...extra);
  const closed = and(
    isNotNull(leads.closedAt),
    gte(leads.closedAt, from),
    lt(leads.closedAt, to),
    ...extra,
  );
  // The snapshots (open now, funnel) take the filters but deliberately not
  // the period — «what is in hand» has no date range.
  const openWhere = and(eq(leadStages.kind, 'open'), ...extra);
  // A deal has no source column: under a source filter the block would be
  // numbers that ignore the active filter, which is read as filtered. It is
  // hidden instead, and the page says why.
  const dealsApply = !f.source;

  const [arrived, decided, openNow, perDayNew, perDayWon, sourceNew, sourceDecided, sellerNew, sellerDecided, sellerOpen, reasons, stageRows, dealsRow, people] =
    await Promise.all([
      // Arrivals in the period, and who they came from rides in sourceNew.
      db.select({ n: sql<number>`count(*)` }).from(leads).where(created),

      // Decisions in the period: the win rate's denominator, the won money,
      // and the cycle — arrival to decision, the only honest «how fast do we
      // sell» there is (average over WON: a lost lead's speed is not a speed
      // anybody wants more of).
      db
        .select({
          won: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'won')`,
          lost: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'lost')`,
          wonUsd: sql<string>`coalesce(sum(${leads.quotedAmount}) FILTER (WHERE ${leadStages.kind} = 'won'), 0)`,
          cycleDays: sql<string>`coalesce(avg(extract(epoch from ${leads.closedAt} - ${leads.createdAt})) FILTER (WHERE ${leadStages.kind} = 'won'), 0)`,
        })
        .from(leads)
        .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
        .where(closed),

      db
        .select({ n: sql<number>`count(*)` })
        .from(leads)
        .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
        .where(openWhere),

      // The trend: arrivals and wins per UTC day, drawn as bars.
      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${leads.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
          n: sql<number>`count(*)`,
        })
        .from(leads)
        .where(created)
        .groupBy(sql`1`)
        .orderBy(sql`1`),

      db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${leads.closedAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
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
          wonUsd: sql<string>`coalesce(sum(${leads.quotedAmount}) FILTER (WHERE ${leadStages.kind} = 'won'), 0)`,
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
          wonUsd: sql<string>`coalesce(sum(${leads.quotedAmount}) FILTER (WHERE ${leadStages.kind} = 'won'), 0)`,
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
              wonUsd: sql<string>`coalesce(sum(${deals.quotedAmount}) FILTER (WHERE ${dealStages.kind} = 'won'), 0)`,
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
    ]);

  const nameOf = new Map(people.map((p) => [p.id, p.name]));

  const sellers = new Map<
    string,
    { id: string | null; name: string; fresh: number; won: number; lost: number; wonUsd: number; cycleDays: number; open: number }
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

  const won = Number(decided[0]?.won ?? 0);
  const lost = Number(decided[0]?.lost ?? 0);
  const stageTotal = stageRows.reduce((sum, row) => sum + Number(row.n), 0);
  const d = dealsRow[0];

  return {
    totals: {
      fresh: Number(arrived[0]?.n ?? 0),
      won,
      lost,
      winRate: pct(won, won + lost),
      wonUsd: money(decided[0]?.wonUsd),
      cycleDays: Math.round((Number(decided[0]?.cycleDays ?? 0) / 86400) * 10) / 10,
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
 * Default: the current UTC month. An impossible calendar day ('2026-02-30')
 * is DROPPED, not parsed: V8 quietly rolls it over to March 2nd, so without
 * the round-trip check a typo'd date read as a silently shifted period.
 */
export function readPeriod(params: { dan?: string; gacha?: string }): Period & { dan: string; gacha: string } {
  const dayOf = (value: string | undefined) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
      ? parsed
      : undefined;
  };
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const fromDay = dayOf(params.dan) ?? monthStart;
  let toDay = dayOf(params.gacha) ?? today;
  if (toDay < fromDay) toDay = fromDay;

  return {
    from: fromDay,
    to: new Date(toDay.getTime() + 86_400_000),
    dan: fromDay.toISOString().slice(0, 10),
    gacha: toDay.toISOString().slice(0, 10),
  };
}
