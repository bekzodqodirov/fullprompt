import type PgBoss from 'pg-boss';
import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { logger } from '../../platform/logger';
import { getSetting } from '../../platform/settings/service';
import { tashkentMonth } from '../../platform/time/tashkent';
import { usersWithRoles } from '../../platform/notifications/service';
import { queueGroupPost, requeueSkippedGroupPost } from '../../platform/telegram/staff-group-posts';
import type { Hero } from './celebrate-text';
import { stampedCargo, unstampedCargo } from './cargo';
import { monthRange } from './month';
import {
  firstPlaceStreak,
  isPersonalRecord,
  previousMonth,
  previousWindow,
  rankStandings,
  ratingWindowEnding,
  runningWindow,
  type PostedWeek,
  type RatingWindow,
  type Standing,
} from './rating-math';
import { championHtml, kub, ratingHtml, type FtlLine, type RatingView } from './rating-text';
import { KPI_LOAD } from '../ftl/sql';

/**
 * The staff group's Saturday rating and the month's champion (0134, the
 * owner, 2026-10-20: «hafta ohirida har shanba soat 18:00 da hodimlar reytingi
 * … kim necha kub necha kg yuk olib kelgani … kim kop yuk olib kelishga
 * undashimiz kerak»).
 *
 * THE ONE READ is the KPI's own: `stampedCargo` — the receipt's seller stamp,
 * carton grain, confirmed prixods, `received_at` (#1211-#1212). So the rating,
 * /hodimlar's KPI, the profile's «Bu oy» and the seller report can never
 * disagree about who brought what (#513); there is no second aggregate here.
 */

const JOB_STAFF_RATING = 'staff-group.rating';
const JOB_STAFF_CHAMPION = 'staff-group.champion';

/** Names and Telegram users for everybody on a list, in one read. */
async function heroesFor(ids: string[]): Promise<Map<string, Hero>> {
  const out = new Map<string, Hero>();
  if (ids.length === 0) return out;
  const rows = await db.execute<{ id: string; full_name: string; tg: string | null }>(sql`
    SELECT u.id::text AS id, u.full_name,
           CASE WHEN l.status = 'linked' THEN l.telegram_chat_id::text END AS tg
      FROM users u
      LEFT JOIN telegram_links l ON l.user_id = u.id
     WHERE u.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  for (const row of rows) out.set(row.id, { name: row.full_name, telegramUserId: row.tg });
  return out;
}

/**
 * The ranked standings — LTL cargo only (0135, his 3b: FTL «alohida qatorda
 * … ochkosiz»): the rating is the KPI's competition, and the KPI does not
 * count a whole truck. The KPI's own constant, so the two cannot drift.
 */
async function standingsFor(w: { from: Date; to: Date }): Promise<Standing[]> {
  const cargo = await stampedCargo(db, { from: w.from, to: w.to }, { kind: 'all' }, KPI_LOAD);
  return rankStandings(
    cargo.map((c) => ({
      userId: c.sellerId,
      name: c.sellerName ?? '—',
      m3: c.m3,
      kg: c.kg,
      receipts: c.receipts,
    })),
  );
}

/**
 * The week's FTL, per seller, for the separate line: the same reader with the
 * other half of the filter, ordered like the ranked rows (kub, then kg).
 */
async function ftlFor(w: { from: Date; to: Date }): Promise<FtlLine[]> {
  const cargo = await stampedCargo(db, { from: w.from, to: w.to }, { kind: 'all' }, 'ftl');
  return cargo
    .filter((c) => c.m3 > 0 || c.kg > 0)
    .map((c) => ({ userId: c.sellerId, name: c.sellerName ?? '—', m3: c.m3, kg: c.kg, receipts: c.receipts }))
    .sort((a, b) => b.m3 - a.m3 || b.kg - a.kg || a.name.localeCompare(b.name));
}

/** The weeks the group SAW, newest first — what streaks and records are read from. */
async function postedWeeks(): Promise<PostedWeek[]> {
  const rows = await db.execute<{ standings: { key?: string; rows?: Standing[] } | null }>(sql`
    SELECT standings FROM staff_group_posts
     WHERE kind = 'rating' AND status = 'sent' AND standings IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 60`);
  return Array.from(rows)
    .map((r) => r.standings)
    .filter((s): s is { key: string; rows: Standing[] } => !!s && typeof s.key === 'string' && Array.isArray(s.rows))
    .map((s) => ({ key: s.key, rows: s.rows }));
}

const sum = (rows: Standing[], pick: (r: Standing) => number) => rows.reduce((t, r) => t + pick(r), 0);

/**
 * Everything one rating says, assembled — the post's and the screen's ONE
 * shape. Streaks and records only for the post (they are about what the
 * group saw); the screen shows the live standings.
 */
export async function ratingViewFor(w: RatingWindow, opts: { withHistory: boolean }): Promise<{
  view: RatingView;
  standings: Standing[];
}> {
  const before = previousWindow(w);
  const [standings, previous, ftl, unstamped, sellers, goal] = await Promise.all([
    standingsFor(w),
    standingsFor(before),
    ftlFor(w),
    // «Sotuvchisi yozilmagan yuk» is about the missing STAMP, whatever the mode.
    unstampedCargo(db, { from: w.from, to: w.to }, 'all'),
    usersWithRoles(['sales_manager']),
    getSetting('staff_rating_goal_m3'),
  ]);
  const heroes = await heroesFor(standings.map((s) => s.userId));
  const prevBy = new Map(previous.map((p) => [p.userId, p.m3]));
  const posted = opts.withHistory ? await postedWeeks() : [];
  const streaks = opts.withHistory
    ? standings
        .filter((s) => s.rank === 1)
        .map((s) => ({ name: s.name, weeks: firstPlaceStreak(s.userId, w.key, posted) }))
        .filter((s) => s.weeks >= 2)
    : [];
  const records = opts.withHistory
    ? standings
        .filter((s) => isPersonalRecord(s.userId, s.m3, w.key, posted))
        .slice(0, 3)
        .map((s) => ({ name: s.name, m3: s.m3 }))
    : [];
  // A seller who brought only a whole truck is not idle — he is on the FTL line.
  const brought = new Set([...standings.map((s) => s.userId), ...ftl.map((f) => f.userId)]);
  const goalM3 = Number(goal);
  const view: RatingView = {
    from: w.from,
    to: w.to,
    rows: standings.map((s) => ({
      ...s,
      hero: heroes.get(s.userId) ?? { name: s.name, telegramUserId: null },
      before: prevBy.get(s.userId) ?? (previous.length > 0 ? 0 : null),
    })),
    team: { m3: sum(standings, (r) => r.m3), kg: sum(standings, (r) => r.kg), receipts: sum(standings, (r) => r.receipts) },
    teamBefore: previous.length > 0 ? sum(previous, (r) => r.m3) : null,
    goalM3: Number.isFinite(goalM3) && goalM3 > 0 ? goalM3 : null,
    streaks,
    records,
    unstamped: {
      m3: unstamped.reduce((t, u) => t + u.m3, 0),
      receipts: unstamped.reduce((t, u) => t + u.receipts, 0),
    },
    idleSellers: sellers.filter((id) => !brought.has(id)).length,
    ftl,
  };
  return { view, standings };
}

/**
 * Post the week that ended at the latest Saturday 18:00 — the cron's job,
 * and the panel's «Hozir yuborish» for a Saturday the bot missed. ONE claim
 * per week (`rating:<saturday>`): a redelivered job, a second press, a
 * restart at 18:00:30 — the group hears each week once.
 */
export async function postWeeklyRating(
  now: Date = new Date(),
  opts: { manual?: boolean } = {},
): Promise<'queued' | 'already' | 'requeued'> {
  const w = ratingWindowEnding(now);
  const { view, standings } = await ratingViewFor(w, { withHistory: true });
  const html = ratingHtml(view);
  // `ftl` beside `rows`: what the group saw, and `postedWeeks` reads `rows` alone.
  const stored = { key: w.key, from: w.from.toISOString(), to: w.to.toISOString(), rows: standings, ftl: view.ftl };
  const dedupeKey = `rating:${w.key}`;
  if (await queueGroupPost({ kind: 'rating', dedupeKey, html, standings: stored })) return 'queued';
  if (opts.manual && (await requeueSkippedGroupPost(dedupeKey, html, stored))) return 'requeued';
  return 'already';
}

/**
 * The month's champion (9a), posted on the 8th at 18:00 — the day the KPI
 * month closes (`kpiCloseDay`: the next 1st plus the seven days a prixod may
 * be back-dated), so the podium is the month the KPI pays on, not a guess.
 */
export async function postMonthChampion(
  now: Date = new Date(),
  opts: { manual?: boolean } = {},
): Promise<'queued' | 'already' | 'requeued'> {
  const month = previousMonth(now);
  const standings = await standingsFor(monthRange(month));
  const heroes = await heroesFor(standings.filter((s) => s.rank <= 3).map((s) => s.userId));
  const html = championHtml({
    month,
    rows: standings.map((s) => ({ ...s, hero: heroes.get(s.userId) ?? { name: s.name, telegramUserId: null } })),
    team: {
      m3: sum(standings, (r) => r.m3),
      kg: sum(standings, (r) => r.kg),
      receipts: sum(standings, (r) => r.receipts),
    },
  });
  const stored = { key: month, rows: standings };
  const dedupeKey = `champion:${month}`;
  if (await queueGroupPost({ kind: 'champion', dedupeKey, html, standings: stored })) return 'queued';
  if (opts.manual && (await requeueSkippedGroupPost(dedupeKey, html, stored))) return 'requeued';
  return 'already';
}

/** The screen's three blocks: the week running now, the last closed week, and the month so far. */
export async function ratingScreen(now: Date = new Date()): Promise<{
  running: RatingView;
  closed: RatingView;
  month: { month: string; rows: Standing[]; ftl: FtlLine[] };
}> {
  const month = tashkentMonth(now);
  const monthWindow = { from: monthRange(month).from, to: now };
  const [running, closed, monthRows, monthFtl] = await Promise.all([
    ratingViewFor(runningWindow(now), { withHistory: false }),
    ratingViewFor(ratingWindowEnding(now), { withHistory: false }),
    standingsFor(monthWindow),
    ftlFor(monthWindow),
  ]);
  return { running: running.view, closed: closed.view, month: { month, rows: monthRows, ftl: monthFtl } };
}

/**
 * «/reyting» in the staff bot (a private chat) — the person's OWN place this
 * week and the podium, never the whole list: the full table is the group's
 * Saturday post and the screen.
 */
export async function ratingReplyFor(userId: string, now: Date = new Date()): Promise<string> {
  const w = runningWindow(now);
  const [standings, ftl] = await Promise.all([standingsFor(w), ftlFor(w)]);
  const me = standings.find((s) => s.userId === userId);
  const myFtl = ftl.find((f) => f.userId === userId);
  const lines = ['📊 Shu hafta (shanba 18:00 dan beri):'];
  for (const s of standings.filter((r) => r.rank <= 3)) {
    lines.push(`${['🥇', '🥈', '🥉'][s.rank - 1]} ${s.name} — ${kub(s.m3)} kub`);
  }
  // «Nobody brought cargo» would contradict the FTL line under it (0135).
  if (standings.length === 0) lines.push(ftl.length > 0 ? 'Hali hech kim sborniy (LTL) yuk olib kelmadi.' : 'Hali hech kim yuk olib kelmadi.');
  lines.push('');
  lines.push(
    me
      ? `Siz: ${me.rank}-o'rin — ${kub(me.m3)} kub · ${Math.round(me.kg)} kg · ${me.receipts} prixod`
      : myFtl
        ? 'Siz bu hafta sborniy (LTL) yuk olib kelmadingiz.'
        : 'Siz bu hafta hali yuk olib kelmadingiz.',
  );
  if (myFtl) {
    lines.push(`🚛 FTL (ochkosiz): ${kub(myFtl.m3)} kub · ${Math.round(myFtl.kg)} kg · ${myFtl.receipts} prixod`);
  }
  return lines.join('\n');
}

export async function registerStaffRatingWorkers(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_STAFF_RATING);
  // Saturday 18:00 in Tashkent = 13:00 UTC (no daylight saving).
  await boss.schedule(JOB_STAFF_RATING, '0 13 * * 6');
  await boss.work(JOB_STAFF_RATING, async () => {
    try {
      const outcome = await postWeeklyRating();
      logger.info({ outcome }, '[staff-group] weekly rating');
    } catch (err) {
      logger.error({ err }, '[staff-group] weekly rating failed');
    }
  });
  await boss.createQueue(JOB_STAFF_CHAMPION);
  // The 8th at 18:00 in Tashkent — the KPI month has just closed.
  await boss.schedule(JOB_STAFF_CHAMPION, '0 13 8 * *');
  await boss.work(JOB_STAFF_CHAMPION, async () => {
    try {
      const outcome = await postMonthChampion();
      logger.info({ outcome }, '[staff-group] month champion');
    } catch (err) {
      logger.error({ err }, '[staff-group] month champion failed');
    }
  });
}
