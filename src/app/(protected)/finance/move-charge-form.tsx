'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { moveChargeAction } from './actions';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';

/**
 * «🚚 Ko'chirish» — one charge moved onto the truck the cargo rode (0104).
 *
 * A fold, so a row that only reads costs nobody a line. The amount is typed
 * in the row's OWN currency and defaults to the whole price; when the row
 * already sits on a truck, whatever is not moved STAYS there (the split of
 * Q2 / a partial short-load), said beside the box before the press. The
 * server re-derives every refusal (`moveCharge`), and the inputs are
 * controlled so a refused press keeps what was typed (#377/#463).
 */
export function MoveChargeForm({
  txId,
  clientId,
  amount,
  currency,
  fromBatchId,
  targets,
}: {
  txId: string;
  clientId: string;
  amount: number;
  currency: string;
  fromBatchId: string | null;
  targets: { batchId: string; code: string }[];
}) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const [target, setTarget] = useState(targets[0]?.batchId ?? '');
  const [typed, setTyped] = useState(amount.toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  if (targets.length === 0) return null;

  const moving = parseTypedMoney(typed);
  const staying = moving === null ? null : Math.round((amount - moving) * 100) / 100;
  const words: Record<string, string> = {
    not_movable: t('moveRefused'),
    move_sum_mismatch: t('moveSumMismatch', { amount: `${amount.toFixed(2)} ${currency}` }),
    move_noop: t('moveNoop'),
    client_not_aboard: t('clientNotAboard'),
    internal_batch: t('internalBatchRefused'),
    forbidden: tc('forbidden'),
  };

  const submit = () => {
    setError(null);
    if (moving === null || moving <= 0) {
      setError(tc('error'));
      return;
    }
    const parts = [{ batchId: target, amount: moving.toFixed(2) }];
    if (fromBatchId && staying !== null && staying > 0.004) {
      parts.push({ batchId: fromBatchId, amount: staying.toFixed(2) });
    }
    start(async () => {
      const result = await moveChargeAction({ txId, clientId, parts });
      if (result.ok) setDone(true);
      else setError(words[result.error ?? ''] ?? tc('error'));
    });
  };

  if (done) return <p className="text-xs font-semibold text-good">✅ {tc('saved')}</p>;

  return (
    <details className="text-sm" data-testid="move-charge">
      <summary className="cursor-pointer text-xs font-semibold text-brand-700">{t('moveCharge')}</summary>
      <div className="mt-2 space-y-2 rounded-lg border border-line p-2">
        <p className="text-xs text-ink-500">{t('moveChargeHint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t('txTruck')}
            className="input !w-40 shrink-0"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            data-testid="move-charge-target"
          >
            {targets.map((option) => (
              <option key={option.batchId} value={option.batchId}>
                {option.code}
              </option>
            ))}
          </select>
          <input
            aria-label={t('amount')}
            className="input !w-28 flex-1"
            inputMode="decimal"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            data-testid="move-charge-amount"
          />
          <span className="text-xs text-ink-500">{currency}</span>
        </div>
        {fromBatchId && staying !== null && staying > 0.004 && (
          <p className="num text-xs text-ink-500">
            {t('moveChargeStay')}: {staying.toFixed(2)} {currency}
          </p>
        )}
        {error && (
          <p className="text-xs font-semibold text-bad" data-testid="move-charge-error">
            {error}
          </p>
        )}
        <button
          type="button"
          className="btn-primary w-full disabled:opacity-60"
          disabled={pending}
          onClick={submit}
          data-testid="move-charge-submit"
        >
          {pending ? '…' : t('moveCharge')}
        </button>
      </div>
    </details>
  );
}
