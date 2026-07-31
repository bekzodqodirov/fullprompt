import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { getSetting } from '../../platform/settings/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';

/**
 * "A client is waiting and nobody has answered" (owner's item 5).
 *
 * The one thing on the conversations screen that costs money is a customer
 * left hanging, and the screen only says so to whoever opens it. This tells
 * the manager whose account holds the chat, once.
 *
 * Once is the whole design. A reminder that repeats every five minutes is a
 * reminder people mute, so the threshold crossing is remembered on the
 * MESSAGE row (`reminded_at`) and never fires twice for the same silence.
 */

export interface UnansweredChat {
  clientId: string;
  clientCode: string;
  clientName: string;
  managerUserId: string;
  /** The newest incoming message id — where the mark is written. */
  messageId: string;
  waitingMinutes: number;
  lastBody: string | null;
}

/**
 * Conversations where the CLIENT spoke last, longer ago than the threshold,
 * and nobody has been reminded about this particular message yet.
 *
 * `DISTINCT ON` per (client, manager): the newest message decides whether
 * the ball is on our side, exactly as `listConversations` decides it — two
 * different answers to "is this waiting" would be worse than none.
 */
export async function unansweredChats(
  minutes: number,
  now = new Date(),
): Promise<UnansweredChat[]> {
  if (minutes <= 0) return [];
  const cutoff = new Date(now.getTime() - minutes * 60_000).toISOString();
  const rows = await db.execute<{
    client_id: string;
    client_code: string;
    client_name: string;
    manager_user_id: string;
    message_id: string;
    sent_at: Date;
    body: string | null;
    direction: string;
    reminded_at: Date | null;
  }>(sql`
    SELECT DISTINCT ON (m.client_id, m.manager_user_id)
      m.client_id, c.client_code, c.name AS client_name, m.manager_user_id,
      m.id AS message_id, m.sent_at, m.body, m.direction, m.reminded_at
    FROM tg_messages m
    JOIN clients c ON c.id = m.client_id
    ORDER BY m.client_id, m.manager_user_id, m.sent_at DESC
  `);

  return rows
    .filter(
      (r) =>
        r.direction === 'in' &&
        r.reminded_at === null &&
        new Date(r.sent_at).toISOString() <= cutoff,
    )
    .map((r) => ({
      clientId: r.client_id,
      clientCode: r.client_code,
      clientName: r.client_name,
      managerUserId: r.manager_user_id,
      messageId: r.message_id,
      waitingMinutes: Math.floor((now.getTime() - new Date(r.sent_at).getTime()) / 60_000),
      lastBody: r.body,
    }));
}

/** The reminder's text — one client, in the manager's own words. */
export function unansweredText(chat: UnansweredChat, appUrl: string): string {
  const hours = Math.floor(chat.waitingMinutes / 60);
  const waited = hours >= 1 ? `${hours} soat` : `${chat.waitingMinutes} daqiqa`;
  const quoted = chat.lastBody?.trim().slice(0, 160);
  return (
    `💬 ${chat.clientCode} (${chat.clientName}) javob kutmoqda — ${waited}\n` +
    (quoted ? `«${quoted}»\n` : '') +
    `${appUrl}/suhbatlar/${chat.clientId}`
  );
}

/**
 * Send the reminders due now and mark the messages, so the same silence is
 * never reported twice. Returns how many went out.
 */
export async function remindUnanswered(now = new Date()): Promise<number> {
  const minutes = Number(await getSetting('unanswered_reminder_minutes')) || 0;
  const due = await unansweredChats(minutes, now);
  if (due.length === 0) return 0;
  const appUrl = process.env.APP_URL ?? '';

  let sent = 0;
  for (const chat of due) {
    await notifyStaffTelegram({
      userIds: [chat.managerUserId],
      type: 'ClientWaiting',
      text: unansweredText(chat, appUrl),
    });
    // Marked whether or not the manager has the type muted: the mark says
    // "this silence has been reported", not "a message was delivered".
    await db.execute(
      sql`UPDATE tg_messages SET reminded_at = ${now.toISOString()}::timestamptz WHERE id = ${chat.messageId}`,
    );
    sent += 1;
  }
  return sent;
}
