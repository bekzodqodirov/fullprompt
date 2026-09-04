'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  finishCalcAction,
  releaseCalcAction,
  returnCalcAction,
  takeCalcAction,
  type CalcFormState,
} from '../actions';

/**
 * What a VED person can do with a request: take it, hand it back with a
 * reason, or finish it with the figure the seller is waiting for.
 *
 * Controlled inputs and no `<form action>`: the commonest refusal here is
 * «pressed Qaytarish, forgot the reason», and that refusal must not also
 * swallow the reason typed on the second try (#377/#419/#463, four rounds
 * running). The verdict is read before anything is cleared.
 */
export function CalcActions({
  id,
  mine,
  assigned,
  canSeal,
}: {
  id: string;
  /** The request is already this person's. */
  mine: boolean;
  /** Somebody holds it — the release door only makes sense then. */
  assigned: boolean;
  /**
   * The workspace prices cleanly and could be sealed (round 112). Then the
   * fold takes no price: the seal is the one door between a draft and a fact,
   * and «Готово» with a typed number was a way around it. The server refuses
   * it too (`seal_instead`) — this only stops asking for what it will refuse.
   */
  canSeal: boolean;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'return' | 'finish'>('none');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [note, setNote] = useState('');

  const revalidate = `/hisoblash/${id}`;

  const settle = (result: CalcFormState) => {
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setMode('none');
    setReason('');
    setAmount('');
    setNote('');
    router.refresh();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {!mine ? (
          <button
            type="button"
            disabled={pending}
            data-testid="calc-take"
            className="btn-primary"
            onClick={() =>
              startTransition(async () => settle(await takeCalcAction(id, revalidate)))
            }
          >
            {pending ? tc('loading') : t('take')}
          </button>
        ) : null}
        {assigned ? (
          <button
            type="button"
            disabled={pending}
            data-testid="calc-release"
            className="btn-secondary"
            onClick={() =>
              startTransition(async () => settle(await releaseCalcAction(id, revalidate)))
            }
          >
            {t('release')}
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending}
          data-testid="calc-return-open"
          className="btn-secondary"
          onClick={() => setMode(mode === 'return' ? 'none' : 'return')}
        >
          {t('returnBtn')}
        </button>
        <button
          type="button"
          disabled={pending}
          data-testid="calc-finish-open"
          className="btn-primary"
          onClick={() => setMode(mode === 'finish' ? 'none' : 'finish')}
        >
          {t('finish')}
        </button>
      </div>

      {mode === 'return' ? (
        <div className="space-y-2 border-t border-line pt-2">
          <label className="label" htmlFor="calc-reason">
            {t('returnReasonLabel')}
          </label>
          <textarea
            id="calc-reason"
            data-testid="calc-return-reason"
            className="input h-20"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="button"
            disabled={pending}
            data-testid="calc-return"
            className="btn-primary w-full"
            onClick={() =>
              startTransition(async () => settle(await returnCalcAction(id, reason, revalidate)))
            }
          >
            {pending ? tc('loading') : t('returnBtn')}
          </button>
        </div>
      ) : null}

      {mode === 'finish' ? (
        <div className="space-y-2 border-t border-line pt-2">
          {canSeal ? (
            <p className="text-xs font-semibold text-warn" data-testid="calc-seal-instead">
              {t('sealInstead')}
            </p>
          ) : null}
          <div className={canSeal ? 'hidden' : 'flex flex-wrap items-end gap-2'}>
            <div>
              <label className="label" htmlFor="calc-amount">
                {t('answerAmount')}
              </label>
              <input
                id="calc-amount"
                data-testid="calc-answer-amount"
                inputMode="decimal"
                className="input !w-32"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="calc-currency">
                &nbsp;
              </label>
              <select
                id="calc-currency"
                aria-label="calc currency"
                className="input !w-24"
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                <option value="USD">USD</option>
                <option value="UZS">UZS</option>
                <option value="CNY">CNY</option>
              </select>
            </div>
          </div>
          <label className="label" htmlFor="calc-answer-note">
            {t('answerNote')}
          </label>
          <textarea
            id="calc-answer-note"
            data-testid="calc-answer-note"
            className="input h-20"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="button"
            disabled={pending}
            data-testid="calc-finish"
            className="btn-primary w-full"
            onClick={() =>
              startTransition(async () =>
                settle(
                  await finishCalcAction(
                    id,
                    {
                      amount: !canSeal && amount.trim() ? Number(amount.replace(',', '.')) : null,
                      currency,
                      note,
                    },
                    revalidate,
                  ),
                ),
              )
            }
          >
            {pending ? tc('loading') : t('finish')}
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" data-testid="calc-error" className="text-sm font-semibold text-bad">
          {t(`errors.${error}` as 'errors.failed')}
        </p>
      ) : null}
    </div>
  );
}
