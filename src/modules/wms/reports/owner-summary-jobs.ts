import type PgBoss from 'pg-boss';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { notifications, telegramLinks, users } from '../../platform/db/schema';
import { enqueue, JOB_SEND_TELEGRAM } from '../../platform/jobs/boss';
import { logger } from '../../platform/logger';
import { isTelegramMuted } from '../../platform/notifications/mutes';
import { usersWithRoles } from '../../platform/notifications/service';
import { actorGrants } from '../../platform/rbac/authorize';
import { tashkentDayStart } from '../../platform/time/tashkent';
import { scopeKeyOf } from './dashboard';
import { composeOwnerSummary, type OwnerSummary } from './owner-summary';
import { ownerSummarySight } from './owner-summary-door';
import { reportBaseIds } from './report-scope';

export const JOB_OWNER_SUMMARY = 'reports.owner-summary';
/** The notification type — its own mute group («owner»), pre-rendered (#164). */
export const OWNER_SUMMARY_TYPE = 'OwnerSummary';

export interface OwnerSummaryRun {
  /** Rows written pending — the drain sends them. */
  queued: number;
  /** Rows written muted (the person's own switch) — kept as the record. */
  muted: number;
  /** Nothing moved in the window, or the day's row already exists. */
  skipped: number;
  failed: number;
  /**
   * Of `queued`: rows for a reader with NO linked Telegram. The drain settles
   * those as `muted / telegram not linked` — terminal, and deliberately not
   * a «problem» on any screen — so this count and its log line are the only
   * place a summary going nowhere is said out loud.
   */
  unlinked: number;
}

/**
 * Write the day's row for one person — ONCE per Tashkent day, whatever
 * retries (#727): pg-boss re-delivers a failed run, and the recipient loop
 * below throws at its end when anyone failed, so the people who DID get a
 * row must not get a second one.
 *
 * The guard is a per-(person, day) advisory lock and an existence check
 * inside ONE transaction, so two overlapping runs cannot both pass the check.
 * The check rides the `(user_id, created_at)` index and binds the day's start
 * through drizzle's `gte` — a raw Date in a `sql` fragment reaches postgres
 * untyped (#156). Only `tx` inside: the mute and the active flag are read on
 * the pool BEFORE, and the drain is kicked AFTER the commit (#714).
 */
async function deliverOnce(userId: string, summary: OwnerSummary, muted: boolean): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`owner-summary:${userId}:${summary.day}`}))`);
    const [existing] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          gte(notifications.createdAt, tashkentDayStart(summary.day)),
          eq(notifications.type, OWNER_SUMMARY_TYPE),
          sql`${notifications.payload}->>'day' = ${summary.day}`,
        ),
      )
      .limit(1);
    if (existing) return false;
    await tx.insert(notifications).values({
      userId,
      channel: 'telegram',
      type: OWNER_SUMMARY_TYPE,
      // The text and the two facts the guard and a reader need — nothing
      // else: the figures ARE the text, and a payload is not a second store.
      payload: { text: summary.text, day: summary.day, window: summary.window },
      status: muted ? 'muted' : 'pending',
      error: muted ? 'muted by user' : null,
    });
    return true;
  });
}

/**
 * The evening run: every super_admin the door admits (`ownerSummarySight` —
 * the ROLE and the company's money sight, the owner's «faqat sizga»), one
 * message each, SILENT on a day when nothing moved.
 *
 * Per person in its own try/catch: one person's failure must not cost the
 * others their message; the run throws at the END so pg-boss retries, and the
 * day guard makes the retry send nothing twice. The compose is memoised per
 * (scope, grants) inside the run — two owners with the same view read the
 * company once.
 *
 * A missed slot is NOT replayed (the server down at 15:00 UTC for a deploy):
 * the next evening's message covers its own day, and «📊 Holat» answers any
 * time — stated to the owner.
 */
export async function sendOwnerSummaries(now: Date = new Date()): Promise<OwnerSummaryRun> {
  const run: OwnerSummaryRun = { queued: 0, muted: 0, skipped: 0, failed: 0, unlinked: 0 };
  const userIds = await usersWithRoles(['super_admin']);
  if (userIds.length === 0) return run;
  const people = await db
    .select({ id: users.id, muted: users.mutedNotificationTypes, active: users.active })
    .from(users)
    .where(inArray(users.id, userIds));
  const linked = new Set(
    (
      await db
        .select({ userId: telegramLinks.userId })
        .from(telegramLinks)
        .where(and(inArray(telegramLinks.userId, userIds), eq(telegramLinks.status, 'linked')))
    ).map((row) => row.userId),
  );
  const memo = new Map<string, Promise<OwnerSummary>>();

  for (const person of people) {
    if (!person.active) continue;
    try {
      const actor = { id: person.id, ...(await actorGrants(person.id)) };
      const sight = ownerSummarySight(actor);
      if (!sight) continue;
      const key = `${scopeKeyOf(reportBaseIds(actor))}|${[...actor.permissions].sort().join(',')}`;
      let pending = memo.get(key);
      if (!pending) {
        pending = composeOwnerSummary(actor, sight, now);
        memo.set(key, pending);
      }
      const summary = await pending;
      if (summary.quiet) {
        run.skipped += 1;
        continue;
      }
      const muted = isTelegramMuted(person.muted, OWNER_SUMMARY_TYPE);
      const written = await deliverOnce(person.id, summary, muted);
      if (!written) run.skipped += 1;
      else if (muted) run.muted += 1;
      else {
        run.queued += 1;
        if (!linked.has(person.id)) {
          run.unlinked += 1;
          logger.warn(
            { userId: person.id },
            'owner summary written for a reader with no linked Telegram — the drain will mute it; link the chat on /profile',
          );
        }
      }
    } catch (err) {
      run.failed += 1;
      logger.error({ err, userId: person.id }, 'owner summary failed for one person');
    }
  }

  // After every commit, never inside one (#714): the drain sends now rather
  // than on its minute tick.
  if (run.queued > 0) await enqueue(JOB_SEND_TELEGRAM, {}).catch(() => {});
  if (run.failed > 0) throw new Error(`${run.failed} owner summary(ies) failed`);
  return run;
}

export async function registerOwnerSummaryWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_OWNER_SUMMARY);
  // 20:00 Asia/Tashkent (UTC+5, no DST) = 15:00 UTC. A push covers 00:00 to
  // 20:00 of its day. What is typed after 20:00 on Tuesday to Sunday reaches
  // the next Monday's week (Tuesday to Monday); what is typed after 20:00 on
  // a MONDAY reaches NO push at all — that week was sent at 20:00 and the
  // next one starts on Tuesday — only a «📊 Holat» pull before midnight shows
  // it. Kept, and stated to the owner, because the week is the dashboard's
  // own «7 kun» and the message's link opens exactly it (#513).
  await boss.schedule(JOB_OWNER_SUMMARY, '0 15 * * *');
  await boss.work(JOB_OWNER_SUMMARY, async () => {
    try {
      const run = await sendOwnerSummaries();
      logger.info(run, 'owner summary run');
    } catch (err) {
      logger.error({ err }, 'owner summary run failed');
      throw err;
    }
  });
}
