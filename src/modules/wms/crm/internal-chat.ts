import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, deals, leads, users } from '../../platform/db/schema';
import { noteLinksFor } from '../calc/card-door';
import { SECTION_LABEL, type CalcSection } from '../calc/intake';
import { notifyStaffTelegram, userName } from '../../platform/notifications/staff';
import { userPermissions } from '../../platform/rbac/authorize';
import type { ThreadRef } from '../../platform/notifications/thread-ref';
import { extractMentions, type MentionPerson } from './mentions';
import { canLogInSql } from '../../platform/users/login';
import { threadDoorWith, threadFacts } from './thread-door';
import { calcThreadAuthors } from './thread';

/**
 * The internal conversation, carried by Telegram — and, since the owner's E
 * answers (2026-10-07), carried BACK: a swipe-reply to a ping lands on the
 * card as the next message of the same thread (reply-door.ts).
 *
 * Owner: "ichki chatni telegramda olib borishni belgila — CRM va BITIM uchun
 * chatlar bo'lishi kerak ichki hodimlar bilan." The record lives on the card
 * (`crm_activities`, where a note has always lived); what makes it a CHAT is
 * that writing one pings the right colleagues in Telegram, with a link back to
 * the card, so the reply happens where people already are.
 *
 * WHO gets pinged is the design decision: the OWNER of the record (a lead's
 * or deal's carrier — and for a CLIENT, its seller, E6 c), plus everyone who
 * has already written in this thread — the thread's participants. Not a role
 * broadcast: a message to "all of sales" about every note on every card is a
 * channel people mute in a week, and then the one note that mattered is muted
 * with it. You join a card's conversation by speaking in it.
 *
 * And it is decided at SEND time (E9 a, G4 a): whoever the thread's door no
 * longer admits stops hearing it — a seller whose lead was handed on — with
 * two reply-only exceptions that keep the people who carry the work: the
 * record's current owner and a calc request's non-CRM requester («standing»,
 * thread-door.ts). A card has TWO kinds of thread: its untagged notes, and
 * one per calculation (the tagged notes) — a VED who asks one calc question
 * does not become a participant of the seller's whole lead conversation.
 */

/** The thread a note belongs to — the card's, or its calculation's. */
function threadOf(entityType: 'client' | 'lead' | 'deal', entityId: string, calcRequestId: string | null): ThreadRef {
  return calcRequestId ? { kind: 'calc', id: calcRequestId } : { kind: entityType, id: entityId };
}

/** The person carrying a lead or a deal — its CURRENT owner. */
async function ownerOf(entityType: 'lead' | 'deal', entityId: string): Promise<string | null> {
  if (entityType === 'lead') {
    const row = await db.query.leads.findFirst({ columns: { ownerId: true }, where: eq(leads.id, entityId) });
    return row?.ownerId ?? null;
  }
  const row = await db.query.deals.findFirst({ columns: { ownerId: true }, where: eq(deals.id, entityId) });
  return row?.ownerId ?? null;
}

/**
 * Who a calc thread's ROLES are — its requester and its calculator — and the
 * card it stands on now (a request follows a won lead to its deal).
 */
async function calcRoles(requestId: string): Promise<{
  requestedBy: string | null;
  assigneeId: string | null;
  entityType: 'lead' | 'deal';
  entityId: string;
  section: string | null;
} | null> {
  const rows = await db.execute<{
    requested_by: string | null;
    assignee_id: string | null;
    entity_type: string;
    entity_id: string;
    section: string | null;
  }>(sql`
    SELECT requested_by::text AS requested_by, assignee_id::text AS assignee_id,
           entity_type, entity_id::text AS entity_id, section
      FROM calc_requests WHERE id = ${requestId}::uuid
  `);
  const row = rows[0];
  if (!row || (row.entity_type !== 'lead' && row.entity_type !== 'deal')) return null;
  return {
    requestedBy: row.requested_by,
    assigneeId: row.assignee_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    section: row.section,
  };
}

/**
 * The thread's candidates — before any door is asked. `arms` carry the work
 * and are never judged by involvement (they ARE it); `owner` is the record's
 * current carrier, who stands on the thread even past its door (§3.4);
 * `past` are the participants and `requester` the calc job's asker, whom the
 * filters judge.
 */
interface Candidates {
  owner: string | null;
  arms: string[];
  requester: string | null;
  past: string[];
}

async function candidatesOf(
  entityType: 'client' | 'lead' | 'deal',
  entityId: string,
  calcRequestId: string | null,
): Promise<Candidates> {
  if (calcRequestId) {
    const roles = await calcRoles(calcRequestId);
    // The request's CURRENT card — a won lead's request stands on the deal now.
    const owner = roles ? await ownerOf(roles.entityType, roles.entityId) : null;
    return {
      owner,
      arms: [owner, roles?.assigneeId ?? null].filter((id): id is string => id !== null),
      requester: roles?.requestedBy ?? null,
      past: await calcThreadAuthors(calcRequestId),
    };
  }
  // Everyone who has spoken in this card's OWN thread — its untagged notes.
  // The tag is read through the row's json (to_jsonb), never bare: the lenta's
  // announce must keep working on a database one migration behind (0127,
  // thread.ts's header), where the column does not exist and this reads NULL.
  const authors = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT a.created_by::text AS id FROM crm_activities a
     WHERE a.entity_type = ${entityType} AND a.entity_id = ${entityId}::uuid
       AND a.created_by IS NOT NULL
       AND (to_jsonb(a) ->> 'calc_request_id') IS NULL
  `);
  if (entityType === 'client') {
    // E6 c — the logist's question on the client card reaches whoever is
    // working that client: its seller, and the owner of an open lead or deal
    // of it (a lead card's note lands on its client's thread, so the lead's
    // seller hears it there, §8). A client thread had no owner arm at all.
    return { owner: null, arms: [...(await involvedWith({ kind: 'client', id: entityId }))], requester: null, past: authors.map((a) => a.id) };
  }
  const owner = await ownerOf(entityType, entityId);
  return { owner, arms: owner ? [owner] : [], requester: null, past: authors.map((a) => a.id) };
}

/**
 * E9 on DEAL and CLIENT threads (§3.4 filter 2): their doors have no
 * ownership, so a past participant whose only standing is plain `crm.leads`
 * stays only while still INVOLVED with that client — its seller, the deal's
 * owner, or the owner of an open lead or open deal of that client. One
 * grouped statement for the client; the carriers never pass through here.
 */
async function involvedWith(thread: { kind: 'deal' | 'client'; id: string }): Promise<Set<string>> {
  const rows = await db.execute<{ id: string | null }>(sql`
    WITH k AS (
      SELECT ${thread.kind === 'client' ? sql`${thread.id}::uuid` : sql`(SELECT client_id FROM deals WHERE id = ${thread.id}::uuid)`} AS client_id
    )
    SELECT c.sales_manager_id::text AS id FROM clients c, k WHERE c.id = k.client_id
    UNION
    SELECT l.owner_id::text FROM leads l JOIN lead_stages s ON s.id = l.stage_id, k
     WHERE l.client_id = k.client_id AND s.kind = 'open'
    UNION
    SELECT d.owner_id::text FROM deals d JOIN deal_stages s ON s.id = d.stage_id, k
     WHERE d.client_id = k.client_id AND s.kind = 'open'
    ${thread.kind === 'deal' ? sql`UNION SELECT owner_id::text FROM deals WHERE id = ${thread.id}::uuid` : sql``}
  `);
  return new Set(rows.map((r) => r.id).filter((id): id is string => id !== null));
}

/** Plain `crm.leads` and nothing that reads every card — the filter-2 standing. */
function plainSeller(grants: Set<string>): boolean {
  return (
    grants.has('crm.leads') &&
    !grants.has('crm.leads.view_all') &&
    !grants.has('clients.manage') &&
    !grants.has('ved.docs')
  );
}

/** What the audience of one note IS — who hears it with the card, who only by standing. */
export interface ThreadAudience {
  /** Admitted by the door: they get the ping WITH their link. */
  heard: string[];
  /** Kept by standing alone (§3.4): the ping carries no link; they may reply. */
  standingOnly: string[];
  /** Each recipient's grants, loaded once — the link is chosen from these. */
  grants: Map<string, Set<string>>;
}

/**
 * The audience of a note — candidates, then the three filters (§3.4): the
 * door (E9 on leads, the old write gap's posters, a VED author on a plain
 * lead), involvement (E9 on deals and clients), and standing (G4 a). The
 * author is never in it. Exported so the calc action can tell the box who
 * will not hear (the same answer, not a second rule).
 */
export async function threadAudience(
  entityType: 'client' | 'lead' | 'deal',
  entityId: string,
  calcRequestId: string | null,
  authorId: string | null,
): Promise<ThreadAudience> {
  const thread = threadOf(entityType, entityId, calcRequestId);
  const [facts, cand] = await Promise.all([
    threadFacts(thread),
    candidatesOf(entityType, entityId, calcRequestId),
  ]);
  const ids = [
    ...new Set(
      [...cand.arms, cand.requester, ...cand.past].filter(
        (id): id is string => id !== null && id !== authorId,
      ),
    ),
  ];
  const grants = new Map<string, Set<string>>();
  for (const id of ids) grants.set(id, await userPermissions(id));
  // Where the involvement filter applies: a deal or client card thread, and a
  // calculation whose card is a deal (its door is the deal lenta's).
  const filterOn: { kind: 'deal' | 'client'; id: string } | null =
    thread.kind === 'deal' || thread.kind === 'client'
      ? { kind: thread.kind, id: thread.id }
      : calcRequestId && entityType === 'deal'
        ? { kind: 'deal', id: entityId }
        : null;
  let involved: Set<string> | null = null;
  const heard: string[] = [];
  const standingOnly: string[] = [];
  for (const id of ids) {
    const mine = grants.get(id)!;
    const door = threadDoorWith({ id, permissions: mine }, facts);
    const standing =
      id === cand.owner || (calcRequestId !== null && id === cand.requester && !mine.has('crm.leads'));
    if (!door) {
      if (standing) standingOnly.push(id);
      continue;
    }
    if (filterOn && !cand.arms.includes(id) && plainSeller(mine)) {
      involved ??= await involvedWith(filterOn);
      if (!involved.has(id)) continue;
    }
    heard.push(id);
  }
  return { heard, standingOnly, grants };
}

/**
 * Who a note pings — the audience above, as one list. `calcRequestId` is
 * REQUIRED (#790): a note is either the card's or its calculation's, and a
 * caller that forgot to say which would ping the wrong thread.
 */
export async function noteRecipients(
  entityType: 'client' | 'lead' | 'deal',
  entityId: string,
  calcRequestId: string | null,
): Promise<string[]> {
  const audience = await threadAudience(entityType, entityId, calcRequestId, null);
  return [...audience.heard, ...audience.standingOnly];
}

/** What to call the card in a one-line Telegram message. */
export async function cardLabel(
  entityType: 'client' | 'lead' | 'deal',
  entityId: string,
): Promise<string> {
  if (entityType === 'client') {
    const row = await db.query.clients.findFirst({ where: eq(clients.id, entityId) });
    return row ? `${row.clientCode} ${row.name}` : 'mijoz';
  }
  if (entityType === 'deal') {
    const row = await db.query.deals.findFirst({ where: eq(deals.id, entityId) });
    return row ? `${row.code}${row.title ? ` ${row.title}` : ''}` : 'bitim';
  }
  const row = await db.query.leads.findFirst({ where: eq(leads.id, entityId) });
  return row?.name ?? 'lid';
}

/**
 * Everyone a mention can name. One source of truth for the composer's
 * dropdown and the save-time parser, so what the dropdown offers is exactly
 * what the parser will find.
 */
export async function mentionablePeople(): Promise<MentionPerson[]> {
  return db
    .select({ id: users.id, name: users.fullName })
    .from(users)
    // A colleague NOW (`canLogIn`, 0120): a typed name never mentions a person
    // who never signs in — they would never read it.
    .where(canLogInSql())
    .orderBy(asc(users.fullName));
}

interface NoteInput {
  entityType: 'client' | 'lead' | 'deal';
  entityId: string;
  note: string;
  authorId: string;
  /** The note's own row — what a Telegram reply to this ping lands back on. REQUIRED. */
  activityId: string;
  /** The calculation this note is about, or null for the card's own thread. REQUIRED. */
  calcRequestId: string | null;
}

/** The three ping kinds a thread sends (thread-ref.ts `THREAD_PING_TYPES`). */
export type ThreadPing = 'InternalNote' | 'MentionedInNote' | 'CalcThread';

/**
 * The ping's text — ONE pure function, so a test can assert the line order.
 * The «↩️» line says the message can be answered by a reply; the CalcThread
 * one also names WHERE to answer on the web — not the ordinary lenta box,
 * which never reaches the VED (§3.5 c). The 🔗 line must stay LAST: the drain
 * lifts the last line into the «↗️ Ochish» button only when it is the link
 * (`takeOwnLink`, staff-html.ts), so every new line goes ABOVE it.
 */
export function threadPingText(input: {
  type: ThreadPing;
  author: string;
  label: string;
  note: string;
  link: string | null;
}): string {
  const head =
    input.type === 'InternalNote' ? '📝' : input.type === 'MentionedInNote' ? '📣' : '❓';
  const reply =
    input.type === 'CalcThread'
      ? '↩️ Javob uchun shu xabarga reply qiling (yoki kartadagi «❓ Savol-javob»da yozing)'
      : '↩️ Javob uchun shu xabarga reply qiling';
  return (
    `${head} ${input.author} · ${input.label}\n` +
    // Enough to answer from the phone; the card has the rest.
    `${input.note.slice(0, 400)}${input.note.length > 400 ? '…' : ''}\n` +
    reply +
    (input.link ? `\n🔗 ${input.link}` : '')
  );
}

/** What the calc thread is called in a ping: «🧮 <card> · <section>». */
async function threadLabel(input: NoteInput): Promise<string> {
  const card = await cardLabel(input.entityType, input.entityId);
  if (!input.calcRequestId) return card;
  const roles = await calcRoles(input.calcRequestId);
  const section =
    roles?.section && Object.hasOwn(SECTION_LABEL, roles.section)
      ? ` · ${SECTION_LABEL[roles.section as CalcSection]}`
      : '';
  return `🧮 ${card}${section}`;
}

/**
 * Each recipient's link (§3.4): a card thread keeps `noteLinksFor`'s rule —
 * the card for whoever it admits, the karta for a calculator, nothing for
 * anybody else; a calc thread links a VED to the calc page's Q&A and anybody
 * else to the card's fold of THIS calculation. A standing-only recipient gets
 * none: the door did not admit him, and a link that bounces is a dead door.
 */
async function linksFor(
  input: NoteInput,
  ids: readonly string[],
  audience: Pick<ThreadAudience, 'standingOnly' | 'grants'>,
): Promise<Map<string, string | null>> {
  const cardLinks = await noteLinksFor(
    { entityType: input.entityType, entityId: input.entityId },
    ids,
    audience.grants,
  );
  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '');
  const out = new Map<string, string | null>();
  for (const id of ids) {
    if (audience.standingOnly.includes(id)) {
      out.set(id, null);
      continue;
    }
    if (!input.calcRequestId) {
      out.set(id, cardLinks.get(id) ?? null);
      continue;
    }
    const grants = audience.grants.get(id) ?? (await userPermissions(id));
    if (grants.has('ved.docs')) {
      out.set(id, `${appUrl}/hisoblash/${input.calcRequestId}#savol`);
      continue;
    }
    const card = cardLinks.get(id) ?? null;
    out.set(id, card ? `${card}#calc-thread-${input.calcRequestId}` : null);
  }
  return out;
}

/**
 * One message per LINK, not one for everybody (docs/VED-TARIX.md §10, review
 * access-money-4) — and every one carries `extra.thread` (jsonb, no
 * migration), so a Telegram reply maps back to this note's thread and the
 * dock can list it.
 */
async function notifyByLink(
  input: NoteInput,
  userIds: readonly string[],
  audience: Pick<ThreadAudience, 'standingOnly' | 'grants'>,
  build: (link: string | null) => { type: ThreadPing; text: string },
): Promise<void> {
  const ids = userIds.filter((id) => id !== input.authorId);
  if (ids.length === 0) return;
  const links = await linksFor(input, ids, audience);
  const groups = new Map<string | null, string[]>();
  for (const id of ids) {
    const link = links.get(id) ?? null;
    groups.set(link, [...(groups.get(link) ?? []), id]);
  }
  const thread = threadOf(input.entityType, input.entityId, input.calcRequestId);
  for (const [link, group] of groups) {
    const { type, text } = build(link);
    await notifyStaffTelegram({
      userIds: group,
      exceptUserId: input.authorId,
      type,
      text,
      extra: { thread: { kind: thread.kind, id: thread.id, activityId: input.activityId } },
    });
  }
}

/**
 * Tell the people NAMED in a note — and only them.
 *
 * Its own function because the contact-log path deliberately broadcasts to
 * nobody: a phone-call record is a record, not a conversation. A mention in
 * it is different — it is the author explicitly calling a colleague over,
 * which is the one thing that must always get through. Its own notification
 * type, so a person can mute the thread chatter and still hear their name.
 *
 * Mentions are NOT filtered by the door (E2 a): the named person hears it and
 * may reply from Telegram even when he cannot open the card — the text, with
 * no link.
 */
export async function announceMentions(input: NoteInput): Promise<string[]> {
  const mentioned = extractMentions(input.note, await mentionablePeople()).filter((id) => id !== input.authorId);
  if (mentioned.length === 0) return [];
  const thread = threadOf(input.entityType, input.entityId, input.calcRequestId);
  const facts = await threadFacts(thread);
  const grants = new Map<string, Set<string>>();
  for (const id of mentioned) grants.set(id, await userPermissions(id));
  // Door-less mentions get the text without a link — the same as a standing-only recipient.
  const doorless = mentioned.filter((id) => !threadDoorWith({ id, permissions: grants.get(id)! }, facts));
  const [label, author] = await Promise.all([threadLabel(input), userName(input.authorId)]);
  await notifyByLink(input, mentioned, { standingOnly: doorless, grants }, (link) => ({
    type: 'MentionedInNote',
    text: threadPingText({ type: 'MentionedInNote', author, label, note: input.note, link }),
  }));
  return mentioned;
}

/**
 * A note landed — tell the thread. Returns WHO it told: `heard` with the
 * card, `standingOnly` by standing (§3.4) — the calc action turns the rest of
 * its expected people into words on the box.
 *
 * Fire-and-forget from the caller's point of view: a note that saved but did
 * not ping is a small failure, a note that refused to save because Telegram
 * hiccuped would be a large one.
 *
 * A mentioned colleague gets the 📣 mention ping INSTEAD of the thread copy,
 * never both — one note, one message per person.
 */
export async function announceNote(input: NoteInput): Promise<{ heard: string[]; standingOnly: string[] }> {
  const mentioned = await announceMentions(input);
  const [audience, label, author] = await Promise.all([
    threadAudience(input.entityType, input.entityId, input.calcRequestId, input.authorId),
    threadLabel(input),
    userName(input.authorId),
  ]);
  // The two types written as literals: the derived mute fence
  // (topshiriq-wire.test.ts) reads every `type: '…'` a sending file names.
  await notifyByLink(
    input,
    [...audience.heard, ...audience.standingOnly].filter((id) => !mentioned.includes(id)),
    audience,
    (link) =>
      input.calcRequestId
        ? { type: 'CalcThread', text: threadPingText({ type: 'CalcThread', author, label, note: input.note, link }) }
        : { type: 'InternalNote', text: threadPingText({ type: 'InternalNote', author, label, note: input.note, link }) },
  );
  return { heard: audience.heard, standingOnly: audience.standingOnly };
}
