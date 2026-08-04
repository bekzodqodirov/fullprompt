import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { notifications, users } from '../db/schema';
import { enqueue, JOB_SEND_TELEGRAM } from '../jobs/boss';
import { isTelegramMuted } from './mutes';

/**
 * One instant Telegram message to named colleagues.
 *
 * This is the piece that lets the internal conversation LIVE in Telegram, the
 * way the owner wants ("ichki chatni telegramda olib borishni belgila"): the
 * record stays on the card, and the ping — with a link back to that card —
 * lands where everybody already is. The bot and the linking flow have existed
 * since M0; what was missing was anything person-to-person and immediate.
 *
 * Pre-rendered text (DECISIONS #164): the message is composed where the
 * context is, stored whole, and `renderTelegramText` passes it through. That
 * also keeps this module free of per-type cases.
 *
 * Mutes are honoured per recipient, inactive users are skipped, and the
 * author never pings themselves — a notification about your own note is how
 * people learn to mute the type entirely.
 */
export async function notifyStaffTelegram(input: {
  userIds: string[];
  /** For the per-user mute check and the notifications screen. */
  type: string;
  text: string;
  /** Excluded from delivery — normally the person who did the thing. */
  exceptUserId?: string | null;
  /**
   * Extra payload fields beside the text — e.g. the taskId that lets the
   * send worker attach the «Bajarildi» button (round 35 staff bot).
   */
  extra?: Record<string, unknown>;
}): Promise<number> {
  const ids = [...new Set(input.userIds)].filter((id) => id && id !== input.exceptUserId);
  if (ids.length === 0) return 0;

  const rows = await db
    .select({ id: users.id, muted: users.mutedNotificationTypes, active: users.active })
    .from(users)
    .where(inArray(users.id, ids));

  let queued = 0;
  for (const person of rows) {
    if (!person.active) continue;
    const muted = isTelegramMuted(person.muted, input.type);
    await db.insert(notifications).values({
      userId: person.id,
      channel: 'telegram',
      type: input.type,
      payload: { ...(input.extra ?? {}), text: input.text },
      status: muted ? 'muted' : 'pending',
      error: muted ? 'muted by user' : null,
    });
    if (!muted) queued += 1;
  }
  // Kick the drain now rather than waiting for its minute tick: a colleague
  // answering "kim gaplashadi bu mijoz bilan?" a minute late has already been
  // answered by somebody walking over to ask.
  if (queued > 0) await enqueue(JOB_SEND_TELEGRAM, {}).catch(() => {});
  return queued;
}

/** The user rows behind a set of ids — for building "who to tell" lists. */
export async function activeUserIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]));
  return rows.map((r) => r.id);
}

export async function userName(id: string): Promise<string> {
  const row = await db.query.users.findFirst({ where: eq(users.id, id) });
  return row?.fullName ?? '—';
}
