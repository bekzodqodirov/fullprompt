'use client';

import { useActionState, useState, useTransition, type ChangeEvent } from 'react';
import { useTranslations } from 'next-intl';
import { cancelPromiseAction, recordPromiseAction, type PromiseFormState } from './actions';

/** The service's refusals in words — a literal list (#163), anything else is the common error. */
const ERRORS = [
  'not_your_client',
  'bad_amount',
  'bad_date',
  'no_debt',
  'exceeds_debt',
  'promise_open',
  'not_open',
  'not_found',
  'forbidden',
  'validation',
] as const;

function useErrorText() {
  const t = useTranslations('qarz');
  const tc = useTranslations('common');
  return (code: string) =>
    (ERRORS as readonly string[]).includes(code) ? t(`promise.errors.${code}` as 'promise.errors.validation') : tc('error');
}

/**
 * «To'lov va'dasi» — an amount and a day (0114). Controlled inputs: a refusal
 * keeps what was typed (#377/#463); a success needs no clearing, because the
 * revalidated panel draws the open promise in the form's place. The
 * server re-reads the amount through `parseTypedMoney` and re-checks the day,
 * the debt and who may promise; the `min`/`max` here are a convenience.
 */
export function PromiseForm({ clientId, today, maxDay }: { clientId: string; today: string; maxDay: string }) {
  const t = useTranslations('qarz');
  const tc = useTranslations('common');
  const errorText = useErrorText();
  const [state, formAction, pending] = useActionState<PromiseFormState, FormData>(recordPromiseAction, {});
  const [amount, setAmount] = useState('');
  const [dueOn, setDueOn] = useState(today);
  const [note, setNote] = useState('');

  // A named handler, not an arrow inline: the money-form fence (U28) reads
  // the input tag as text and an inline `=>` would hide it from the fence.
  const onAmount = (e: ChangeEvent<HTMLInputElement>) => setAmount(e.target.value);

  return (
    <form action={formAction} className="space-y-2" data-testid="promise-form">
      <input type="hidden" name="clientId" value={clientId} />
      <div className="grid grid-cols-2 gap-2">
        <label className="block min-w-0">
          <span className="label">{t('promise.amount')}</span>
          <input
            name="amount"
            inputMode="decimal"
            required
            className="input"
            value={amount}
            onChange={onAmount}
            data-testid="promise-amount"
          />
        </label>
        <label className="block min-w-0">
          <span className="label">{t('promise.dueOn')}</span>
          <input
            type="date"
            name="dueOn"
            required
            min={today}
            max={maxDay}
            className="input"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            data-testid="promise-due"
          />
        </label>
      </div>
      <label className="block">
        <span className="label">{t('promise.note')}</span>
        <input
          name="note"
          maxLength={500}
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad" data-testid="promise-error">
          {errorText(state.error)}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full" data-testid="promise-save">
        {pending ? tc('loading') : `🤝 ${t('promise.save')}`}
      </button>
      <p className="text-xs text-ink-500">{t('promise.hint')}</p>
    </form>
  );
}

/** Withdraw the open promise; a refusal is said beside the button (#420). */
export function PromiseCancel({ promiseId, clientId }: { promiseId: string; clientId: string }) {
  const t = useTranslations('qarz');
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-wrap items-baseline gap-2">
      <button
        type="button"
        disabled={pending}
        className="text-xs font-semibold text-bad underline"
        data-testid="promise-cancel"
        onClick={() => {
          if (!window.confirm(t('promise.cancelConfirm'))) return;
          setError(null);
          start(async () => {
            const res = await cancelPromiseAction({ promiseId, clientId });
            if (res.error) setError(errorText(res.error));
          });
        }}
      >
        ✖ {t('promise.cancel')}
      </button>
      {error && (
        <span role="alert" className="text-xs font-semibold text-bad">
          {error}
        </span>
      )}
    </span>
  );
}
