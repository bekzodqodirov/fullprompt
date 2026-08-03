'use client';

import { useTransition } from 'react';
import { dismissFailedAction } from '@/modules/wms/crm/reply-actions';

/**
 * ✕ on a reply that failed (round 53).
 *
 * Only on a FAILED bubble. A queued one is withdrawn by its own control and a
 * sent one is on somebody's phone — this exists because a failure, once read,
 * is clutter at the top of the screen a manager answers customers from, and
 * the owner had three of them sitting there for a day.
 *
 * No confirm: nothing is lost that anybody else ever saw, and a dialog on a
 * tidy-up teaches people to dismiss dialogs.
 */
export function OutboxDismiss({
  id,
  clientId,
  label,
}: {
  id: string;
  clientId: string;
  label: string;
}) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={pending}
      data-testid="outbox-dismiss"
      onClick={() => {
        const form = new FormData();
        form.set('id', id);
        form.set('clientId', clientId);
        start(async () => {
          await dismissFailedAction({}, form);
        });
      }}
      className="btn-ghost btn-icon !min-h-7 shrink-0 text-xs"
    >
      ✕
    </button>
  );
}
