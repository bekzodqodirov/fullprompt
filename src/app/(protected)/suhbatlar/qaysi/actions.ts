'use server';

import { revalidatePath } from 'next/cache';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  ChatRuleError,
  decideChat,
  listCandidates,
  openLeadForChat,
  purgeExcludedChat,
} from '@/modules/wms/crm/chat-rules';
import { mayDecideChats } from '@/modules/wms/crm/telegram-accounts';

/**
 * Answering one chat: is it a client's, or is it nobody's business?
 *
 * The door is `mayDecideChats` — a manager's OWN connected account, or
 * `clients.manage` for the administrator (round 93: the owner overruled the
 * original clients.manage-only gate the day sellers connected and found their
 * tray on a screen they could not open).
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
  const who = await getActor();
  if (!who || !(await mayDecideChats(who))) return { error: 'forbidden' };

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
 * «Lid ochish» — the third answer, and the one the tray needed most.
 *
 * Same door as deciding, down to the own-account re-check: this is the same
 * row, the same account and the same consequence (the company starts keeping
 * a conversation). What it adds is a LEAD, which is why the answer carries
 * one back — the screen turns it into a link, so the press that says «this is
 * business» is one tap from the card where that business gets worked.
 */
export interface OpenLeadState extends ChatRuleState {
  leadId?: string;
}

export async function openLeadAction(
  _prev: OpenLeadState,
  form: FormData,
): Promise<OpenLeadState> {
  const who = await getActor();
  if (!who || !(await mayDecideChats(who))) return { error: 'forbidden' };

  const id = String(form.get('id') ?? '');
  const canSeeEverybody = who.permissions.has('admin.settings.manage');
  const mine = await listCandidates(canSeeEverybody ? {} : { managerUserId: who.id });
  if (!mine.some((row) => row.id === id)) return { error: 'forbidden' };

  const meta = await requestMeta();
  try {
    const { leadId } = await openLeadForChat(id, { actorId: who.id, ...meta });
    revalidatePath('/suhbatlar', 'layout');
    revalidatePath('/crm');
    return { ok: true, leadId };
  } catch (err) {
    if (err instanceof ChatRuleError) return { error: err.message };
    throw err;
  }
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
  const who = await getActor();
  if (!who || !(await mayDecideChats(who))) return { error: 'forbidden' };

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
