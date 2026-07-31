import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { attachments, clients, tgMessages, users } from '../../platform/db/schema';
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

/**
 * Whose eyes a Telegram read is for.
 *
 * `all` is the owner's supervision view (his instruction, 2026-07-29: «menga
 * rahbar sifatida hamma yozishmalar korinsin») — computed from the ROLE, in
 * one place, so widening or narrowing it later is a one-line decision.
 */
export interface TgViewer {
  id: string;
  all?: boolean;
}

export function tgViewerFor(actor: { id: string; roles: readonly string[] }): TgViewer {
  return { id: actor.id, all: actor.roles.includes('super_admin') };
}

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
  /** Who holds the chat(s) — filled only on the supervision view. */
  managers: string[];
}

/**
 * Every client THE VIEWER holds a conversation with, most recently active
 * first.
 *
 * Scoped to the viewer's own Telegram account (owner, 2026-07-29: each
 * manager connects their OWN account and talks to clients there — reading a
 * colleague's personal chats was never the agreement). The schema said this
 * from birth — «two managers are two conversations» — and the write side
 * always enforced it; this read simply forgot to ask whose thread it was.
 *
 * `DISTINCT ON` rather than a window function or a subquery per row: postgres
 * walks `tg_messages_client_idx` (client_id, sent_at) once and takes the top
 * of each group. With one row per message and a chat history behind it, the
 * difference between this and "the latest message per client" written the
 * obvious way is the difference between an index scan and a sort of the whole
 * table (#152, same lesson).
 */
export async function listConversations(
  viewer: TgViewer,
  search?: string,
): Promise<ConversationRow[]> {
  const q = (search ?? '').trim();
  // One fragment, used identically in the top row and the count, so the two
  // can never disagree about whose messages a row is describing.
  const mine = viewer.all ? sql`true` : sql`m.manager_user_id = ${viewer.id}`;
  const mineN = viewer.all ? sql`true` : sql`n.manager_user_id = ${viewer.id}`;
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
      (SELECT count(*) FROM tg_messages n
        WHERE n.client_id = m.client_id AND ${mineN}) AS messages
    FROM tg_messages m
    JOIN clients c ON c.id = m.client_id
    WHERE ${mine}
    ${q ? sql`AND (c.name ILIKE ${'%' + q + '%'} OR c.client_code ILIKE ${'%' + q + '%'})` : sql``}
    ORDER BY m.client_id, m.sent_at DESC
  `);

  // The supervision view names whose account each conversation lives on —
  // the boss reads a company of threads, and a row without its manager's
  // name is exactly the «tushunarsiz» he complained about.
  const managersByClient = new Map<string, string[]>();
  if (viewer.all && rows.length > 0) {
    const nameRows = await db.execute<{ client_id: string; names: string[] }>(sql`
      SELECT m.client_id, array_agg(DISTINCT u.full_name) AS names
      FROM tg_messages m
      JOIN users u ON u.id = m.manager_user_id
      WHERE m.client_id IN (${sql.join(rows.map((r) => sql`${r.client_id}`), sql`, `)})
      GROUP BY m.client_id
    `);
    for (const row of nameRows) managersByClient.set(row.client_id, row.names);
  }

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
      managers: managersByClient.get(r.client_id) ?? [],
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
  /** Downloaded photos pinned to this message (item 15) — often empty. */
  photos: { id: string }[];
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
  viewer: TgViewer,
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
    // The viewer's own account only — a colleague's thread with the same
    // client is that colleague's personal Telegram, not a shared record.
    // The one exception is the owner's supervision view (`all`), where every
    // bubble already names its manager.
    .where(
      viewer.all
        ? eq(tgMessages.clientId, clientId)
        : and(eq(tgMessages.clientId, clientId), eq(tgMessages.managerUserId, viewer.id)),
    )
    .orderBy(desc(tgMessages.sentAt))
    .limit(limit);
  // The newest `limit` rows, in that order. Taking the OLDEST n would push the
  // recent end — the only part anyone reads — off a long history entirely.
  return attachPhotos(rows);
}

/**
 * Pin each message's downloaded photos on (item 15). ONE query over the page
 * of ids, not one per row — `attachments_entity_idx` covers it, and most
 * messages have none.
 */
export async function attachPhotos<
  T extends { id: string },
>(rows: T[]): Promise<(T & { photos: { id: string }[] })[]> {
  if (rows.length === 0) return [];
  const photoRows = await db
    .select({ id: attachments.id, entityId: attachments.entityId })
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, 'tg_message'),
        inArray(attachments.entityId, rows.map((r) => r.id)),
      ),
    )
    .orderBy(attachments.createdAt);
  const byMessage = new Map<string, { id: string }[]>();
  for (const photo of photoRows) {
    const list = byMessage.get(photo.entityId) ?? [];
    list.push({ id: photo.id });
    byMessage.set(photo.entityId, list);
  }
  return rows.map((row) => ({ ...row, photos: byMessage.get(row.id) ?? [] }));
}

/** The client behind a conversation, for the thread's header. */
export async function conversationClient(clientId: string) {
  return db.query.clients.findFirst({ where: eq(clients.id, clientId) });
}

/**
 * Which clients the viewer holds a chat with, and whether the client spoke
 * last — one query for a whole kanban board (owner, round 25: «varonkadagi
 * kartochkalarda ham chat ko'rinsa»). A Map so a card asks by client id.
 */
export async function chatBadges(viewer: TgViewer): Promise<Map<string, 'waiting' | 'yes'>> {
  const mine = viewer.all ? sql`true` : sql`manager_user_id = ${viewer.id}`;
  const rows = await db.execute<{ client_id: string; direction: string }>(sql`
    SELECT DISTINCT ON (client_id) client_id, direction
    FROM tg_messages
    WHERE ${mine}
    ORDER BY client_id, sent_at DESC
  `);
  return new Map(rows.map((r) => [r.client_id, r.direction === 'in' ? 'waiting' : 'yes']));
}

/**
 * Every ACTIVE code this client's phone numbers answer to — the owner's
 * reality of one person holding several GS codes on one number (round 25:
 * «1 nomerda ko'p gs code bo'lsa hammasini ko'rsatsin»). The client's own
 * code comes first, the rest alphabetically.
 */
export async function codesSharingPhones(clientId: string): Promise<string[]> {
  const client = await conversationClient(clientId);
  if (!client) return [];
  const phones = Array.isArray(client.phones) ? (client.phones as string[]) : [];
  const seen = new Map<string, string>([[client.id, client.clientCode]]);
  for (const phone of phones) {
    for (const match of await activeClientsByPhone(phone)) {
      seen.set(match.id, match.clientCode);
    }
  }
  const others = [...seen.entries()]
    .filter(([id]) => id !== client.id)
    .map(([, code]) => code)
    .sort();
  return [client.clientCode, ...others];
}

/** How many clients THE VIEWER holds a conversation with — the menu badge. */
export async function conversationCount(viewer: TgViewer): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(DISTINCT ${tgMessages.clientId})` })
    .from(tgMessages)
    .where(viewer.all ? undefined : eq(tgMessages.managerUserId, viewer.id));
  return Number(row?.n ?? 0);
}

/**
 * Which client id holds the thread that belongs on a CARD for this client:
 * the card's own client when their thread exists, otherwise the ONE
 * phone-sibling code that holds it.
 *
 * The owner's people hold several GS codes on one number, and the import
 * pinned each chat to whichever code the phone matched — so a deal filed
 * under the sibling code showed an EMPTY card panel while «Suhbatlar»
 * clearly held the conversation (owner's report). Ambiguity refuses, same
 * rule as the lead resolver below: showing the wrong person's private chat
 * is a worse failure than showing none.
 */
export async function threadClientFor(clientId: string, viewer: TgViewer): Promise<string | null> {
  const hasThread = async (id: string) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(tgMessages)
      .where(
        viewer.all
          ? eq(tgMessages.clientId, id)
          : and(eq(tgMessages.clientId, id), eq(tgMessages.managerUserId, viewer.id)),
      );
    return Number(row?.n ?? 0) > 0;
  };
  if (await hasThread(clientId)) return clientId;

  const client = await conversationClient(clientId);
  if (!client) return null;
  const phones = Array.isArray(client.phones) ? (client.phones as string[]) : [];
  const siblings = new Set<string>();
  for (const phone of phones) {
    for (const match of await activeClientsByPhone(phone)) {
      if (match.id !== clientId) siblings.add(match.id);
    }
  }
  const withThread: string[] = [];
  for (const id of siblings) {
    if (await hasThread(id)) withThread.push(id);
  }
  return withThread.length === 1 ? withThread[0]! : null;
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
