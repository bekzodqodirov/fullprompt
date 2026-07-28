import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, tgMessages, users } from '../../platform/db/schema';

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

/** One client's thread, oldest first — read as a conversation, not a log. */
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
  // Newest `limit` rows, then flipped: a long history must not push the RECENT
  // end off the page, which is what taking the oldest N would do.
  return rows.reverse();
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
