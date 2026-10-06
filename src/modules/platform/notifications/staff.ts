import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { notifications, users } from '../db/schema';
import { enqueue, JOB_SEND_TELEGRAM } from '../jobs/boss';
import { isTelegramMuted } from './mutes';
import { canLogInSql } from '../users/login';

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
    .select({ id: users.id, muted: users.mutedNotificationTypes, live: canLogInSql() })
    .from(users)
    .where(inArray(users.id, ids));

  let queued = 0;
  for (const person of rows) {
    // A colleague NOW (`canLogIn`, 0120): a leaver, or a person who never
    // signs in, gets no queued row at all.
    if (!person.live) continue;
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

/**
 * Can the bot reach this person with this kind of message right now?
 *
 * 'no_chat' — no linked staff chat (or no longer a colleague); 'muted' — the
 * person silenced the type on /profile. ONE answer for the three readers that
 * must agree (docs/TELEGRAM-TOPSHIRIQ.md §3-4): the «📵» in the draft's
 * «Kimga?» list (which shows ONLY 'no_chat' — a mute is a personal setting,
 * and the list is read by every colleague, review access-money-24), the
 * author's «⚠ … topshiriqni faqat saytda ko'radi» after a pick, and the
 * sentence a 💬 sender is told when the other side will not hear it.
 * One query for the lot.
 */
export type Reach = 'ok' | 'no_chat' | 'muted';

export async function reachOf(userIds: string[], type: string): Promise<Map<string, Reach>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  const out = new Map<string, Reach>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: users.id,
      muted: users.mutedNotificationTypes,
      live: canLogInSql(),
      linked: sql<boolean>`EXISTS (SELECT 1 FROM telegram_links l
        WHERE l.user_id = ${users.id} AND l.status = 'linked' AND l.telegram_chat_id IS NOT NULL)`,
    })
    .from(users)
    .where(inArray(users.id, ids));
  for (const row of rows) {
    out.set(row.id, !row.live || !row.linked ? 'no_chat' : isTelegramMuted(row.muted, type) ? 'muted' : 'ok');
  }
  for (const id of ids) if (!out.has(id)) out.set(id, 'no_chat');
  return out;
}

/** The sentence an author or a sender reads when the other side will not hear (spec §4). */
export function reachLine(name: string, reach: Reach): string | null {
  if (reach === 'no_chat') return `⚠ ${name} Telegramga ulanmagan — topshiriqni faqat saytda ko‘radi`;
  if (reach === 'muted') return `⚠ ${name} topshiriq xabarlarini o‘chirgan — faqat saytda ko‘radi`;
  return null;
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
