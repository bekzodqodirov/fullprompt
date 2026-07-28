import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, tgMessages, users } from '../../platform/db/schema';
import { activeClientsByPhone } from '../client-cabinet/service';

/**
 * The conversation list and one conversation — phase 2 of bringing the
 * client chat into the CRM.
 *
 * Phase 1 put the messages in the database and showed them on the client
 * card, which answers "what did we say to THIS client". This answers the
 * other question, the one a sales manager starts the day with: "who has been
 * talking to us, and who is still waiting".
 */

export interface ConversationRow {
  clientId: string;
  clientCode: string;
  clientName: string;
  lastAt: Date;
  lastBody: string | null;
  lastHasMedia: boolean;
  /** True when the client spoke last — i.e. the ball is on our side. */
  waitingOnUs: boolean;
  messages: number;
}

/**
 * Every client we hold a conversation with, most recently active first.
 *
 * `DISTINCT ON` rather than a window function or a subquery per row: postgres
 * walks `tg_messages_client_idx` (client_id, sent_at) once and takes the top
 * of each group. With one row per message and a chat history behind it, the
 * difference between this and "the latest message per client" written the
 * obvious way is the difference between an index scan and a sort of the whole
 * table (#152, same lesson).
 */
export async function listConversations(search?: string): Promise<ConversationRow[]> {
  const q = (search ?? '').trim();
  const rows = await db.execute<{
    client_id: string;
    client_code: string;
    client_name: string;
    sent_at: Date;
    body: string | null;
    has_media: boolean;
    direction: string;
    messages: string;
  }>(sql`
    SELECT DISTINCT ON (m.client_id)
      m.client_id,
      c.client_code,
      c.name AS client_name,
      m.sent_at,
      m.body,
      m.has_media,
      m.direction,
      (SELECT count(*) FROM tg_messages n WHERE n.client_id = m.client_id) AS messages
    FROM tg_messages m
    JOIN clients c ON c.id = m.client_id
    ${q ? sql`WHERE c.name ILIKE ${'%' + q + '%'} OR c.client_code ILIKE ${'%' + q + '%'}` : sql``}
    ORDER BY m.client_id, m.sent_at DESC
  `);

  return rows
    .map((r) => ({
      clientId: r.client_id,
      clientCode: r.client_code,
      clientName: r.client_name,
      lastAt: new Date(r.sent_at),
      lastBody: r.body,
      lastHasMedia: r.has_media,
      // The client spoke last and nobody has answered. This is the single
      // most useful fact on the screen, so it is computed here rather than
      // left for the eye to work out from a name.
      waitingOnUs: r.direction === 'in',
      messages: Number(r.messages),
    }))
    // `DISTINCT ON` must sort by the grouping column first, so the useful
    // order is applied afterwards — on at most one row per client.
    .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
}

export interface ConversationMessage {
  id: string;
  direction: string;
  body: string | null;
  hasMedia: boolean;
  sentAt: Date;
  manager: string;
}

/**
 * One client's thread, NEWEST first.
 *
 * Both screens then render it inside a `flex-col-reverse` scroll box, which
 * flips it back to reading order AND opens it already scrolled to the newest
 * message — the way every chat app behaves, and what the owner asked for
 * ("chatlar ro'yxatidan chatni tanlab ko'rsang focus bugunga qaratilmagan").
 * Doing it in CSS rather than by scrolling after paint means there is no jump:
 * the first frame is already at the bottom.
 */
export async function conversationFor(
  clientId: string,
  limit = 500,
): Promise<ConversationMessage[]> {
  const rows = await db
    .select({
      id: tgMessages.id,
      direction: tgMessages.direction,
      body: tgMessages.body,
      hasMedia: tgMessages.hasMedia,
      sentAt: tgMessages.sentAt,
      manager: users.fullName,
    })
    .from(tgMessages)
    .innerJoin(users, eq(tgMessages.managerUserId, users.id))
    .where(eq(tgMessages.clientId, clientId))
    .orderBy(desc(tgMessages.sentAt))
    .limit(limit);
  // The newest `limit` rows, in that order. Taking the OLDEST n would push the
  // recent end — the only part anyone reads — off a long history entirely.
  return rows;
}

/** The client behind a conversation, for the thread's header. */
export async function conversationClient(clientId: string) {
  return db.query.clients.findFirst({ where: eq(clients.id, clientId) });
}

/** How many clients we hold a conversation with — for the menu badge. */
export async function conversationCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(DISTINCT ${tgMessages.clientId})` })
    .from(tgMessages);
  return Number(row?.n ?? 0);
}

/**
 * Which client's conversation belongs on a LEAD's card.
 *
 * A lead is not a client, and `tg_messages.client_id` is NOT NULL — so a brand
 * new prospect has no thread here, and that is correct: their chat was never
 * imported, because the import only ever keeps conversations that match the
 * client book.
 *
 * But two common cases DO have one, and both are worth showing:
 *  - the lead has already been converted (`clientId` is set), and
 *  - the lead is an EXISTING client asking about another job, typed into the
 *    funnel as a fresh lead. That is the owner's reality, not an edge case.
 *
 * Resolved by phone through the same helper the cabinet uses, so "same person,
 * different formatting" behaves the same way everywhere. Deliberately only
 * when the number resolves to exactly ONE client: a lead's phone is typed in a
 * hurry, and showing the wrong person's private conversation is a worse
 * failure than showing none.
 */
export async function conversationClientForLead(lead: {
  clientId: string | null;
  phone: string | null;
}): Promise<string | null> {
  if (lead.clientId) return lead.clientId;
  const phone = (lead.phone ?? '').trim();
  if (!phone) return null;
  const matches = await activeClientsByPhone(phone);
  return matches.length === 1 ? matches[0]!.id : null;
}
