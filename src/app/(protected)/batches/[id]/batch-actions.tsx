'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { departBatchAction, finishLoadingAction } from '../../plans/actions';

/** Finish-loading (deviation summary) + depart controls on the batch card. */
export function BatchActions({ batchId, canDepart }: { batchId: string; canDepart: boolean }) {
  const t = useTranslations('batches');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    setPending(true);
    setError(null);
    try {
      const res = await finishLoadingAction(batchId);
      if (res.ok) {
        setSummary(t('finishSummary', { loaded: res.loaded ?? 0, short: res.shortLoaded ?? 0 }));
        router.refresh();
      } else {
        setError(res.error ?? 'error');
      }
    } finally {
      setPending(false);
    }
  }

  async function depart() {
    setPending(true);
    setError(null);
    try {
      const res = await departBatchAction(batchId);
      if (res.ok) router.refresh();
      else setError(res.error ?? 'error');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="finish-loading"
          className="btn-secondary flex-1 whitespace-nowrap px-3 disabled:opacity-50"
          disabled={pending}
          onClick={finish}
        >
          🏁 {t('finishLoading')}
        </button>
        {canDepart && (
          <button
            type="button"
            data-testid="depart-batch"
            className="btn-primary flex-1 whitespace-nowrap px-3 disabled:opacity-50"
            disabled={pending}
            onClick={depart}
          >
            🚀 {t('depart')}
          </button>
        )}
      </div>
      {pending && <p className="text-sm">{tc('loading')}</p>}
      {summary && <p className="rounded-lg bg-blue-50 p-2 text-sm font-semibold">{summary}</p>}
      {error && (
        <p className="rounded-lg bg-red-50 p-2 text-sm font-semibold text-red-800">
          {t(`errors.${error}` as never) || error}
        </p>
      )}
    </div>
  );
}
