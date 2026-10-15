import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, deals, leads, users } from '../../platform/db/schema';
import { noteLinksFor } from '../calc/card-door';
import { SECTION_LABEL, type CalcSection } from '../calc/intake';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../../platform/i18n/locales';
import { notificationLabels } from '../../platform/notifications/labels';
import { notifyStaffTelegram, userName } from '../../platform/notifications/staff';
import { actorGrants, type ActorGrants } from '../../platform/rbac/authorize';
import { threadKey, type CardKind, type ThreadRef } from '../../platform/notifications/thread-ref';
import { extractMentions, type MentionPerson } from './mentions';
import { canLogInSql } from '../../platform/users/login';
import {
  cargoArms,
  cargoFramingOf,
  cargoNowLine,
  cargoThreadLink,
  type CargoFraming,
} from './cargo-thread';
import type { CargoStand } from '../inventory/stands';
import { threadDoorsWith, threadFacts, type ThreadFacts, type ThreadReader } from './thread-door';
import { calcThreadAuthors, threadLabels } from './thread';
import { involvedWith, plainSeller } from './thread-involvement';

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
 * A prixod's or a truck's thread (round 2, 0129) has no owner: its arm is the
 * CARGO's (cargo-thread.ts) — an office writer reaches the staff of the
 * warehouse where the cargo stands, a warehouse writer reaches the logists —
 * and its ping's frame follows each recipient's language.
 *
 * And it is decided at SEND time (E9 a, G4 a): whoever the thread's door no
 * longer admits stops hearing it — a seller whose lead was handed on, an
 * operator whose cargo left his warehouse — with two reply-only exceptions
 * that keep the people who carry the work: the record's current owner and a
 * calc request's non-CRM requester («standing», thread-door.ts). A card has
 * TWO kinds of thread: its untagged notes, and one per calculation (the
 * tagged notes) — a VED who asks one calc question does not become a
 * participant of the seller's whole lead conversation.
 */

/** The thread a note belongs to — the card's, or its calculation's. */
function threadOf(entityType: CardKind, entityId: string, calcRequestId: string | null): ThreadRef {
  return calcRequestId ? { kind: 'calc', id: calcRequestId } : { kind: entityType, id: entityId };
}

/** The person carrying a lead or a deal — its CURRENT owner. */
async function ownerOf(entityType: 'lead' | 'deal', entityId: string): Promise<string | null> {
  switch (entityType) {
    case 'lead': {
      const row = await db.query.leads.findFirst({ columns: { ownerId: true }, where: eq(leads.id, entityId) });
      return row?.ownerId ?? null;
    }
    case 'deal': {
      const row = await db.query.deals.findFirst({ columns: { ownerId: true }, where: eq(deals.id, entityId) });
      return row?.ownerId ?? null;
    }
    default: {
      const never: never = entityType;
      void never;
      return null;
    }
  }
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

/** What a cargo thread's arm came to — for the box's three warnings (the action reads it, never recomputes). */
export interface CargoReach {
  /** `staff`: the office asked the warehouse; `office`: the warehouse asked the logists. */
  to: 'staff' | 'office';
  /** The arm's people, minus the author — before the door. */
  armIds: string[];
  /** Standing warehouses with NOBODY assigned (meaningful for `staff` only). */
  noStaffAt: string[];
}

/**
 * The thread's candidates — before any door is asked. `arms` carry the work
 * and are never judged by involvement (they ARE it); `owner` is the record's
 * current carrier, who stands on the thread even past its door (§3.4);
 * `past` are the participants and `requester` the calc job's asker, whom the
 * filters judge. `cargo` is the cargo arm's own account of itself.
 */
interface Candidates {
  owner: string | null;
  arms: string[];
  requester: string | null;
  past: string[];
  cargo: CargoReach | null;
}

/** A cargo thread's stand out of its loaded facts — no stand for any other kind (or a vanished card). */
function cargoStandOf(facts: ThreadFacts | null): CargoStand {
  if (!facts) return { warehouseIds: [], places: [] };
  switch (facts.kind) {
    case 'receipt':
    case 'batch':
      return facts.stand;
    case 'lead':
    case 'deal':
    case 'client':
    case 'calc':
      return { warehouseIds: [], places: [] };
    default: {
      const never: never = facts;
      void never;
      return { warehouseIds: [], places: [] };
    }
  }
}

/** Everyone who has spoken in this card's OWN thread — its untagged notes. */
async function pastAuthors(entityType: CardKind, entityId: string): Promise<string[]> {
  // The tag is read through the row's json (to_jsonb), never bare: the
  // lenta's announce must keep working on a database one migration behind
  // (0127, thread.ts's header), where the column does not exist and this
  // reads NULL.
  const authors = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT a.created_by::text AS id FROM crm_activities a
     WHERE a.entity_type = ${entityType} AND a.entity_id = ${entityId}::uuid
       AND a.created_by IS NOT NULL
       AND (to_jsonb(a) ->> 'calc_request_id') IS NULL
  `);
  return authors.map((a) => a.id);
}

async function candidatesOf(
  entityType: CardKind,
  entityId: string,
  calcRequestId: string | null,
  facts: ThreadFacts | null,
  authorId: string | null,
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
      cargo: null,
    };
  }
  switch (entityType) {
    case 'client':
      // E6 c — the logist's question on the client card reaches whoever is
      // working that client: its seller, and the owner of an open lead or deal
      // of it (a lead card's note lands on its client's thread, so the lead's
      // seller hears it there, §8). A client thread had no owner arm at all.
      return {
        owner: null,
        arms: [...(await involvedWith({ kind: 'client', id: entityId }))],
        requester: null,
        past: await pastAuthors(entityType, entityId),
        cargo: null,
      };
    case 'lead':
    case 'deal': {
      const [owner, past] = await Promise.all([ownerOf(entityType, entityId), pastAuthors(entityType, entityId)]);
      return { owner, arms: owner ? [owner] : [], requester: null, past, cargo: null };
    }
    case 'receipt':
    case 'batch': {
      // E6 c, the warehouse half: the cargo's arm, judged from the AUTHOR —
      // is he staff of a warehouse where it stands? (cargo-thread.ts). A note
      // with no author (`noteRecipients`) asks the warehouse.
      const stand = cargoStandOf(facts);
      const author: ThreadReader | null = authorId ? { id: authorId, ...(await actorGrants(authorId)) } : null;
      const [arms, past] = await Promise.all([cargoArms(author, stand), pastAuthors(entityType, entityId)]);
      const armIds =
        arms.to === 'office' ? arms.ids : [...new Set([...arms.byWarehouse.values()].flat())];
      const noStaffAt =
        arms.to === 'staff' ? [...arms.byWarehouse].filter(([, ids]) => ids.length === 0).map(([w]) => w) : [];
      const others = armIds.filter((id) => id !== authorId);
      return {
        owner: null,
        arms: others,
        requester: null,
        past,
        cargo: { to: arms.to, armIds: others, noStaffAt },
      };
    }
    default: {
      const never: never = entityType;
      void never;
      return { owner: null, arms: [], requester: null, past: [], cargo: null };
    }
  }
}

/** What the audience of one note IS — who hears it with the card, who only by standing. */
export interface ThreadAudience {
  /** Admitted by the door: they get the ping WITH their link. */
  heard: string[];
  /** Kept by standing alone (§3.4): the ping carries no link; they may reply. */
  standingOnly: string[];
  /** Each recipient's grants AND scope, loaded once — the door and the link are chosen from these. */
  grants: Map<string, ActorGrants>;
  /** A cargo thread's arm, for the box's warnings — null for the CRM kinds. */
  cargo: CargoReach | null;
}

/**
 * Where the involvement filter applies (§3.4 filter 2): a deal or client card
 * thread, and a calculation whose card is a deal (its door is the deal
 * lenta's). Never a lead (its door does E9) and never cargo (the door is the
 * whole rule; a plain seller never passes it).
 */
function involvementFilterOf(
  entityType: CardKind,
  entityId: string,
  calcRequestId: string | null,
): { kind: 'deal' | 'client'; id: string } | null {
  switch (entityType) {
    case 'deal':
      return { kind: 'deal', id: entityId };
    case 'client':
      return calcRequestId ? null : { kind: 'client', id: entityId };
    case 'lead':
    case 'receipt':
    case 'batch':
      return null;
    default: {
      const never: never = entityType;
      void never;
      return null;
    }
  }
}

/**
 * The audience of a note — candidates, then the three filters (§3.4): the
 * door (E9 on leads, the old write gap's posters, a VED author on a plain
 * lead, an operator whose cargo moved on), involvement (E9 on deals and
 * clients), and standing (G4 a). The author is never in it. Exported so the
 * calc and cargo actions can tell the box who will not hear (the same answer,
 * not a second rule). `pre` hands over the thread's facts when the caller
 * already loaded them (`announceNote` — once for the mentions, the audience
 * and the frame).
 */
export async function threadAudience(
  entityType: CardKind,
  entityId: string,
  calcRequestId: string | null,
  authorId: string | null,
  pre?: { facts: ThreadFacts | null },
): Promise<ThreadAudience> {
  const thread = threadOf(entityType, entityId, calcRequestId);
  const facts = pre ? pre.facts : await threadFacts(thread);
  const cand = await candidatesOf(entityType, entityId, calcRequestId, facts, authorId);
  const ids = [
    ...new Set(
      [...cand.arms, cand.requester, ...cand.past].filter(
        (id): id is string => id !== null && id !== authorId,
      ),
    ),
  ];
  // The grants AND the scope — the cargo door is a question about WHERE a
  // person works (three statements per person against round 1's one; off the
  // bot's poller, measured and reported).
  const grants = new Map<string, ActorGrants>();
  for (const id of ids) grants.set(id, await actorGrants(id));
  const doors = await threadDoorsWith(
    ids.map((id) => ({ id, ...grants.get(id)! })),
    facts,
  );
  const filterOn = involvementFilterOf(entityType, entityId, calcRequestId);
  let involved: Set<string> | null = null;
  const heard: string[] = [];
  const standingOnly: string[] = [];
  for (const id of ids) {
    const mine = grants.get(id)!.permissions;
    const standing =
      id === cand.owner || (calcRequestId !== null && id === cand.requester && !mine.has('crm.leads'));
    if (!doors.has(id)) {
      if (standing) standingOnly.push(id);
      continue;
    }
    // Filter 2 judges PAST AUTHORS only (§3.4): the calc job's requester is
    // not a participant who drifted in — he asked for this calculation, and a
    // seller whose request joined somebody else's (or nobody's) open deal
    // through `dealFor` is still the person waiting for its answer.
    if (filterOn && !cand.arms.includes(id) && id !== cand.requester && plainSeller(mine)) {
      involved ??= await involvedWith(filterOn);
      if (!involved.has(id)) continue;
    }
    heard.push(id);
  }
  return { heard, standingOnly, grants, cargo: cand.cargo };
}

/**
 * Who a note pings — the audience above, as one list. `calcRequestId` is
 * REQUIRED (#790): a note is either the card's or its calculation's, and a
 * caller that forgot to say which would ping the wrong thread.
 */
export async function noteRecipients(
  entityType: CardKind,
  entityId: string,
  calcRequestId: string | null,
): Promise<string[]> {
  const audience = await threadAudience(entityType, entityId, calcRequestId, null);
  return [...audience.heard, ...audience.standingOnly];
}

/** What to call the card in a one-line Telegram message. */
export async function cardLabel(entityType: CardKind, entityId: string): Promise<string> {
  switch (entityType) {
    case 'client': {
      const row = await db.query.clients.findFirst({ where: eq(clients.id, entityId) });
      return row ? `${row.clientCode} ${row.name}` : 'mijoz';
    }
    case 'deal': {
      const row = await db.query.deals.findFirst({ where: eq(deals.id, entityId) });
      return row ? `${row.code}${row.title ? ` ${row.title}` : ''}` : 'bitim';
    }
    case 'lead': {
      const row = await db.query.leads.findFirst({ where: eq(leads.id, entityId) });
      return row?.name ?? 'lid';
    }
    // One label rule for the cargo cards — the dock's (`threadLabels`).
    case 'receipt': {
      const ref = { kind: entityType, id: entityId };
      return (await threadLabels([ref])).get(threadKey(ref))?.label ?? 'prixod';
    }
    case 'batch': {
      const ref = { kind: entityType, id: entityId };
      return (await threadLabels([ref])).get(threadKey(ref))?.label ?? 'mashina';
    }
    default: {
      const never: never = entityType;
      void never;
      return '—';
    }
  }
}

/**
 * What a door-LESS reader — a @-named colleague the card does not admit — is
 * told the card is called: its identity, never its facts. A truck's label is
 * the dock's «🚚 code · origin → dest», and the route is exactly what the
 * dropped «📍» line withholds from him (§3.8), so the truck goes by its code
 * alone. Every other card's label already IS its identity (a prixod's number
 * and the box's marking or code — what round 1 tells a door-less mention too).
 */
export function doorlessLabel(entityType: CardKind, label: string): string {
  switch (entityType) {
    case 'batch':
      return label.split(' · ')[0] ?? label;
    case 'receipt':
    case 'lead':
    case 'deal':
    case 'client':
      return label;
    default: {
      const never: never = entityType;
      void never;
      return label;
    }
  }
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
  entityType: CardKind;
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

/** One recipient group's frame — a cargo ping's place line and reply hint in that group's language. */
type PingFrame = { place: string | null; reply: string; locale: Locale };

/**
 * The ping's text — ONE pure function, so a test can assert the line order.
 * The «↩️» line says the message can be answered by a reply; the CalcThread
 * one also names WHERE to answer on the web — not the ordinary lenta box,
 * which never reaches the VED (§3.5 c). The 🔗 line must stay LAST: the drain
 * lifts the last line into the «↗️ Ochish» button only when it is the link
 * (`takeOwnLink`, staff-html.ts), so every new line goes ABOVE it.
 *
 * A cargo ping carries a `frame` (round 2): the «📍» place line (null for a
 * door-less recipient — the card's facts are not his) and the reply hint, in
 * the recipient's language; without one the text is round 1's, unchanged.
 */
export function threadPingText(input: {
  type: ThreadPing;
  author: string;
  label: string;
  note: string;
  link: string | null;
  frame?: { place: string | null; reply: string };
}): string {
  const head =
    input.type === 'InternalNote' ? '📝' : input.type === 'MentionedInNote' ? '📣' : '❓';
  const reply = input.frame
    ? input.frame.reply
    : input.type === 'CalcThread'
      ? '↩️ Javob uchun shu xabarga reply qiling (yoki kartadagi «❓ Savol-javob»da yozing)'
      : '↩️ Javob uchun shu xabarga reply qiling';
  return (
    `${head} ${input.author} · ${input.label}\n` +
    // Enough to answer from the phone; the card has the rest.
    `${input.note.slice(0, 400)}${input.note.length > 400 ? '…' : ''}\n` +
    (input.frame?.place ? `${input.frame.place}\n` : '') +
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
 * else to the card's fold of THIS calculation; a cargo thread links every
 * door-admitted recipient to the card's «❓ Savol-javob» (`cargoThreadLink`).
 * A standing-only recipient — and a door-less mention — gets none: the door
 * did not admit him, and a link that bounces is a dead door.
 */
async function linksFor(
  input: NoteInput,
  ids: readonly string[],
  audience: Pick<ThreadAudience, 'standingOnly' | 'grants'>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const kind = input.entityType;
  switch (kind) {
    case 'receipt':
    case 'batch': {
      const link = cargoThreadLink({ kind, id: input.entityId });
      for (const id of ids) out.set(id, audience.standingOnly.includes(id) ? null : link);
      return out;
    }
    case 'lead':
    case 'deal':
    case 'client':
      break;
    default: {
      const never: never = kind;
      void never;
      return out;
    }
  }
  const permissions = new Map([...audience.grants].map(([id, g]) => [id, g.permissions] as const));
  const cardLinks = await noteLinksFor({ entityType: kind, entityId: input.entityId }, ids, permissions);
  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '');
  for (const id of ids) {
    if (audience.standingOnly.includes(id)) {
      out.set(id, null);
      continue;
    }
    if (!input.calcRequestId) {
      out.set(id, cardLinks.get(id) ?? null);
      continue;
    }
    const grants = audience.grants.get(id)?.permissions ?? (await actorGrants(id)).permissions;
    if (grants.has('ved.docs')) {
      out.set(id, `${appUrl}/hisoblash/${input.calcRequestId}#savol`);
      continue;
    }
    const card = cardLinks.get(id) ?? null;
    out.set(id, card ? `${card}#calc-thread-${input.calcRequestId}` : null);
  }
  return out;
}

/** Each person's `users.locale`, as a language the dictionary speaks. One statement. */
async function localesOf(ids: readonly string[]): Promise<Map<string, Locale>> {
  if (ids.length === 0) return new Map();
  const rows = await db.execute<{ id: string; locale: string | null }>(sql`
    SELECT u.id::text AS id, u.locale FROM users u
     WHERE u.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  return new Map(
    rows.map((row) => [
      row.id,
      (LOCALES as readonly string[]).includes(row.locale ?? '') ? (row.locale as Locale) : DEFAULT_LOCALE,
    ]),
  );
}

/**
 * One message per LINK, not one for everybody (docs/VED-TARIX.md §10, review
 * access-money-4) — and every one carries `extra.thread` (jsonb, no
 * migration), so a Telegram reply maps back to this note's thread and the
 * dock can list it.
 *
 * A cargo thread (`framing`) groups by (link, LANGUAGE) and writes
 * `extra.textLocale`, so its frame — the «📍» line, the reply hint and the two
 * buttons — reads in each recipient's `users.locale` (a ru default reads
 * Russian, exactly as every event ping already does). The CRM kinds group by
 * link alone and write no `textLocale`: their Uzbek text is byte-identical.
 */
async function notifyByLink(
  input: NoteInput,
  userIds: readonly string[],
  audience: Pick<ThreadAudience, 'standingOnly' | 'grants'>,
  build: (link: string | null, frame: PingFrame | null) => { type: ThreadPing; text: string },
  framing: CargoFraming | null,
): Promise<void> {
  const ids = userIds.filter((id) => id !== input.authorId);
  if (ids.length === 0) return;
  const links = await linksFor(input, ids, audience);
  const locales = framing ? await localesOf(ids) : new Map<string, Locale>();
  const groups = new Map<string, { link: string | null; locale: Locale | null; ids: string[] }>();
  for (const id of ids) {
    const link = links.get(id) ?? null;
    const locale = framing ? (locales.get(id) ?? DEFAULT_LOCALE) : null;
    const key = `${link ?? ''}\u0000${locale ?? ''}`;
    const group = groups.get(key) ?? { link, locale, ids: [] };
    group.ids.push(id);
    groups.set(key, group);
  }
  const thread = threadOf(input.entityType, input.entityId, input.calcRequestId);
  for (const group of groups.values()) {
    const L = group.locale ? notificationLabels(group.locale) : null;
    const frame: PingFrame | null =
      framing && L && group.locale
        ? {
            // A door-less group (a @-named seller) gets the colleague's text,
            // never the card's facts: no warehouse, no count, no route.
            place: group.link === null ? null : cargoNowLine(framing.stand, framing.codes, L),
            reply: L.threadReplyHint,
            locale: group.locale,
          }
        : null;
    const { type, text } = build(group.link, frame);
    await notifyStaffTelegram({
      userIds: group.ids,
      exceptUserId: input.authorId,
      type,
      text,
      extra: { thread: { kind: thread.kind, id: thread.id, activityId: input.activityId }, ...(frame ? { textLocale: frame.locale } : {}) },
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
 * no link (and on a cargo thread no «📍» line, and a truck by its code alone —
 * `doorlessLabel`). The door is judged with each
 * person's grants AND scope (`actorGrants`): a scoped reader judged as
 * unscoped would lose — or wrongly keep — his link. `pre` hands over the
 * thread's facts and frame when `announceNote` loaded them; the contact-log
 * caller loads its own.
 */
export async function announceMentions(
  input: NoteInput,
  pre?: { facts: ThreadFacts | null; framing: CargoFraming | null },
): Promise<string[]> {
  const mentioned = extractMentions(input.note, await mentionablePeople()).filter((id) => id !== input.authorId);
  if (mentioned.length === 0) return [];
  const thread = threadOf(input.entityType, input.entityId, input.calcRequestId);
  const facts = pre ? pre.facts : await threadFacts(thread);
  const framing = pre ? pre.framing : await cargoFramingOf(facts);
  const grants = new Map<string, ActorGrants>();
  for (const id of mentioned) grants.set(id, await actorGrants(id));
  const doors = await threadDoorsWith(
    mentioned.map((id) => ({ id, ...grants.get(id)! })),
    facts,
  );
  // Door-less mentions get the text without a link — the same as a standing-only recipient.
  const doorless = mentioned.filter((id) => !doors.has(id));
  const [label, author] = await Promise.all([threadLabel(input), userName(input.authorId)]);
  // A null link is a door-less group here — `notifyByLink`'s own rule for
  // dropping the «📍» line (a cargo card has no standing) — and the head line
  // must not hand him back the route that line withheld.
  const bare = doorlessLabel(input.entityType, label);
  await notifyByLink(
    input,
    mentioned,
    { standingOnly: doorless, grants },
    (link, frame) => ({
      type: 'MentionedInNote',
      text: threadPingText({
        type: 'MentionedInNote',
        author,
        label: link === null ? bare : label,
        note: input.note,
        link,
        frame: frame ?? undefined,
      }),
    }),
    framing,
  );
  return mentioned;
}

/**
 * A note landed — tell the thread. Returns WHO it told: `heard` with the
 * card, `standingOnly` by standing (§3.4), the cargo arm's account of itself
 * (`cargo`) and the people it @-NAMED (`mentioned`) — the calc and cargo
 * actions turn the rest of their expected people into words on the box.
 *
 * Fire-and-forget from the caller's point of view: a note that saved but did
 * not ping is a small failure, a note that refused to save because Telegram
 * hiccuped would be a large one.
 *
 * A mentioned colleague gets the 📣 mention ping INSTEAD of the thread copy,
 * never both — one note, one message per person. The thread's facts (and a
 * cargo thread's frame) are loaded ONCE here, for the mentions, the audience
 * and both texts.
 */
export async function announceNote(input: NoteInput): Promise<{
  heard: string[];
  standingOnly: string[];
  cargo: CargoReach | null;
  mentioned: string[];
}> {
  const facts = await threadFacts(threadOf(input.entityType, input.entityId, input.calcRequestId));
  const framing = await cargoFramingOf(facts);
  const mentioned = await announceMentions(input, { facts, framing });
  const [audience, label, author] = await Promise.all([
    threadAudience(input.entityType, input.entityId, input.calcRequestId, input.authorId, { facts }),
    threadLabel(input),
    userName(input.authorId),
  ]);
  // The two types written as literals: the derived mute fence
  // (topshiriq-wire.test.ts) reads every `type: '…'` a sending file names.
  await notifyByLink(
    input,
    [...audience.heard, ...audience.standingOnly].filter((id) => !mentioned.includes(id)),
    audience,
    (link, frame) =>
      input.calcRequestId
        ? { type: 'CalcThread', text: threadPingText({ type: 'CalcThread', author, label, note: input.note, link }) }
        : {
            type: 'InternalNote',
            text: threadPingText({ type: 'InternalNote', author, label, note: input.note, link, frame: frame ?? undefined }),
          },
    framing,
  );
  return { heard: audience.heard, standingOnly: audience.standingOnly, cargo: audience.cargo, mentioned };
}
