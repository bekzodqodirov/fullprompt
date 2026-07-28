import { and, eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, crmActivities, deals, leads } from '../../platform/db/schema';
import { cardLink } from '../../platform/notifications/links';
import { notifyStaffTelegram, userName } from '../../platform/notifications/staff';

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
 * A note landed — tell the thread.
 *
 * Fire-and-forget from the caller's point of view: a note that saved but did
 * not ping is a small failure, a note that refused to save because Telegram
 * hiccuped would be a large one.
 */
export async function announceNote(input: {
  entityType: 'client' | 'lead' | 'deal';
  entityId: string;
  note: string;
  authorId: string;
}): Promise<void> {
  const [recipients, label, author] = await Promise.all([
    noteRecipients(input.entityType, input.entityId),
    cardLabel(input.entityType, input.entityId),
    userName(input.authorId),
  ]);
  const link = cardLink(input.entityType, input.entityId);
  await notifyStaffTelegram({
    userIds: recipients,
    exceptUserId: input.authorId,
    type: 'InternalNote',
    text:
      `📝 ${author} · ${label}\n` +
      // Enough to answer from the phone; the card has the rest.
      `${input.note.slice(0, 400)}${input.note.length > 400 ? '…' : ''}` +
      (link ? `\n🔗 ${link}` : ''),
  });
}
