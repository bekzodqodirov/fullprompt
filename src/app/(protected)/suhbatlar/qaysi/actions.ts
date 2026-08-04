'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  ChatRuleError,
  decideChat,
  listCandidates,
  purgeExcludedChat,
} from '@/modules/wms/crm/chat-rules';

/**
 * Answering one chat: is it a client's, or is it nobody's business?
 *
 * Gated on `clients.manage` rather than `crm.leads`, which is TIGHTER than the
 * conversation screens themselves. Reading a client's thread is a sales job;
 * this decides what the company starts keeping about a person, and about a
 * manager's own account — a narrower thing, and a narrower door.
 *
 * The action also re-checks that the row belongs to somebody the actor may
 * answer for. The screen already filters, but a screen is a view and an action
 * is a door: a manager who can see only their own list must not be able to
 * decide somebody else's by posting an id.
 */
export interface ChatRuleState {
  ok?: boolean;
  error?: string;
}

export async function decideChatAction(
  _prev: ChatRuleState,
  form: FormData,
): Promise<ChatRuleState> {
  let who;
  try {
    who = await authorize('clients.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }

  const id = String(form.get('id') ?? '');
  const decision = String(form.get('decision') ?? '') as 'include' | 'exclude' | 'pending';
  if (!['include', 'exclude', 'pending'].includes(decision)) return { error: 'bad_decision' };

  // Whose account is this row in? `admin.settings.manage` is the owner's grant
  // and is what allows answering for the whole company; anybody else answers
  // only for their own chats.
  const canSeeEverybody = who.permissions.has('admin.settings.manage');
  const mine = await listCandidates(canSeeEverybody ? {} : { managerUserId: who.id });
  if (!mine.some((row) => row.id === id)) return { error: 'forbidden' };

  const clientId = String(form.get('clientId') ?? '').trim() || null;
  const meta = await requestMeta();
  try {
    await decideChat({ id, decision, clientId }, { actorId: who.id, ...meta });
  } catch (err) {
    if (err instanceof ChatRuleError) return { error: err.message };
    throw err;
  }
  revalidatePath('/suhbatlar', 'layout');
  return { ok: true };
}

/**
 * Delete what was already stored for an EXCLUDED chat — the queued follow-up
 * to «hech qachon». Same door as deciding (the screen's gate plus the
 * own-account check), because it acts on the same rows the screen shows; the
 * purge itself re-checks the rule is an exclude and audits the counts.
 */
export async function purgeChatAction(
  _prev: ChatRuleState,
  form: FormData,
): Promise<ChatRuleState> {
  let who;
  try {
    who = await authorize('clients.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }

  const id = String(form.get('id') ?? '');
  const canSeeEverybody = who.permissions.has('admin.settings.manage');
  const mine = await listCandidates(canSeeEverybody ? {} : { managerUserId: who.id });
  if (!mine.some((row) => row.id === id)) return { error: 'forbidden' };

  const meta = await requestMeta();
  try {
    await purgeExcludedChat(id, { actorId: who.id, ...meta });
  } catch (err) {
    if (err instanceof ChatRuleError) return { error: err.message };
    throw err;
  }
  revalidatePath('/suhbatlar', 'layout');
  return { ok: true };
}
