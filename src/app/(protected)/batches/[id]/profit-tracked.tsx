'use client';

import { useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { setProfitTrackedAction } from '../batch-actions-server';

/**
 * «Partiya» — the mark «Partiya foydasi» reads (0107). One tap, and the
 * button IS the record: its pressed state says the truck is in the report,
 * so there is no second line to disagree with it. The form posts the value it
 * wants, never «flip», so a double tap lands where the person meant.
 */
export function ProfitTracked({ batchId, tracked }: { batchId: string; tracked: boolean }) {
  const t = useTranslations('batches');
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(fd) => startTransition(() => setProfitTrackedAction(fd))}
      className="card !p-3"
    >
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="tracked" value={tracked ? '0' : '1'} />
      <button
        type="submit"
        disabled={pending}
        className={`w-full rounded-lg border-2 px-3 py-2 text-sm font-semibold ${
          tracked ? 'border-good bg-good/10 text-good' : 'border-line text-ink-700'
        }`}
        data-testid="batch-profit-tracked"
        aria-pressed={tracked}
      >
        {tracked ? `✅ ${t('profitTrackedOn')}` : `☐ ${t('profitTrackedSet')}`}
      </button>
      <p className="mt-1 text-xs text-ink-500">{t('profitTrackedHint')}</p>
    </form>
  );
}
