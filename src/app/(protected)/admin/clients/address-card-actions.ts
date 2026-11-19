'use server';

import { getActor } from '@/modules/platform/rbac/authorize';
import { mayOpenClientCard } from '@/modules/platform/clients/card-door';
import { isUuidShaped } from '@/modules/platform/audit/fields';
import { resendNewClientCard, type ResendOutcome } from '@/modules/wms/client-card/address-card';

/**
 * «📨 Manzil xabarini menga yuborish» (0151, judge 1.7) — the address card of
 * this client to the person who pressed, for whoever may open the card: an
 * old code that predates the card, a message lost in a long chat.
 *
 * The card's own door and nothing narrower: the link inside carries no secret
 * (`?start=mijoz` names nobody), so the card's readers may forward it. The id
 * is a form's value, so its shape is asked before a query sees it.
 */
export async function resendAddressCardAction(clientId: string): Promise<{ outcome: ResendOutcome | 'forbidden' }> {
  const actor = await getActor();
  if (!actor || !mayOpenClientCard(actor)) return { outcome: 'forbidden' };
  if (!isUuidShaped(String(clientId ?? ''))) return { outcome: 'failed' };
  return { outcome: await resendNewClientCard(clientId, actor.id) };
}
