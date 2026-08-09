'use client';

import { useActionState } from 'react';
import { usePathname } from 'next/navigation';
import { attachChatAction, type LookbackState } from '@/app/(protected)/crm/lookback-actions';

/**
 * The one press the lookback offers, and only for the viewer's OWN chat.
 *
 * `phone` rides along because the action re-derives the offer from it rather
 * than trusting the peer id: the same lookup the screen did, run again for
 * the actor, is what stops a hand-posted id attaching a colleague's
 * conversation.
 *
 * `path` is the screen this was pressed on, so the card refreshes with the
 * panel gone (#575 — a deal card's id cannot be derived from the client's).
 */
export function LookbackAttach({
  peerId,
  phone,
  clientId,
  leadId,
  label,
}: {
  peerId: string;
  phone: string;
  clientId: string | null;
  leadId: string | null;
  label: string;
}) {
  const [state, submit, pending] = useActionState<LookbackState, FormData>(attachChatAction, {});
  const pathname = usePathname();

  return (
    <form action={submit} className="flex items-center gap-2">
      <input type="hidden" name="peerId" value={peerId} />
      <input type="hidden" name="phone" value={phone} />
      {clientId && <input type="hidden" name="clientId" value={clientId} />}
      {leadId && <input type="hidden" name="leadId" value={leadId} />}
      <input type="hidden" name="path" value={pathname} />
      <button
        type="submit"
        className="btn-secondary !min-h-9"
        disabled={pending}
        data-testid="lookback-attach"
      >
        {label}
      </button>
      {state.error && <span className="text-xs font-semibold text-bad">{state.error}</span>}
    </form>
  );
}
