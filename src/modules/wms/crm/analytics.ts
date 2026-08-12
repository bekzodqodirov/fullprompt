import { and, asc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
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

function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

function money(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

export type SalesAnalytics = Awaited<ReturnType<typeof salesAnalytics>>;

export async function salesAnalytics({ from, to }: Period) {
  const created = and(gte(leads.createdAt, from), lt(leads.createdAt, to));
  const closed = and(
    isNotNull(leads.closedAt),
    gte(leads.closedAt, from),
    lt(leads.closedAt, to),
  );

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
        .where(eq(leadStages.kind, 'open')),

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

      db
        .select({
          name: sql<string>`coalesce(${leadSources.name}, '—')`,
          n: sql<number>`count(*)`,
        })
        .from(leads)
        .leftJoin(leadSources, eq(leads.sourceId, leadSources.id))
        .where(created)
        .groupBy(sql`1`),

      db
        .select({
          name: sql<string>`coalesce(${leadSources.name}, '—')`,
          won: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'won')`,
          lost: sql<number>`count(*) FILTER (WHERE ${leadStages.kind} = 'lost')`,
          wonUsd: sql<string>`coalesce(sum(${leads.quotedAmount}) FILTER (WHERE ${leadStages.kind} = 'won'), 0)`,
        })
        .from(leads)
        .innerJoin(leadStages, eq(leads.stageId, leadStages.id))
        .leftJoin(leadSources, eq(leads.sourceId, leadSources.id))
        .where(closed)
        .groupBy(sql`1`),

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
        .where(eq(leadStages.kind, 'open'))
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
      db
        .select({
          id: leadStages.id,
          name: leadStages.name,
          color: leadStages.color,
          n: sql<number>`count(${leads.id})`,
        })
        .from(leadStages)
        .leftJoin(leads, eq(leads.stageId, leadStages.id))
        .where(eq(leadStages.kind, 'open'))
        .groupBy(leadStages.id, leadStages.name, leadStages.color, leadStages.sortOrder)
        .orderBy(asc(leadStages.sortOrder), asc(leadStages.name)),

      // The deals' half of the same month: jobs decided, and the agreed
      // service price they carried. Quoted money, not the ledger — the charge
      // engine owns real revenue and `dealProfit` already reports it.
      db
        .select({
          won: sql<number>`count(*) FILTER (WHERE ${dealStages.kind} = 'won')`,
          lost: sql<number>`count(*) FILTER (WHERE ${dealStages.kind} = 'lost')`,
          wonUsd: sql<string>`coalesce(sum(${deals.quotedAmount}) FILTER (WHERE ${dealStages.kind} = 'won'), 0)`,
          open: sql<number>`count(*) FILTER (WHERE ${dealStages.kind} NOT IN ('won','lost'))`,
        })
        .from(deals)
        .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
        .where(
          sql`(${dealStages.kind} NOT IN ('won','lost')) OR (${deals.closedAt} >= ${from.toISOString()}::timestamptz AND ${deals.closedAt} < ${to.toISOString()}::timestamptz)`,
        ),

      db
        .select({ id: users.id, name: users.fullName })
        .from(users),
    ]);

  const nameOf = new Map(people.map((p) => [p.id, p.name]));

  const sellers = new Map<
    string,
    { name: string; fresh: number; won: number; lost: number; wonUsd: number; cycleDays: number; open: number }
  >();
  const seller = (ownerId: string | null) => {
    const key = ownerId ?? '';
    let row = sellers.get(key);
    if (!row) {
      row = {
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

  const sources = new Map<string, { name: string; fresh: number; won: number; lost: number; wonUsd: number }>();
  const source = (name: string) => {
    let row = sources.get(name);
    if (!row) {
      row = { name, fresh: 0, won: 0, lost: 0, wonUsd: 0 };
      sources.set(name, row);
    }
    return row;
  };
  for (const row of sourceNew) source(row.name).fresh = Number(row.n);
  for (const row of sourceDecided) {
    const s = source(row.name);
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
    deals: {
      won: Number(d?.won ?? 0),
      lost: Number(d?.lost ?? 0),
      wonUsd: money(d?.wonUsd),
      open: Number(d?.open ?? 0),
      winRate: pct(Number(d?.won ?? 0), Number(d?.won ?? 0) + Number(d?.lost ?? 0)),
    },
  };
}

/**
 * `?dan=YYYY-MM-DD&gacha=YYYY-MM-DD` → the period, validated the board
 * filters' way (#514: everything out of a URL is checked or dropped). The
 * screen's `gacha` is INCLUSIVE — a person asking «up to the 12th» means the
 * 12th's evening — so the query bound is the next midnight, exclusive.
 * Default: the current UTC month.
 */
export function readPeriod(params: { dan?: string; gacha?: string }): Period & { dan: string; gacha: string } {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const fromDay = params.dan && DAY.test(params.dan) ? new Date(`${params.dan}T00:00:00Z`) : monthStart;
  let toDay = params.gacha && DAY.test(params.gacha) ? new Date(`${params.gacha}T00:00:00Z`) : today;
  if (Number.isNaN(fromDay.getTime())) return readPeriod({});
  if (Number.isNaN(toDay.getTime()) || toDay < fromDay) toDay = fromDay;

  return {
    from: fromDay,
    to: new Date(toDay.getTime() + 86_400_000),
    dan: fromDay.toISOString().slice(0, 10),
    gacha: toDay.toISOString().slice(0, 10),
  };
}
