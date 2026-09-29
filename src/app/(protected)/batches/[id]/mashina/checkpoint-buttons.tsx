'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import type { CheckpointActionState, CheckpointErrorCode } from '@/modules/wms/tracking/checkpoint';
import { setTrackingCheckpointAction } from '../../batch-actions-server';

/**
 * The «where is the truck» pins — the markup and classes the buttons always
 * had (m3 presses 🛃 and reads `border-blue-700`), now with the refusal said
 * in words under the row: the action used to return quietly on anything it
 * would not write, and a press that changes nothing looks like a press that
 * worked.
 *
 * The options are the truck's own road's (`checkpointsFor`), drawn by the
 * page; the service obeys the same list. `whitespace-nowrap` is gone: a
 * fourth button used to be impossible and four long labels in one row pushed
 * the page wider than a phone (#400) — `flex-wrap` lets them take two rows.
 */
export function CheckpointButtons({
  batchId,
  current,
  options,
}: {
  batchId: string;
  current: string | null;
  options: { key: string; label: string }[];
}) {
  const t = useTranslations('batches');
  const [state, formAction, pending] = useActionState<CheckpointActionState, FormData>(
    setTrackingCheckpointAction,
    null,
  );
  const ERRORS: Record<CheckpointErrorCode, string> = {
    forbidden: t('checkpointErrors.forbidden'),
    not_in_transit: t('checkpointErrors.not_in_transit'),
    unknown_key: t('checkpointErrors.unknown_key'),
    not_on_route: t('checkpointErrors.not_on_route'),
  };
  const refusal = state && 'error' in state ? ERRORS[state.error] : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {options.map(({ key, label }) => {
          const active = current === key;
          return (
            <form key={key} action={formAction} className="flex-1">
              <input type="hidden" name="batchId" value={batchId} />
              <input type="hidden" name="key" value={key} />
              <button
                type="submit"
                disabled={pending}
                className={`w-full rounded-lg border-2 px-3 py-2 text-sm font-semibold ${
                  active ? 'border-blue-700 bg-brand-50 text-brand-700' : 'border-line text-ink-700'
                }`}
              >
                {label}
              </button>
            </form>
          );
        })}
      </div>
      {refusal && (
        <p role="alert" className="text-sm font-semibold text-bad" data-testid="checkpoint-refusal">
          {refusal}
        </p>
      )}
    </div>
  );
}
