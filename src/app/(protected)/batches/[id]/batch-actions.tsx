'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cancelBatchAction, departBatchAction, finishLoadingAction } from '../../plans/actions';

/**
 * Finish-loading (deviation summary) + depart controls on the batch card, and
 * the way out for a batch that should never have existed.
 *
 * Cancelling is folded in HERE rather than given its own screen because it is
 * only ever offered in the same moment as the other two — while the batch is
 * still forming or loading. Once the truck leaves, all three disappear
 * together and the card shows the unload controls instead.
 *
 * It is deliberately the quiet one of the three: a text button, behind a
 * reason and a confirm, sitting under the two that do the real work.
 */
export function BatchActions({
  batchId,
  canDepart,
  canCancel,
}: {
  batchId: string;
  canDepart: boolean;
  canCancel: boolean;
}) {
  const t = useTranslations('batches');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);

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
    // Everyone confirms — a truck departure locks the load (owner's rule).
    if (!window.confirm(t('departConfirm'))) return;
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

  async function cancel() {
    if (!window.confirm(t('cancelConfirm'))) return;
    setPending(true);
    setError(null);
    try {
      const res = await cancelBatchAction(batchId, reason);
      if (res.ok) {
        setAsking(false);
        setReason('');
        router.refresh();
      } else {
        setError(res.error ?? 'error');
      }
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
      {canCancel &&
        (asking ? (
          <div className="space-y-2 rounded-lg border border-line p-2">
            <label className="label" htmlFor="cancel-reason">
              {t('cancelReason')}
            </label>
            <input
              id="cancel-reason"
              className="input"
              value={reason}
              maxLength={200}
              placeholder={t('cancelBatchHint')}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="cancel-batch-confirm"
                className="btn-danger flex-1 disabled:opacity-50"
                disabled={pending || reason.trim().length < 3}
                onClick={cancel}
              >
                {t('cancelBatch')}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setAsking(false)}>
                {tc('cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-testid="cancel-batch"
            className="text-sm text-ink-500 underline"
            onClick={() => setAsking(true)}
          >
            ✖ {t('cancelBatch')}
          </button>
        ))}
      {pending && <p className="text-sm">{tc('loading')}</p>}
      {summary && <p className="rounded-lg bg-brand-50 p-2 text-sm font-semibold">{summary}</p>}
      {error && (
        <p className="rounded-lg bg-bad/10 p-2 text-sm font-semibold text-bad">
          {t(`errors.${error}` as never) || error}
        </p>
      )}
    </div>
  );
}
