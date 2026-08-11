import { and, eq, ne } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, leads, tgMessages, users } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { seesAllTg, type TgViewer } from './conversations';

/**
 * Show a colleague what a client wrote (owner's item 4, «habarni forward
 * qilish», narrowed by his own answer: «boshqa mijozga jonatilmaydi»).
 *
 * So forwarding here is INWARD, never outward. A message never leaves for
 * another customer's chat; it goes to a member of staff, in their own
 * Telegram, with a link to the card it came from.
 *
 * That deliberately crosses round 20's fence — a conversation is private to
 * the manager whose account holds it — and the crossing is the point: the
 * difference between a leak and a hand-over is that a PERSON decided, and
 * the decision is written down. It is audited under the message, names both
 * sides, and hands over exactly the one message rather than the thread.
 *
 * What is NOT sent is the file. A shared bubble carries its words and a link;
 * the attachment stays where it is and the link opens the card, so the
 * attachment gate (which already knows who may open what) keeps deciding
 * instead of being routed around by a bot.
 */

export class ShareError extends Error {}

export interface ShareableMessage {
  id: string;
  body: string | null;
  hasMedia: boolean;
  direction: string;
  clientId: string | null;
  leadId: string | null;
}

/**
 * The message, IF this viewer may read it — the thread's own rule, asked
 * again here rather than trusted from the screen that drew the button. A
 * hand-posted uuid is the case this exists for.
 */
export async function shareableMessage(
  messageId: string,
  viewer: TgViewer,
): Promise<ShareableMessage | null> {
  const [row] = await db
    .select({
      id: tgMessages.id,
      body: tgMessages.body,
      hasMedia: tgMessages.hasMedia,
      direction: tgMessages.direction,
      clientId: tgMessages.clientId,
      leadId: tgMessages.leadId,
      managerUserId: tgMessages.managerUserId,
    })
    .from(tgMessages)
    .where(eq(tgMessages.id, messageId))
    .limit(1);
  if (!row) return null;
  if (!viewer.all && row.managerUserId !== viewer.id) return null;
  return row;
}

/** Active colleagues this person can hand a message to — never themselves. */
export async function shareTargets(actorId: string): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: users.id, name: users.fullName })
    .from(users)
    .where(and(eq(users.active, true), ne(users.id, actorId)))
    .orderBy(users.fullName);
}

/** What the colleague reads in their own Telegram. */
export function shareText(input: {
  fromName: string;
  who: string;
  body: string | null;
  hasMedia: boolean;
  note: string;
  link: string;
}): string {
  const quoted = input.body?.trim().slice(0, 700);
  return (
    `➦ ${input.fromName} → ${input.who}\n` +
    (quoted ? `«${quoted}»\n` : input.hasMedia ? '📎\n' : '') +
    (input.note.trim() ? `${input.note.trim()}\n` : '') +
    input.link
  );
}

export async function shareMessage(
  input: { messageId: string; toUserId: string; note?: string },
  actor: { id: string; roles: readonly string[]; permissions: ReadonlySet<string> },
  ctx: AuditContext,
): Promise<void> {
  const viewer: TgViewer = { id: actor.id, all: seesAllTg(actor) };
  const message = await shareableMessage(input.messageId, viewer);
  if (!message) throw new ShareError('not_found');
  if (input.toUserId === actor.id) throw new ShareError('bad_target');

  // Re-derived, never trusted from the form: an inactive account is not a
  // colleague, and a uuid that is not a user at all must refuse here rather
  // than reach `notifyStaffTelegram` and quietly send nothing.
  const [target] = await db
    .select({ id: users.id, name: users.fullName })
    .from(users)
    .where(and(eq(users.id, input.toUserId), eq(users.active, true)))
    .limit(1);
  if (!target) throw new ShareError('bad_target');

  const appUrl = process.env.APP_URL ?? '';
  let who = '';
  let link = appUrl;
  if (message.clientId) {
    const [client] = await db
      .select({ code: clients.clientCode, name: clients.name })
      .from(clients)
      .where(eq(clients.id, message.clientId))
      .limit(1);
    who = client ? `${client.code} · ${client.name}` : '';
    link = `${appUrl}/suhbatlar/${message.clientId}`;
  } else if (message.leadId) {
    const [lead] = await db
      .select({ name: leads.name })
      .from(leads)
      .where(eq(leads.id, message.leadId))
      .limit(1);
    who = lead?.name ?? '';
    link = `${appUrl}/crm/${message.leadId}`;
  }

  const [from] = await db
    .select({ name: users.fullName })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1);

  await notifyStaffTelegram({
    userIds: [target.id],
    type: 'ChatMessageShared',
    text: shareText({
      fromName: from?.name ?? '',
      who,
      body: message.body,
      hasMedia: message.hasMedia,
      note: input.note ?? '',
      link,
    }),
  });

  // On the MESSAGE, not on the client: the record being made is «this one
  // message was handed to this person», and the client's history is not the
  // place to look for it.
  await writeAudit(db, ctx, {
    entityType: 'tg_message',
    entityId: message.id,
    action: 'share',
    after: { toUserId: target.id, toName: target.name },
  });
}
