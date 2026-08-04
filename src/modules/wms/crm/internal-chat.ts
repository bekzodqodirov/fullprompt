import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, crmActivities, deals, leads, users } from '../../platform/db/schema';
import { cardLink } from '../../platform/notifications/links';
import { notifyStaffTelegram, userName } from '../../platform/notifications/staff';
import { extractMentions, type MentionPerson } from './mentions';

/**
 * The internal conversation, carried by Telegram.
 *
 * Owner: "ichki chatni telegramda olib borishni belgila — CRM va BITIM uchun
 * chatlar bo'lishi kerak ichki hodimlar bilan." The record lives on the card
 * (`crm_activities`, where a note has always lived); what makes it a CHAT is
 * that writing one pings the right colleagues in Telegram, with a link back to
 * the card, so the reply happens where people already are.
 *
 * WHO gets pinged is the design decision: the OWNER of the record (a lead's
 * or deal's carrier), plus everyone who has already written on this card —
 * the thread's participants. Not a role broadcast: a message to "all of
 * sales" about every note on every card is a channel people mute in a week,
 * and then the one note that mattered is muted with it. You join a card's
 * conversation by speaking in it, which is how threads work everywhere else.
 */

export async function noteRecipients(
  entityType: 'client' | 'lead' | 'deal',
  entityId: string,
): Promise<string[]> {
  const ids: string[] = [];

  // Everyone who has spoken on this card before.
  const authors = await db
    .selectDistinct({ id: crmActivities.createdBy })
    .from(crmActivities)
    .where(and(eq(crmActivities.entityType, entityType), eq(crmActivities.entityId, entityId)));
  ids.push(...authors.map((a) => a.id));

  // And the person carrying the record, whether or not they have written yet.
  if (entityType === 'lead') {
    const row = await db.query.leads.findFirst({ where: eq(leads.id, entityId) });
    if (row?.ownerId) ids.push(row.ownerId);
  } else if (entityType === 'deal') {
    const row = await db.query.deals.findFirst({ where: eq(deals.id, entityId) });
    if (row?.ownerId) ids.push(row.ownerId);
  }
  return [...new Set(ids)];
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
    .where(eq(users.active, true))
    .orderBy(asc(users.fullName));
}

interface NoteInput {
  entityType: 'client' | 'lead' | 'deal';
  entityId: string;
  note: string;
  authorId: string;
}

/**
 * Tell the people NAMED in a note — and only them.
 *
 * Its own function because the contact-log path deliberately broadcasts to
 * nobody: a phone-call record is a record, not a conversation. A mention in
 * it is different — it is the author explicitly calling a colleague over,
 * which is the one thing that must always get through. Its own notification
 * type, so a person can mute the thread chatter and still hear their name.
 */
export async function announceMentions(input: NoteInput): Promise<string[]> {
  const mentioned = extractMentions(input.note, await mentionablePeople());
  if (mentioned.length === 0) return [];
  const [label, author] = await Promise.all([
    cardLabel(input.entityType, input.entityId),
    userName(input.authorId),
  ]);
  const link = cardLink(input.entityType, input.entityId);
  await notifyStaffTelegram({
    userIds: mentioned,
    exceptUserId: input.authorId,
    type: 'MentionedInNote',
    text:
      `📣 ${author} · ${label}\n` +
      `${input.note.slice(0, 400)}${input.note.length > 400 ? '…' : ''}` +
      (link ? `\n🔗 ${link}` : ''),
  });
  return mentioned;
}

/**
 * A note landed — tell the thread.
 *
 * Fire-and-forget from the caller's point of view: a note that saved but did
 * not ping is a small failure, a note that refused to save because Telegram
 * hiccuped would be a large one.
 *
 * A mentioned colleague gets the 📣 mention ping INSTEAD of the thread copy,
 * never both — one note, one message per person.
 */
export async function announceNote(input: NoteInput): Promise<void> {
  const mentioned = await announceMentions(input);
  const [recipients, label, author] = await Promise.all([
    noteRecipients(input.entityType, input.entityId),
    cardLabel(input.entityType, input.entityId),
    userName(input.authorId),
  ]);
  const link = cardLink(input.entityType, input.entityId);
  await notifyStaffTelegram({
    userIds: recipients.filter((id) => !mentioned.includes(id)),
    exceptUserId: input.authorId,
    type: 'InternalNote',
    text:
      `📝 ${author} · ${label}\n` +
      // Enough to answer from the phone; the card has the rest.
      `${input.note.slice(0, 400)}${input.note.length > 400 ? '…' : ''}` +
      (link ? `\n🔗 ${link}` : ''),
  });
}
