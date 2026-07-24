'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { addTransactionAction, type TxFormState } from '@/app/(protected)/finance/actions';

/** One client's negotiated price for this batch → a ledger charge. */
export function PricingForm({
  clientId,
  batchId,
  currencies,
  today,
}: {
  clientId: string;
  batchId: string;
  currencies: string[];
  today: string;
}) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<TxFormState, FormData>(
    addTransactionAction,
    {},
  );

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="type" value="charge" />
      <input type="hidden" name="txDate" value={today} />
      <input
        name="amount"
        aria-label={t('amount')}
        className="input !w-28 flex-1"
        inputMode="decimal"
        placeholder={t('amount')}
        required
      />
      <select name="currency" aria-label={t('currency')} className="input !w-24 shrink-0">
        {currencies.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <button type="submit" disabled={pending} className="btn-primary shrink-0 px-4 disabled:opacity-60">
        {pending ? '…' : state.ok ? '✅' : `🧾 ${t('setPrice')}`}
      </button>
      {state.error && (
        <p role="alert" className="w-full text-sm font-semibold text-red-700">
          {state.error === 'fx_missing' ? t('fxMissing') : tc('error')}
        </p>
      )}
    </form>
  );
}
