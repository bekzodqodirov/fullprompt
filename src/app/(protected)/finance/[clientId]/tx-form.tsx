'use client';

import { useActionState, useState } from 'react';
import { dealOptionLabel } from '@/modules/wms/deals/cargo-label';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { useTranslations } from 'next-intl';
import { addTransactionAction, type TxFormState } from '../actions';

/**
 * Add a charge or a payment to a client's ledger (Phase 2.1). No tariffs —
 * the amount is whatever was negotiated; payments carry a method
 * (cash/card/transfer, owner accepts all three). A REFUND (owner R6a) is
 * money handed back out of a kassa: it asks for the box like a payment does
 * and raises the balance like a charge.
 */
export function TxForm({
  clientId,
  currencies,
  accounts,
  deals,
  today,
  canRefund,
}: {
  clientId: string;
  currencies: string[];
  accounts: { id: string; name: string; currency: string }[];
  /** The client's open deals — offered so a payment can name its job. */
  deals: { id: string; code: string; title: string | null; cargo: string }[];
  today: string;
  /** Handing cash back is the kassa-holders' door (finance.expenses). */
  canRefund: boolean;
}) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const [type, setType] = useState<'payment' | 'charge' | 'refund'>('payment');
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
        {canRefund && (
          <button
            type="button"
            data-testid="tx-type-refund"
            className={`col-span-2 min-h-11 rounded-lg border-2 text-sm font-bold ${type === 'refund' ? 'border-amber-600 bg-warn/10 text-warn' : 'border-line text-ink-500'}`}
            onClick={() => setType('refund')}
          >
            ↩️ {t('refund')}
          </button>
        )}
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
        {type !== 'charge' && (
          <select name="method" aria-label={t('method')} className="input flex-1">
            <option value="cash">💵 {t('methodCash')}</option>
            <option value="card">💳 {t('methodCard')}</option>
            <option value="transfer">🏦 {t('methodTransfer')}</option>
          </select>
        )}
        <input
          name="txDate"
          aria-label={t('date')}
          type="date"
          className="input flex-1"
          defaultValue={today}
          max={latestTxDate()}
          required
        />
      </div>
      {/* Required for a NEW payment (audit A2): one saved with no kassa left
          the Balans short by its amount for good. Rows from before cash boxes
          existed keep their empty column — the action refuses, history stays. */}
      {type !== 'charge' && (
        <select
          name="accountId"
          aria-label={t('account')}
          className="input"
          defaultValue=""
          required
        >
          <option value="">— {type === 'refund' ? t('refundAccount') : t('account')}</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.currency})
            </option>
          ))}
        </select>
      )}
      {/* Which JOB the money answers. Optional — plenty of money arrives with
          no deal behind it — but for a DEFERRED deal this select is the whole
          mechanism: the handover gate nets a deferral's charges against the
          payments that name it, and a payment that names nothing pays the
          deferral off on paper while the gate goes on excusing other debt. */}
      {deals.length > 0 && (
        <select
          name="dealId"
          aria-label={t('forDeal')}
          className="input"
          defaultValue=""
          data-testid="tx-deal"
        >
          <option value="">— {t('forDeal')}</option>
          {deals.map((deal) => (
            <option key={deal.id} value={deal.id}>
              {dealOptionLabel(deal)}
            </option>
          ))}
        </select>
      )}
      <input name="note" className="input" placeholder={t('note')} maxLength={2000} />
      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {state.error === 'fx_missing'
            ? t('fxMissing')
            : state.error === 'account_currency_mismatch'
              ? t('accountCurrencyMismatch')
              : state.error === 'account_required'
                ? t('accountRequired')
                : state.error === 'refund_on_batch'
                  ? t('refundOnBatch')
                  : state.error === 'future_date'
                    ? t('futureDate')
                    : tc('error')}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full disabled:opacity-60">
        {pending ? '…' : state.ok ? `✅ ${tc('saved')}` : tc('save')}
      </button>
    </form>
  );
}
