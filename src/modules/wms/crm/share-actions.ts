'use server';

import { AuthError, authorize } from '../../platform/rbac/authorize';
import { requestMeta } from '../../platform/auth/session';
import { ShareError, shareMessage } from './share';
import { canReadTg } from './conversations';

export interface ShareState {
  ok?: boolean;
  error?: string;
}

/**
 * Hand one client message to a colleague (owner's item 4).
 *
 * The gate is the one that opens the thread — whoever may READ the message
 * may pass it on — and the service asks the viewer question again over the
 * message id, so a hand-posted uuid from a conversation this person cannot
 * open refuses rather than sends.
 */
export async function shareMessageAction(
  _prev: ShareState,
  form: FormData,
): Promise<ShareState> {
  let who;
  try {
    who = await authorize('crm.leads');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  // `authorize` proves ONE grant; the thread's door is a union of three, and
  // a vedchi holds none of the CRM ones (round 33). Asked here so the button
  // and the action agree about who may act.
  if (!canReadTg(who)) return { error: 'forbidden' };

  const messageId = String(form.get('messageId') ?? '');
  const toUserId = String(form.get('toUserId') ?? '');
  const note = String(form.get('note') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(messageId) || !/^[0-9a-f-]{36}$/i.test(toUserId)) {
    return { error: 'bad_target' };
  }

  const meta = await requestMeta();
  try {
    await shareMessage({ messageId, toUserId, note }, who, { actorId: who.id, ...meta });
  } catch (err) {
    if (err instanceof ShareError) return { error: err.message };
    throw err;
  }
  return { ok: true };
}
