'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { addTransactionAction, type TxFormState } from '../actions';

/**
 * Add a charge or a payment to a client's ledger (Phase 2.1). No tariffs —
 * the amount is whatever was negotiated; payments carry a method
 * (cash/card/transfer, owner accepts all three).
 */
export function TxForm({
  clientId,
  currencies,
  today,
}: {
  clientId: string;
  currencies: string[];
  today: string;
}) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const [type, setType] = useState<'payment' | 'charge'>('payment');
  const [state, formAction, pending] = useActionState<TxFormState, FormData>(
    addTransactionAction,
    {},
  );

  return (
    <form action={formAction} className="card space-y-2">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="type" value={type} />
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className={`min-h-11 rounded-lg border-2 font-bold ${type === 'payment' ? 'border-green-600 bg-good/10 text-good' : 'border-line text-ink-500'}`}
          onClick={() => setType('payment')}
        >
          ➕ {t('payment')}
        </button>
        <button
          type="button"
          className={`min-h-11 rounded-lg border-2 font-bold ${type === 'charge' ? 'border-red-600 bg-bad/10 text-bad' : 'border-line text-ink-500'}`}
          onClick={() => setType('charge')}
        >
          🧾 {t('charge')}
        </button>
      </div>
      <div className="flex gap-2">
        <input
          name="amount"
          aria-label={t('amount')}
          className="input flex-1"
          inputMode="decimal"
          placeholder={t('amount')}
          required
        />
        <select name="currency" aria-label={t('currency')} className="input !w-28 shrink-0">
          {currencies.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        {type === 'payment' && (
          <select name="method" aria-label={t('method')} className="input flex-1">
            <option value="cash">💵 {t('methodCash')}</option>
            <option value="card">💳 {t('methodCard')}</option>
            <option value="transfer">🏦 {t('methodTransfer')}</option>
          </select>
        )}
        <input name="txDate" aria-label={t('date')} type="date" className="input flex-1" defaultValue={today} required />
      </div>
      <input name="note" className="input" placeholder={t('note')} maxLength={2000} />
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {state.error === 'fx_missing' ? t('fxMissing') : tc('error')}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full disabled:opacity-60">
        {pending ? '…' : state.ok ? `✅ ${tc('saved')}` : tc('save')}
      </button>
    </form>
  );
}
