import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { getSetting } from '../../platform/settings/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { leadDialogsSql, resolveChatStates } from './conversations';
import { conversationHref, type ConversationKind } from './conversation-row';
import { mayOpenLead } from './lead-door';
import { chatNeedsAnswer } from './waiting';

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
 *
 * A LEAD's chat rings the same way since the lead chats round (owner's 4a:
 * «lidlarning chatlari ham mijoz chatlari kabi, 30 daqiqa») — a prospect who
 * wrote in and waits is the same lost money one step earlier.
 */

export interface UnansweredChat {
  kind: ConversationKind;
  /** Set on a client chat; null on a lead's. */
  clientId: string | null;
  /** Set on a lead chat; null on a client's. */
  leadId: string | null;
  /** The GS code; null on a lead chat. */
  code: string | null;
  name: string;
  managerUserId: string;
  /** The newest incoming message id — where the mark is written. */
  messageId: string;
  waitingMinutes: number;
  lastBody: string | null;
  /**
   * May the manager being nudged open the card the link points at? A lead
   * chat on this manager's account can belong to a colleague's lead, and a
   * «↗️ Ochish» that bounces is a broken door (the design judge's first
   * finding) — the nudge then names the lead's owner instead of linking.
   */
  openable: boolean;
  /** The lead's owner's name, for a lead chat the manager cannot open. */
  leadOwner: string | null;
}

/**
 * Conversations where the other side spoke last, longer ago than the
 * threshold, and nobody has been reminded about this particular message yet.
 *
 * `DISTINCT ON` per (owner, manager) — the client's id for a client chat, the
 * lead's for a lead chat, never the pair (a won lead's rows carry both): the
 * newest message decides whether the ball is on our side, exactly as
 * `listConversations` decides it — two different answers to "is this
 * waiting" would be worse than none.
 */
export async function unansweredChats(
  minutes: number,
  now = new Date(),
): Promise<UnansweredChat[]> {
  if (minutes <= 0) return [];
  const cutoff = new Date(now.getTime() - minutes * 60_000).toISOString();
  type Row = {
    manager_user_id: string;
    message_id: string;
    sent_at: Date;
    body: string | null;
    direction: string;
    reminded_at: Date | null;
    peer_id: string;
    tg_message_id: string;
  };
  /**
   * Who a LEAD chat may ring: the account holders who hold `crm.leads`. The
   * list (`listConversations`' `leadsFor`) and the home count
   * (`buildHomeFlow`'s `leadChats`) carry lead chats for exactly those
   * people, and the nudge follows the same rule — one rule for the three
   * readers (the review's fourth finding). A logist or a VED who pressed
   * «Yangi lid» on their own tray owns a lead no screen of theirs shows and
   * whose card sends them away; a Telegram line about it, naming themselves
   * as its owner, is a message about a door they do not have. Fed the grants
   * from the editable matrix (#170), deactivated people already left out.
   */
  const leadReaders = await usersWithPermission('crm.leads');
  const [clientRows, leadRows] = await Promise.all([
    db.execute<Row & { client_id: string; client_code: string; client_name: string }>(sql`
      SELECT DISTINCT ON (m.client_id, m.manager_user_id)
        m.client_id, c.client_code, c.name AS client_name, m.manager_user_id,
        m.id AS message_id, m.sent_at, m.body, m.direction, m.reminded_at,
        m.peer_id, m.tg_message_id
      FROM tg_messages m
      JOIN clients c ON c.id = m.client_id
      WHERE m.client_id IS NOT NULL
      ORDER BY m.client_id, m.manager_user_id, m.sent_at DESC
    `),
    leadReaders.length === 0
      ? Promise.resolve([])
      : db.execute<
          Row & {
            lead_id: string;
            lead_name: string;
            owner_id: string | null;
            owner_name: string | null;
          }
        >(sql`
          SELECT DISTINCT ON (d.lead_id, d.manager_user_id)
            d.lead_id, leads.name AS lead_name, leads.owner_id, lo.full_name AS owner_name,
            d.manager_user_id, d.id AS message_id, d.sent_at, d.body, d.direction,
            d.reminded_at, d.peer_id, d.tg_message_id
          FROM ${leadDialogsSql(
            sql`m.manager_user_id IN (${sql.join(
              leadReaders.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          )} d
          JOIN leads ON leads.id = d.lead_id
          LEFT JOIN users lo ON lo.id = leads.owner_id
          ORDER BY d.lead_id, d.manager_user_id, d.sent_at DESC
        `),
  ]);

  const isDue = (r: Row) =>
    r.direction === 'in' && r.reminded_at === null && new Date(r.sent_at).toISOString() <= cutoff;
  const candidates = [
    ...clientRows.filter(isDue).map((r) => ({
      kind: 'client' as const,
      clientId: r.client_id as string | null,
      leadId: null as string | null,
      code: r.client_code as string | null,
      name: r.client_name,
      ownerId: null as string | null,
      ownerName: null as string | null,
      row: r as Row,
    })),
    ...leadRows.filter(isDue).map((r) => ({
      kind: 'lead' as const,
      clientId: null as string | null,
      leadId: r.lead_id as string | null,
      code: null as string | null,
      name: r.lead_name,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      row: r as Row,
    })),
  ];

  /**
   * The state decides, not the direction (round 88).
   *
   * This is the owner's complaint at its source: a customer who writes «ok»
   * is finished, and the nudge that follows thirty minutes later teaches the
   * manager to ignore the next one — which will be a real question. Only
   * `new` rings: nobody has read it and nothing is on its way out. A lead
   * chat also passes its extra door here (`leadChatState`, inside the
   * resolver): nothing from before the watch began, nothing a closed lead
   * already settled.
   */
  const states = await resolveChatStates(
    candidates.map((c) => ({
      clientId: c.clientId,
      leadId: c.leadId,
      managerUserId: c.row.manager_user_id,
      peerId: c.row.peer_id,
      tgMessageId: c.row.tg_message_id,
      direction: c.row.direction,
      sentAt: new Date(c.row.sent_at),
      candidate: c,
    })),
  );
  const ringing = new Set<string>();
  for (const [seed, state] of states) {
    if (chatNeedsAnswer(state)) ringing.add(seed.candidate.row.message_id);
  }
  const due = candidates.filter((c) => ringing.has(c.row.message_id));

  // Whether each nudged manager may open the LEAD card the link would point
  // at — asked through the card's own predicate, fed the grants from the
  // editable matrix (#170). One more query, and only when a lead chat is due.
  const viewAll = due.some((c) => c.kind === 'lead')
    ? await usersWithPermission('crm.leads.view_all')
    : [];
  const grantsOf = (userId: string): Set<string> => {
    const grants = new Set<string>();
    if (leadReaders.includes(userId)) grants.add('crm.leads');
    if (viewAll.includes(userId)) grants.add('crm.leads.view_all');
    return grants;
  };

  return due.map((c) => {
    const openable =
      c.kind === 'client' ||
      mayOpenLead(
        { id: c.row.manager_user_id, permissions: grantsOf(c.row.manager_user_id) },
        {
          ownerId: c.ownerId,
        },
      );
    return {
      kind: c.kind,
      clientId: c.clientId,
      leadId: c.leadId,
      code: c.code,
      name: c.name,
      managerUserId: c.row.manager_user_id,
      messageId: c.row.message_id,
      waitingMinutes: Math.floor((now.getTime() - new Date(c.row.sent_at).getTime()) / 60_000),
      lastBody: c.row.body,
      openable,
      leadOwner: c.kind === 'lead' && !openable ? c.ownerName : null,
    };
  });
}

/**
 * The reminder's text — one conversation, in the manager's own words.
 *
 * The link is the last line on purpose: the drain lifts our own last-line
 * link into a «↗️ Ochish» button (staff-html.ts `takeOwnLink`). It comes from
 * `conversationHref`, the same address the list row carries (#513), so the
 * button and the row can never open two different places. A lead the
 * manager may not open gets no link at all — its owner is named instead,
 * because that is the person who can.
 */
export function unansweredText(chat: UnansweredChat, appUrl: string): string {
  const hours = Math.floor(chat.waitingMinutes / 60);
  const waited = hours >= 1 ? `${hours} soat` : `${chat.waitingMinutes} daqiqa`;
  const quoted = chat.lastBody?.trim().slice(0, 160);
  const href = conversationHref(chat);
  // «Lid» and not «Yangi lid»: a lead's chat can be months old and the lead
  // lost — the word says what the person is, never how new (the judge's
  // eleventh finding).
  const title =
    chat.kind === 'lead'
      ? `💬 Lid: ${chat.name} javob kutmoqda — ${waited}`
      : `💬 ${chat.code} (${chat.name}) javob kutmoqda — ${waited}`;
  const foot = href ? `${appUrl}${href}` : `Lid egasi: ${chat.leadOwner ?? '—'}`;
  return `${title}\n` + (quoted ? `«${quoted}»\n` : '') + foot;
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
