import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { chatNeedsAnswer, chatState, type ChatState } from './waiting';
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

/**
 * Who reads the WHOLE company's Telegram (owner, 2026-07-31: «vedchi va
 * adminga hammaniki ko'rinsin — qaysi hodim qanday gaplashgani») — the
 * super_admin/admin roles, plus whoever's EDITABLE grants say they do VED
 * work (#170): the calc files and photos arrive in whichever manager's chat
 * the client uses, and the vedchi must read them where they landed.
 * Everyone else stays own-account only, and REPLYING stays own-account for
 * everybody — supervision is eyes, not a mouth.
 */
export function seesAllTg(actor: {
  roles?: readonly string[];
  permissions?: ReadonlySet<string>;
}): boolean {
  return (
    actor.roles?.includes('super_admin') === true ||
    actor.roles?.includes('admin') === true ||
    actor.permissions?.has('ved.docs') === true
  );
}

export function tgViewerFor(actor: {
  id: string;
  roles: readonly string[];
  permissions?: ReadonlySet<string>;
}): TgViewer {
  return { id: actor.id, all: seesAllTg(actor) };
}

/** May this actor open the Telegram screens at all? The CRM permissions, or
 * the supervision view — a vedchi holds neither CRM grant, yet the whole
 * point of their widened view is reading the calc conversation. */
export function canReadTg(actor: {
  roles?: readonly string[];
  permissions: ReadonlySet<string>;
}): boolean {
  return (
    actor.permissions.has('crm.leads') ||
    actor.permissions.has('clients.manage') ||
    seesAllTg(actor)
  );
}

export interface ConversationRow {
  clientId: string;
  clientCode: string;
  clientName: string;
  lastAt: Date;
  lastBody: string | null;
  lastHasMedia: boolean;
  /** new = nobody has seen it · seen = read, no answer needed · answered. */
  state: ChatState;
  /** True ONLY for `new` — the alarm, not «the client spoke last». */
  waitingOnUs: boolean;
  messages: number;
  /** Who holds the chat(s) — filled only on the supervision view. */
  managers: string[];
}

/**
 * How many conversations a screen carries (round 74).
 *
 * The list had no ceiling at all. On the supervision view that is every
 * client the company has ever written to — the screen the owner opens most,
 * growing for ever. Two hundred is roughly a year of active chats, and the
 * search box is how an older one is found.
 */
export const CONVERSATIONS_ON_SCREEN = 200;

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
  limit = CONVERSATIONS_ON_SCREEN,
): Promise<ConversationRow[]> {
  const q = (search ?? '').trim();
  // One fragment, used identically in the top row and the count, so the two
  // can never disagree about whose messages a row is describing.
  const mine = viewer.all ? sql`true` : sql`m.manager_user_id = ${viewer.id}`;
  const mineN = viewer.all ? sql`true` : sql`n.manager_user_id = ${viewer.id}`;
  // The newest message per client, and NOTHING per message (round 74).
  //
  // The message COUNT used to be a correlated subquery in this projection —
  // and a subquery in a `DISTINCT ON` list is evaluated before the dedupe,
  // so it ran once per MESSAGE rather than once per conversation: measured
  // 916 ms and 417,000 buffers at 100,000 messages, on the screen the owner
  // opens most and on the 💬 dock reachable from every page. It is now one
  // grouped query joined in JS — round 45's `accountBalances` fix, same
  // shape, same reason.
  const rows = await db.execute<{
    client_id: string;
    client_code: string;
    client_name: string;
    sent_at: Date;
    body: string | null;
    has_media: boolean;
    direction: string;
    manager_user_id: string;
    peer_id: string;
    tg_message_id: string;
  }>(sql`
    SELECT DISTINCT ON (m.client_id)
      m.client_id,
      c.client_code,
      c.name AS client_name,
      m.sent_at,
      m.body,
      m.has_media,
      m.direction,
      -- Carried so the state can be resolved AFTER the page is sliced. Round
      -- 74 removed a correlated subquery from this very projection because a
      -- DISTINCT ON evaluates it once per MESSAGE, not once per conversation;
      -- the read pointer and the outbox are asked the same way the message
      -- count now is — grouped, over the page, below. (No backticks in here:
      -- this comment lives inside a template literal.)
      m.manager_user_id,
      m.peer_id,
      m.tg_message_id
    FROM tg_messages m
    JOIN clients c ON c.id = m.client_id
    WHERE ${mine}
    ${q ? sql`AND (c.name ILIKE ${'%' + q + '%'} OR c.client_code ILIKE ${'%' + q + '%'})` : sql``}
    ORDER BY m.client_id, m.sent_at DESC
  `);
  // Newest first, then the ceiling — BEFORE anything is counted or named.
  // The two follow-up queries then ask about at most `limit` clients rather
  // than about every client the company has ever written to, which is the
  // difference between a fixed cost and one that grows every month.
  const page = rows
    .sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime())
    .slice(0, limit);
  const ids = page.map((r) => sql`${r.client_id}`);

  // Three states, one rule, resolved over the page (round 88).
  const states = await resolveChatStates(
    page.map((r) => ({
      clientId: r.client_id,
      managerUserId: r.manager_user_id,
      peerId: r.peer_id,
      tgMessageId: r.tg_message_id,
      direction: r.direction,
      sentAt: new Date(r.sent_at),
      row: r,
    })),
  );
  const stateByClient = new Map<string, ChatState>();
  for (const [seed, state] of states) stateByClient.set(seed.clientId, state);

  // Counts for the clients actually on screen — a list of ids, never the
  // whole table. An empty page asks nothing.
  const counts = new Map<string, number>();
  if (page.length > 0) {
    const countRows = await db.execute<{ client_id: string; messages: string }>(sql`
      SELECT n.client_id, count(*) AS messages
      FROM tg_messages n
      WHERE ${mineN}
        AND n.client_id IN (${sql.join(ids, sql`, `)})
      GROUP BY n.client_id
    `);
    for (const row of countRows) counts.set(row.client_id, Number(row.messages));
  }

  // The supervision view names whose account each conversation lives on —
  // the boss reads a company of threads, and a row without its manager's
  // name is exactly the «tushunarsiz» he complained about.
  const managersByClient = new Map<string, string[]>();
  if (viewer.all && page.length > 0) {
    const nameRows = await db.execute<{ client_id: string; names: string[] }>(sql`
      SELECT m.client_id, array_agg(DISTINCT u.full_name) AS names
      FROM tg_messages m
      JOIN users u ON u.id = m.manager_user_id
      WHERE m.client_id IN (${sql.join(ids, sql`, `)})
      GROUP BY m.client_id
    `);
    for (const row of nameRows) managersByClient.set(row.client_id, row.names);
  }

  return page.map((r) => ({
      clientId: r.client_id,
      clientCode: r.client_code,
      clientName: r.client_name,
      lastAt: new Date(r.sent_at),
      lastBody: r.body,
      lastHasMedia: r.has_media,
      // The single most useful fact on the screen, and since round 88 it has
      // three values rather than two: a client who wrote «ok» is READ and
      // finished, and a mark that cannot tell that from an unanswered
      // question is a mark people stop looking at (the owner's own words).
      state: stateByClient.get(r.client_id) ?? 'answered',
      /** Kept so nothing that reads the old field breaks: the ALARM only. */
      waitingOnUs: chatNeedsAnswer(stateByClient.get(r.client_id) ?? 'answered'),
      messages: counts.get(r.client_id) ?? 0,
      managers: managersByClient.get(r.client_id) ?? [],
    }));
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
  /** Downloaded voice notes / audio files (2026-08-07) — usually empty. */
  audios: { id: string; fileName: string }[];
  /** Documents, spreadsheets, archives, clips (2026-08-11) — usually empty. */
  files: { id: string; fileName: string; sizeBytes: number }[];
  /** Telegram's numbering, needed to resolve a quote AT this message. */
  managerUserId: string;
  peerId: bigint;
  tgMessageId: bigint;
  replyToTgMessageId: bigint | null;
  /** Non-null = forwarded; '' = forwarded from a source Telegram hides. */
  fwdFrom: string | null;
  /** The quoted message, resolved over the page; null = not a reply. */
  quoted: QuotedMessage | null;
}

/** As much of a quoted message as a one-line strip can show. */
export interface QuotedMessage {
  body: string | null;
  /** '' when the target is not stored here — the strip still draws. */
  direction: string;
  hasMedia: boolean;
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
  managerId?: string,
): Promise<ConversationMessage[]> {
  // The viewer's own account only — a colleague's thread with the same
  // client is that colleague's personal Telegram, not a shared record. The
  // exception is the supervision view (`all`), where every bubble names its
  // manager — and only THERE does the optional manager filter act as the
  // owner's selector («qaysi hodim gaplashganini tanlab ko'rish»). For
  // everyone else the own-account rule already fixes whose thread this is,
  // and a foreign id in the URL must not widen it.
  const accountFilter = viewer.all
    ? managerId
      ? eq(tgMessages.managerUserId, managerId)
      : undefined
    : eq(tgMessages.managerUserId, viewer.id);
  const rows = await db
    .select({
      id: tgMessages.id,
      direction: tgMessages.direction,
      body: tgMessages.body,
      hasMedia: tgMessages.hasMedia,
      sentAt: tgMessages.sentAt,
      manager: users.fullName,
      managerUserId: tgMessages.managerUserId,
      peerId: tgMessages.peerId,
      tgMessageId: tgMessages.tgMessageId,
      replyToTgMessageId: tgMessages.replyToTgMessageId,
      fwdFrom: tgMessages.fwdFrom,
    })
    .from(tgMessages)
    .innerJoin(users, eq(tgMessages.managerUserId, users.id))
    .where(and(eq(tgMessages.clientId, clientId), accountFilter))
    .orderBy(desc(tgMessages.sentAt))
    .limit(limit);
  // The newest `limit` rows, in that order. Taking the OLDEST n would push the
  // recent end — the only part anyone reads — off a long history entirely.
  return attachQuotes(await attachMedia(rows));
}

/**
 * What each quoting message is quoting (0072).
 *
 * ONE query for the whole page, keyed on the same triple the thread's unique
 * index uses — (manager, peer, tg_message_id) — because a reply names its
 * target in TELEGRAM's numbering and that number is only unique inside one
 * manager's one dialog.
 *
 * An unresolved quote is normal and must stay cheap: a client can answer a
 * message from before the import window, or one in a chat somebody purged.
 * The bubble then draws the strip with no text rather than nothing at all —
 * «this is an answer to something» is still the fact the reader needs.
 */
export async function attachQuotes<
  T extends {
    managerUserId: string;
    peerId: bigint;
    replyToTgMessageId: bigint | null;
  },
>(rows: T[]): Promise<(T & { quoted: QuotedMessage | null })[]> {
  const wanted = rows.filter((r) => r.replyToTgMessageId !== null);
  if (wanted.length === 0) return rows.map((row) => ({ ...row, quoted: null }));
  const managers = [...new Set(wanted.map((r) => r.managerUserId))].map((id) => sql`${id}`);
  const peers = [...new Set(wanted.map((r) => String(r.peerId)))].map((p) => sql`${p}`);
  const ids = [...new Set(wanted.map((r) => String(r.replyToTgMessageId)))].map((i) => sql`${i}`);
  /**
   * The three `IN` lists are a cross product — wider than the question — and
   * that is safe only because the answer is consumed as a map keyed on the
   * exact triple, which is also this table's unique index (#598's reasoning,
   * third outing).
   */
  const found = await db.execute<{
    manager_user_id: string;
    peer_id: string;
    tg_message_id: string;
    body: string | null;
    direction: string;
    has_media: boolean;
  }>(sql`
    SELECT manager_user_id, peer_id, tg_message_id, body, direction, has_media
    FROM tg_messages
    WHERE manager_user_id IN (${sql.join(managers, sql`, `)})
      AND peer_id IN (${sql.join(peers, sql`, `)})
      AND tg_message_id IN (${sql.join(ids, sql`, `)})
  `);
  const key = (m: string, p: string | bigint, t: string | bigint) => `${m}:${p}:${t}`;
  const byKey = new Map(
    found.map((f) => [
      key(f.manager_user_id, f.peer_id, f.tg_message_id),
      { body: f.body, direction: f.direction, hasMedia: f.has_media },
    ]),
  );
  return rows.map((row) => ({
    ...row,
    quoted:
      row.replyToTgMessageId === null
        ? null
        : (byKey.get(key(row.managerUserId, row.peerId, row.replyToTgMessageId)) ?? {
            body: null,
            direction: '',
            hasMedia: false,
          }),
  }));
}

export interface ThreadManager {
  id: string;
  name: string;
  messages: number;
  /** When this manager last spoke to the client — the default's tie-break. */
  lastAt?: string | null;
}

/**
 * WHO holds a chat with this person, and how much of it — the card's
 * selector (owner: «qaysi hodimlar gaplashganiga qarab spiskasi chiqib
 * tursa, tanlab ko'rib olish uchun»). The NAMES are shared knowledge — who
 * talks is not what was said (round 20) — but READING a colleague's thread
 * still demands the supervision view; `conversationFor` holds that line.
 */
export async function threadManagers(clientId: string): Promise<ThreadManager[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.fullName,
      messages: sql<number>`count(*)`,
      // Who spoke to this client LAST. The screen opens on that person's
      // conversation, because merging several managers' chats into one
      // stream shows a conversation that never happened (see the note on
      // `defaultThreadManager`).
      lastAt: sql<string>`max(${tgMessages.sentAt})`,
    })
    .from(tgMessages)
    .innerJoin(users, eq(tgMessages.managerUserId, users.id))
    .where(eq(tgMessages.clientId, clientId))
    .groupBy(users.id, users.fullName)
    .orderBy(desc(sql`count(*)`));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    messages: Number(r.messages),
    lastAt: r.lastAt,
  }));
}

/**
 * Whose conversation the screen opens on when the reader asked for nobody in
 * particular.
 *
 * The owner: «chatni ichiga hamma odamni chatini qo'shib tashlayabti all
 * deb». He is right, and it is worse than clutter. Two managers talking to
 * one client from two personal Telegram accounts are two SEPARATE
 * conversations; interleaving them by timestamp produces a thread in which a
 * question and its answer sit next to sentences neither person ever saw —
 * a conversation that never took place, presented as a record.
 *
 * So «Hammasi» stops being the default and becomes a choice. The default is
 * the manager who spoke most RECENTLY, because a supervisor opening a client
 * is almost always asking about the live conversation, not the busiest one
 * historically. Null when there is nothing to choose between — a single
 * manager, or none.
 */
export function defaultThreadManager(managers: ThreadManager[]): string | null {
  if (managers.length < 2) return null;
  const newest = [...managers].sort((a, b) => (a.lastAt ?? '') < (b.lastAt ?? '') ? 1 : -1)[0];
  return newest?.id ?? null;
}

/**
 * Pin each message's downloaded media on (item 15; audio 2026-08-07). ONE
 * query over the page of ids, not one per row — `attachments_entity_idx`
 * covers it, and most messages have none.
 *
 * Split by KIND, and that split is load-bearing: this read fetches every
 * attachment of a `tg_message`, so the moment the listener started storing
 * voice notes, a single `photos` list would have handed a bubble an `<img>`
 * pointed at an Ogg file — a broken picture where a client's spoken message
 * should be.
 */
export async function attachMedia<T extends { id: string }>(
  rows: T[],
): Promise<
  (T & {
    photos: { id: string }[];
    audios: { id: string; fileName: string }[];
    files: { id: string; fileName: string; sizeBytes: number }[];
  })[]
> {
  if (rows.length === 0) return [];
  const mediaRows = await db
    .select({
      id: attachments.id,
      entityId: attachments.entityId,
      kind: attachments.kind,
      contentType: attachments.contentType,
      fileName: attachments.fileName,
      sizeBytes: attachments.sizeBytes,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, 'tg_message'),
        inArray(attachments.entityId, rows.map((r) => r.id)),
      ),
    )
    .orderBy(attachments.createdAt);
  const photos = new Map<string, { id: string }[]>();
  const audios = new Map<string, { id: string; fileName: string }[]>();
  const files = new Map<string, { id: string; fileName: string; sizeBytes: number }[]>();
  for (const media of mediaRows) {
    if (media.kind === 'photo') {
      photos.set(media.entityId, [...(photos.get(media.entityId) ?? []), { id: media.id }]);
    } else if (media.contentType.startsWith('audio/')) {
      audios.set(media.entityId, [
        ...(audios.get(media.entityId) ?? []),
        { id: media.id, fileName: media.fileName },
      ]);
    } else {
      // Everything else is a DOWNLOAD, not a player and not a paperclip
      // (2026-08-11: «faqat rasim emas fillar ham»). The bubble prints its
      // name and its size, because «file» with neither is not something
      // anybody can decide to open.
      files.set(media.entityId, [
        ...(files.get(media.entityId) ?? []),
        { id: media.id, fileName: media.fileName, sizeBytes: media.sizeBytes },
      ]);
    }
  }
  return rows.map((row) => ({
    ...row,
    photos: photos.get(row.id) ?? [],
    audios: audios.get(row.id) ?? [],
    files: files.get(row.id) ?? [],
  }));
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
  const rows = await db.execute<{
    client_id: string;
    direction: string;
    manager_user_id: string;
    peer_id: string;
    tg_message_id: string;
    sent_at: Date;
  }>(sql`
    SELECT DISTINCT ON (client_id)
      client_id, direction, manager_user_id, peer_id, tg_message_id, sent_at
    FROM tg_messages
    WHERE ${mine}
      -- A lead-owned chat has no client to badge (0064 relaxed the column),
      -- and postgres groups every NULL together — so without this the whole
      -- company's lead chats collapse into ONE phantom row.
      AND client_id IS NOT NULL
    ORDER BY client_id, sent_at DESC
  `);
  const states = await resolveChatStates(
    rows.map((r) => ({
      clientId: r.client_id,
      managerUserId: r.manager_user_id,
      peerId: r.peer_id,
      tgMessageId: r.tg_message_id,
      direction: r.direction,
      sentAt: new Date(r.sent_at),
    })),
  );
  // The card keeps its two marks: 💬! only for the ALARM. A chat the manager
  // has read and left ('seen') is an ordinary 💬 — the owner's «ok» case.
  const out = new Map<string, 'waiting' | 'yes'>();
  for (const [seed, state] of states) {
    out.set(seed.clientId, chatNeedsAnswer(state) ? 'waiting' : 'yes');
  }
  return out;
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

/**
 * "I have read this here" — the second door into the same mark.
 *
 * Telegram's own read receipt is the primary signal and needs nobody to
 * press anything (see the listener). This covers the manager who reads the
 * conversation on OUR screen instead: the owner's words were «chatni ichiga
 * kirgandan keyin tohtatish», and to him both screens are the chat.
 *
 * Own account only, and that is a property of the WHERE rather than a check
 * anybody could forget: the rows counted are the ones whose
 * `manager_user_id` IS the reader. A supervisor (round 33 `seesAllTg`) opens
 * the same screen, matches no rows and writes nothing — their glance must
 * never silence a colleague's alarm.
 *
 * `GREATEST` in the conflict clause for the same reason the listener's write
 * has it: this can arrive after a newer Telegram receipt.
 */
export async function markThreadRead(clientId: string, actorId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO tg_chat_reads (manager_user_id, peer_id, last_read_tg_message_id)
    SELECT m.manager_user_id, m.peer_id, max(m.tg_message_id)
    FROM tg_messages m
    WHERE m.client_id = ${clientId}::uuid
      AND m.manager_user_id = ${actorId}::uuid
      AND m.direction = 'in'
    GROUP BY m.manager_user_id, m.peer_id
    ON CONFLICT (manager_user_id, peer_id) DO UPDATE
      SET last_read_tg_message_id =
            GREATEST(tg_chat_reads.last_read_tg_message_id, EXCLUDED.last_read_tg_message_id),
          read_at = now()
  `);
}

/**
 * The two facts `chatState` needs that the newest-message row cannot carry:
 * how far the manager has READ, and whether a reply is already on its way.
 *
 * Two GROUPED queries over the rows already on screen — never a subquery in
 * a `DISTINCT ON` projection, which is what round 74 had to take back out of
 * `listConversations` after it measured 916 ms at 100,000 messages. An empty
 * page asks nothing.
 *
 * Exported because FOUR screens decide «is this waiting» and they must decide
 * it the same way (#513): the conversations list, the funnel card badges, the
 * seller's home counter and the Telegram reminder.
 */
export interface ChatStateSeed {
  clientId: string;
  managerUserId: string;
  peerId: string | bigint;
  tgMessageId: string | bigint;
  direction: string;
  sentAt: Date;
}

export async function resolveChatStates<T extends ChatStateSeed>(
  seeds: T[],
): Promise<Map<T, ChatState>> {
  const out = new Map<T, ChatState>();
  if (seeds.length === 0) return out;

  const managers = [...new Set(seeds.map((s) => s.managerUserId))].map((id) => sql`${id}`);
  const peers = [...new Set(seeds.map((s) => String(s.peerId)))].map((p) => sql`${p}`);
  const clientIds = [...new Set(seeds.map((s) => s.clientId))].map((id) => sql`${id}`);

  /**
   * The read pointers. The two `IN` lists are a cross product — wider than
   * the question — and that is safe ONLY because the answer is consumed as a
   * map keyed on the exact (manager, peer) pair, which is also this table's
   * primary key. The same reasoning `offerableMatches` records (#598).
   */
  const readRows = await db.execute<{
    manager_user_id: string;
    peer_id: string;
    last_read_tg_message_id: string;
  }>(sql`
    SELECT manager_user_id, peer_id, last_read_tg_message_id
    FROM tg_chat_reads
    WHERE manager_user_id IN (${sql.join(managers, sql`, `)})
      AND peer_id IN (${sql.join(peers, sql`, `)})
  `);
  const reads = new Map(
    readRows.map((r) => [`${r.manager_user_id}:${r.peer_id}`, BigInt(r.last_read_tg_message_id)]),
  );

  /**
   * The newest reply on its way out, per (client, manager).
   *
   * `queued`, `sending` and `sent` all count: a reply somebody typed IS an
   * answer, and whether the socket has agreed yet is the listener's problem,
   * not the alarm's. `failed` and `cancelled` deliberately do not — those are
   * exactly the cases where the customer is still waiting and nobody knows.
   */
  const outRows = await db.execute<{
    client_id: string;
    manager_user_id: string;
    last_out: Date;
  }>(sql`
    SELECT client_id, manager_user_id, max(queued_at) AS last_out
    FROM tg_outbox
    WHERE status IN ('queued', 'sending', 'sent')
      AND client_id IN (${sql.join(clientIds, sql`, `)})
    GROUP BY client_id, manager_user_id
  `);
  const pending = new Map(
    outRows.map((r) => [`${r.client_id}:${r.manager_user_id}`, new Date(r.last_out)]),
  );

  for (const seed of seeds) {
    const lastOut = pending.get(`${seed.clientId}:${seed.managerUserId}`);
    out.set(
      seed,
      chatState({
        lastDirection: seed.direction,
        lastInboundTgId: seed.direction === 'in' ? BigInt(seed.tgMessageId) : null,
        lastReadTgId: reads.get(`${seed.managerUserId}:${String(seed.peerId)}`) ?? null,
        replyPending: lastOut ? lastOut > new Date(seed.sentAt) : false,
      }),
    );
  }
  return out;
}
