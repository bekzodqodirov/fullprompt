'use client';

import { useState, useTransition } from 'react';
import { disconnectAction } from './actions';

/**
 * The other half of «ulash» (round 50, the owner: «endi undan chiqishni
 * qo'sh»).
 *
 * Behind a confirm, and the confirm says what it actually does rather than
 * «are you sure»: the messages stop arriving, the queued replies fail, and
 * the session is destroyed on this server AND ended inside Telegram. All four
 * are consequences somebody could reasonably not expect from a button called
 * «log out», and the last one cannot be undone by pressing it again.
 */
export function DisconnectButton({
  labels,
}: {
  labels: { button: string; confirm: string; done: string; failed: string };
}) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);

  if (done) return <p className="text-sm font-semibold text-good">{labels.done}</p>;

  return (
    <div className="space-y-1">
      <button
        type="button"
        data-testid="tg-disconnect"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(labels.confirm)) return;
          start(async () => {
            const result = await disconnectAction();
            // A refusal says so HERE. It used to assume success and then look
            // successful whatever happened (round 52).
            if (result.error) {
              setError(true);
              return;
            }
            setDone(true);
          });
        }}
        className="btn-secondary w-full !text-bad"
      >
        {labels.button}
      </button>
      {error && (
        <p className="text-sm font-semibold text-bad" data-testid="tg-disconnect-error">
          {labels.failed}
        </p>
      )}
    </div>
  );
}
