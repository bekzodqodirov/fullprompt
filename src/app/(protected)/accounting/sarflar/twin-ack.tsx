'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ackTwinPairAction } from './actions';

/**
 * «✓ Ikki xil pul» — one pair off the «tekshirilmagan» count. The action
 * revalidates the map, so the pair simply leaves the list; no refresh here
 * (#1242). A refusal is said beside the button, never swallowed.
 */
const ERROR = {
  forbidden: 'twinAck.forbidden',
  not_found: 'twinAck.notFound',
  not_a_twin: 'twinAck.notATwin',
} as const;

export function TwinAck({ costId, expenseId }: { costId: string; expenseId: string }) {
  const t = useTranslations('sarflar');
  const [pending, start] = useTransition();
  const [error, setError] = useState<keyof typeof ERROR | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <button
        type="button"
        className="rounded border border-line-strong bg-surface px-2 py-0.5 text-xs font-semibold disabled:opacity-50"
        data-testid="twin-ack"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await ackTwinPairAction({ costId, expenseId });
            if (!res.ok) setError(res.error ?? 'not_found');
          })
        }
      >
        ✓ {t('twinAck.button')}
      </button>
      {error && <span className="text-xs font-semibold text-bad">{t(ERROR[error])}</span>}
    </span>
  );
}
