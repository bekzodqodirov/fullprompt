'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  cancelQueued,
  dismissFailed,
  OutboxError,
  queueReply,
  replyAccountFor,
} from './outbox';
import { excludeAndPurgeChat } from './chat-rules';
import { addActivity } from './service';
import { announceNote } from './internal-chat';

/**
 * A conversation is shown on FOUR surfaces, and a write must reach all of
 * them (2026-08-07, the owner's «ocheretda turibti» reported twice).
 *
 * Only `/suhbatlar/<id>` was ever revalidated, so a reply queued from a
 * client, deal or lead card left that card rendering the state from before
 * the press: the «navbatda» line appeared or lingered depending on when the
 * page had last been built, while the message itself had reached the client
 * within seconds. `path` is the screen the person is actually on — the
 * tasks actions' own pattern — because a lead card's id is the LEAD's, not
 * this client's, and no amount of guessing here can derive it.
 */
function revalidateChatSurfaces(clientId: string, path?: string | null): void {
  revalidatePath(`/suhbatlar/${clientId}`);
  revalidatePath('/suhbatlar', 'layout');
  revalidatePath(`/admin/clients/${clientId}`);
  // An app path and nothing else: this arrives from a browser, and a value
  // from a browser is a claim until it is checked.
  if (path && path.startsWith('/') && !path.startsWith('//')) revalidatePath(path);
}

/**
 * Queue a reply to a client — phase 4.
 *
 * The action does not send. It writes a row the listener picks up, because
 * exactly one process may hold a connection to a manager's Telegram and this
 * is not it.
 *
 * Two checks the screen also makes, repeated here because a screen is a view
 * and an action is a door:
 *  - the actor may only send through their OWN account (`replyAccountFor`);
 *  - every rule in `telegram-send.ts` is re-applied inside `queueReply`,
 *    including the one that matters — never message somebody who has not
 *    written to us first.
 */
export interface ReplyState {
  ok?: boolean;
  error?: string;
}

export async function sendReplyAction(_prev: ReplyState, form: FormData): Promise<ReplyState> {
  let who;
  try {
    // Reading a conversation is `crm.leads` OR `clients.manage`; speaking in
    // one is the same gate as reading, because it is the sales job itself.
    who = await authorize('crm.leads');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }

  const clientId = String(form.get('clientId') ?? '');
  const body = String(form.get('body') ?? '');
  // The photo the composer pre-uploaded, if any. queueReply verifies it is
  // the sender's own tg_outbox upload — the id alone proves nothing.
  const rawAttachment = String(form.get('attachmentId') ?? '');
  const attachmentId = /^[0-9a-f-]{36}$/i.test(rawAttachment) ? rawAttachment : null;
  const account = await replyAccountFor(clientId, who.id);
  if (!account) return { error: 'not_your_conversation' };

  const meta = await requestMeta();
  try {
    await queueReply(
      { clientId, managerUserId: account.managerUserId, body, attachmentId },
      { actorId: who.id, ...meta },
    );
  } catch (err) {
    if (err instanceof OutboxError) return { error: err.message };
    throw err;
  }
  revalidateChatSurfaces(clientId, String(form.get('path') ?? ''));
  return { ok: true };
}

export async function cancelReplyAction(_prev: ReplyState, form: FormData): Promise<ReplyState> {
  let who;
  try {
    who = await authorize('crm.leads');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const id = String(form.get('id') ?? '');
  const clientId = String(form.get('clientId') ?? '');
  // Same ownership rule: you may withdraw what would have gone out under your
  // own name, not somebody else's.
  if (!(await replyAccountFor(clientId, who.id))) return { error: 'not_your_conversation' };

  const meta = await requestMeta();
  try {
    await cancelQueued(id, { actorId: who.id, ...meta });
  } catch (err) {
    if (err instanceof OutboxError) return { error: err.message };
    throw err;
  }
  revalidateChatSurfaces(clientId, String(form.get('path') ?? ''));
  return { ok: true };
}

/**
 * Take a failed reply off the thread (round 53).
 *
 * The owner watched three «401: SESSION_REVOKED» boxes sit at the top of a
 * conversation for a day with nothing able to remove them. A failed row is a
 * note to the manager that their words did not leave; once read, it is
 * clutter on the screen they answer customers from.
 *
 * Same ownership rule as withdrawing: only on a conversation you may speak in.
 */
export async function dismissFailedAction(
  _prev: ReplyState,
  form: FormData,
): Promise<ReplyState> {
  let who;
  try {
    who = await authorize('crm.leads');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const id = String(form.get('id') ?? '');
  const clientId = String(form.get('clientId') ?? '');
  if (!(await replyAccountFor(clientId, who.id))) return { error: 'not_your_conversation' };

  const meta = await requestMeta();
  try {
    await dismissFailed(id, { actorId: who.id, ...meta });
  } catch (err) {
    if (err instanceof OutboxError) return { error: err.message };
    throw err;
  }
  revalidateChatSurfaces(clientId, String(form.get('path') ?? ''));
  return { ok: true };
}

/**
 * "Stop taking this conversation" — the exclude half, from the chat itself.
 *
 * On the same account rule as replying: you may only decide about a
 * conversation that is in your OWN Telegram. Somebody else's chat is theirs
 * to keep or drop, and the message would have been stored under their name.
 * Since round 25 it also DELETES what was stored — the owner's expectation
 * of «qo'shma» is that the chat leaves the system, and the button's confirm
 * says exactly that before the press.
 */
export async function excludeChatAction(_prev: ReplyState, form: FormData): Promise<ReplyState> {
  let who;
  try {
    who = await authorize('crm.leads');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const clientId = String(form.get('clientId') ?? '');
  const account = await replyAccountFor(clientId, who.id);
  if (!account) return { error: 'not_your_conversation' };

  const meta = await requestMeta();
  await excludeAndPurgeChat(
    { clientId, managerUserId: account.managerUserId, peerId: account.peerId },
    { actorId: who.id, ...meta },
  );
  // A purge removes the conversation from every surface at once.
  revalidateChatSurfaces(clientId, String(form.get('path') ?? ''));
  return { ok: true };
}

/**
 * An internal note on the client's timeline.
 *
 * Goes to `crm_activities`, which is where notes already live — the timeline
 * reads that table rather than inventing a second one, so a note left on the
 * old contact-history panel and one left here are the same note.
 */
export async function addFeedNoteAction(_prev: ReplyState, form: FormData): Promise<ReplyState> {
  let who;
  try {
    who = await authorize('crm.leads');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const entityType = String(form.get('entityType') ?? 'client');
  const entityId = String(form.get('entityId') ?? '');
  const note = String(form.get('note') ?? '').trim();
  if (!note) return { error: 'empty' };
  // Only the places a timeline lives. Anything else posted here is a forged
  // form, and the answer to a forged form is a refusal.
  if (entityType !== 'client' && entityType !== 'lead' && entityType !== 'deal') {
    return { error: 'forbidden' };
  }
  // Set when the box uploaded files first: the note takes THAT id, so the
  // attachments pre-bound to it become the note's own (owner: "zametkaga
  // fayllar qo'shish").
  const rawActivityId = String(form.get('activityId') ?? '');
  const activityId = /^[0-9a-f-]{36}$/i.test(rawActivityId) ? rawActivityId : undefined;

  await addActivity(
    { id: activityId, entityType, entityId, kind: 'note', note },
    { actorId: who.id, ...(await requestMeta()) },
  );
  // The Telegram half of the internal chat. After the save and never blocking
  // it: a note that saved but did not ping is a small failure, the reverse
  // would be a large one.
  await announceNote({ entityType, entityId, note, authorId: who.id }).catch(() => {});
  revalidatePath(`/admin/clients/${entityId}`);
  revalidatePath(`/crm/leads/${entityId}`);
  revalidatePath(`/bitimlar/${entityId}`);
  revalidatePath('/bitimlar', 'layout');
  revalidatePath('/crm', 'layout');
  return { ok: true };
}
