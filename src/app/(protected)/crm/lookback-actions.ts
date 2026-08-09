'use server';

import { revalidatePath } from 'next/cache';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { ChatRuleError, attachPeerToCard } from '@/modules/wms/crm/chat-rules';
import { offerableMatches } from '@/modules/wms/crm/peer-index';

/**
 * «Chatni qo'shish» from a lead, deal or client card.
 *
 * Two checks, and the second is the one that matters. The gate is
 * `clients.manage` — the same door the tray uses, because this starts the
 * company keeping a conversation and that is a narrower act than reading one.
 * Then the peer is looked up AGAIN through `offerableMatches` for the ACTOR:
 * the form carries a peer id, and a peer id posted by hand must not be able
 * to attach a chat the screen never offered — somebody else's, or one that
 * was already answered «hech qachon».
 *
 * `managerUserId` is never read from the form at all. It is the actor, full
 * stop: attaching a colleague's chat would be opening it on their behalf,
 * which is exactly the line round 20 drew.
 */
export interface LookbackState {
  ok?: boolean;
  error?: string;
}

export async function attachChatAction(
  _prev: LookbackState,
  form: FormData,
): Promise<LookbackState> {
  let who;
  try {
    who = await authorize('clients.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }

  const peerId = String(form.get('peerId') ?? '').trim();
  const phone = String(form.get('phone') ?? '').trim();
  const clientId = String(form.get('clientId') ?? '').trim() || null;
  const leadId = String(form.get('leadId') ?? '').trim() || null;
  if (!peerId || (!clientId && !leadId)) return { error: 'owner_required' };

  const offered = await offerableMatches(phone, who.id);
  const match = offered.find((hit) => hit.peerId.toString() === peerId && hit.own);
  if (!match) return { error: 'forbidden' };

  const meta = await requestMeta();
  try {
    await attachPeerToCard(
      { peerId: match.peerId, managerUserId: who.id, clientId, leadId },
      { actorId: who.id, ...meta },
    );
  } catch (err) {
    if (err instanceof ChatRuleError) return { error: err.message };
    throw err;
  }
  // The conversation screens, and the card the press came from. `path` is
  // sent by the form for the same reason `revalidateChatSurfaces` takes one
  // (#575): a DEAL card's id cannot be derived from the client's, so nothing
  // here could guess the screen the person is standing on. It is checked
  // rather than trusted — a value from a browser is a claim.
  revalidatePath('/suhbatlar', 'layout');
  if (clientId) revalidatePath(`/admin/clients/${clientId}`);
  if (leadId) revalidatePath(`/crm/leads/${leadId}`);
  const path = String(form.get('path') ?? '');
  if (path.startsWith('/') && !path.startsWith('//')) revalidatePath(path);
  return { ok: true };
}
