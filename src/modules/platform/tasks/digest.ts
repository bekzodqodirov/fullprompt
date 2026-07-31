import type PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { notifications, users } from '../db/schema';
import { logger } from '../logger';
import { isTelegramMuted } from '../notifications/mutes';
import { aboutLabels, myDay, overdueByAssignee } from './service';

export const JOB_TASKS_MORNING = 'tasks.morning';

/**
 * "What is on you today" — one message per person, first thing.
 *
 * Per recipient and never broadcast, for the same reason the CRM digest is: a
 * list of somebody else's work is a message people learn to swipe away. Silent
 * when a person has nothing due — a daily message that is usually empty trains
 * exactly that habit.
 *
 * The text is built here and stored whole; `renderTelegramText` sends a
 * pre-rendered body as-is (DECISIONS #164), so no case has to be added there.
 */
async function deliver(userId: string, text: string): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const muted = isTelegramMuted(user?.mutedNotificationTypes, 'TasksDue');
  await db.insert(notifications).values({
    userId,
    channel: 'telegram',
    type: 'TasksDue',
    payload: { text },
    status: muted ? 'muted' : 'pending',
    error: muted ? 'muted by user' : null,
  });
}

function line(task: { typeIcon: string | null; title: string; dueAt: Date | null }, late: boolean) {
  const when = task.dueAt ? task.dueAt.toISOString().slice(0, 10) : '';
  return `${late ? '🔴' : '•'} ${task.typeIcon ?? ''} ${task.title}${late ? ` ⚠️ ${when}` : ''}`.replace(
    /\s+/g,
    ' ',
  );
}

/**
 * One person's day as a Telegram text — the morning digest's body, ALSO
 * served on demand by the staff bot's «Bugun» button (round 35): the same
 * words in the push and the pull, so nobody wonders which one is right.
 * Null when there is nothing due — an empty list is not a message.
 */
export async function composeMyDayText(userId: string, now = new Date()): Promise<string | null> {
  const endOfToday = new Date(now);
  endOfToday.setUTCHours(23, 59, 59, 999);
  const day = await myDay(userId, endOfToday);
  const late = day.overdue;
  const today = day.today;
  if (late.length + today.length === 0) return null;

  const labels = await aboutLabels([...late, ...today]);
  const about = (task: (typeof late)[number]) => {
    const key = task.entityType && task.entityId ? `${task.entityType}:${task.entityId}` : null;
    const label = key ? labels.get(key) : null;
    return label ? `\n   ${label}` : '';
  };

  const parts: string[] = [];
  if (late.length) {
    parts.push(
      `🔴 Kechikkan (${late.length})\n` +
        late.slice(0, 15).map((task) => line(task, true) + about(task)).join('\n'),
    );
  }
  if (today.length) {
    parts.push(
      `🟡 Bugunga (${today.length})\n` +
        today.slice(0, 15).map((task) => line(task, false) + about(task)).join('\n'),
    );
  }
  return `✅ Sizning vazifalaringiz\n\n${parts.join('\n\n')}`;
}

export async function sendTaskDigest(now = new Date()): Promise<number> {
  // One pass over the overdue rows tells us WHO has anything at all, so a
  // company of twenty does not become twenty queries for twenty empty days.
  const overdue = await overdueByAssignee(now);
  const candidates = new Set<string>(overdue.keys());
  for (const row of await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.active, true))) {
    candidates.add(row.id);
  }

  let sent = 0;
  for (const userId of candidates) {
    const text = await composeMyDayText(userId, now);
    if (!text) continue;
    await deliver(userId, text);
    sent += 1;
  }

  sent += await notifyAuthorsOfOverdue(overdue);
  return sent;
}

/**
 * Tell the person who ASSIGNED the work that it is late (owner: "ikkalasiga
 * habar ketsin").
 *
 * The author is the manager in this system — there is no reporting hierarchy,
 * and inventing one to answer this would be a second org chart to maintain
 * beside the real one. Work you gave somebody is work you are waiting on, so
 * the person waiting is exactly who wants to know.
 *
 * Grouped per author and never sent to yourself: a self-assigned task already
 * appeared in the message above, and the same list twice is how a channel
 * stops being read.
 */
async function notifyAuthorsOfOverdue(
  overdue: Map<string, Awaited<ReturnType<typeof overdueByAssignee>> extends Map<string, infer T> ? T : never>,
): Promise<number> {
  const byAuthor = new Map<string, { title: string; assigneeName: string | null; dueAt: Date | null }[]>();
  for (const [assigneeId, rows] of overdue) {
    for (const row of rows) {
      if (row.createdBy === assigneeId) continue;
      byAuthor.set(row.createdBy, [
        ...(byAuthor.get(row.createdBy) ?? []),
        { title: row.title, assigneeName: row.assigneeName, dueAt: row.dueAt },
      ]);
    }
  }

  let sent = 0;
  for (const [authorId, rows] of byAuthor) {
    const lines = rows
      .slice(0, 20)
      .map(
        (row) =>
          `🔴 ${row.title} — ${row.assigneeName ?? '?'}${
            row.dueAt ? ` ⚠️ ${row.dueAt.toISOString().slice(0, 10)}` : ''
          }`,
      )
      .join('\n');
    const more = rows.length > 20 ? `\n… va yana ${rows.length - 20} ta` : '';
    await deliver(
      authorId,
      `⏰ Siz bergan vazifalar kechikdi (${rows.length})\n\n${lines}${more}`,
    );
    sent += 1;
  }
  return sent;
}

export async function registerTaskWorkers(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_TASKS_MORNING);
  // 08:00 Asia/Tashkent (UTC+5, no DST) — ahead of both the CRM digest at
  // 08:30 and the warehouse one at 09:00, because this is the message that
  // decides what the day looks like.
  await boss.schedule(JOB_TASKS_MORNING, '0 3 * * *');
  await boss.work(JOB_TASKS_MORNING, async () => {
    try {
      const sent = await sendTaskDigest();
      logger.info({ sent }, 'task digest run');
    } catch (err) {
      logger.error({ err }, 'task digest failed');
      throw err;
    }
  });
}
