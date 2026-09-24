'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { addTransactionAction, type TxFormState } from '@/app/(protected)/finance/actions';

/**
 * One client's negotiated price for this batch → a ledger charge.
 *
 * The amount and the currency are CONTROLLED: React resets a form when its
 * action returns, and a refused price (no FX rate, an unreadable number) must
 * not eat what was typed (#377/#463). A price that WAS saved clears, or a
 * second tap would post a second charge for the same client.
 */
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
  const [amount, setAmount] = useState('');
  // Prices here are dollars (the ledger's unit); the first active currency
  // in the dictionary was CNY, which turned «150» into ¥150 = $20.
  const [currency, setCurrency] = useState(currencies.includes('USD') ? 'USD' : (currencies[0] ?? ''));
  const [state, formAction, pending] = useActionState<TxFormState, FormData>(
    async (prev, formData) => {
      const result = await addTransactionAction(prev, formData);
      if (result.ok) setAmount('');
      return result;
    },
    {},
  );

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2" data-testid="pricing-form">
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
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        required
      />
      <select
        name="currency"
        aria-label={t('currency')}
        className="input !w-24 shrink-0"
        value={currency}
        onChange={(event) => setCurrency(event.target.value)}
      >
        {currencies.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <button type="submit" disabled={pending} className="btn-primary shrink-0 px-4 disabled:opacity-60">
        {pending ? '…' : state.ok && amount === '' ? '✅' : `🧾 ${t('setPrice')}`}
      </button>
      {state.error && (
        <p role="alert" className="w-full text-sm font-semibold text-bad">
          {state.error === 'fx_missing'
            ? t('fxMissing')
            : state.error === 'validation'
              ? t('amountUnreadable')
              : state.error === 'internal_batch'
                ? t('internalBatchRefused')
                : tc('error')}
        </p>
      )}
    </form>
  );
}
