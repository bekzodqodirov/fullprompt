'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { cancelQueued, OutboxError, queueReply, replyAccountFor } from './outbox';
import { excludeChatForClient } from './chat-rules';

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
  const account = await replyAccountFor(clientId, who.id);
  if (!account) return { error: 'not_your_conversation' };

  const meta = await requestMeta();
  try {
    await queueReply(
      { clientId, managerUserId: account.managerUserId, body },
      { actorId: who.id, ...meta },
    );
  } catch (err) {
    if (err instanceof OutboxError) return { error: err.message };
    throw err;
  }
  revalidatePath(`/suhbatlar/${clientId}`);
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
  revalidatePath(`/suhbatlar/${clientId}`);
  return { ok: true };
}

/**
 * "Stop taking this conversation" — the exclude half, from the chat itself.
 *
 * On the same account rule as replying: you may only decide about a
 * conversation that is in your OWN Telegram. Somebody else's chat is theirs
 * to keep or drop, and the message would have been stored under their name.
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
  await excludeChatForClient(
    { clientId, managerUserId: account.managerUserId, peerId: account.peerId },
    { actorId: who.id, ...meta },
  );
  revalidatePath(`/suhbatlar/${clientId}`);
  revalidatePath('/suhbatlar', 'layout');
  return { ok: true };
}
