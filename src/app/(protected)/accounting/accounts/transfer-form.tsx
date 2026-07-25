'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { addTransferAction, voidTransferAction, type AccountingFormState } from '../actions';

interface Option {
  id: string;
  label: string;
}

/**
 * Moving our own money between our own boxes.
 *
 * Two amounts, not one: a CNY cash box funding a USD account changes currency
 * on the way, and the only honest record is what left one side and what
 * arrived on the other. Recorded apart from expenses so the cash-flow report
 * never reads a transfer as money leaving the business.
 */
export function TransferForm({ accounts, today }: { accounts: Option[]; today: string }) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<AccountingFormState, FormData>(
    addTransferAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <select name="fromAccountId" aria-label={t('fromAccount')} className="input min-w-40 flex-1" required>
          {accounts.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          name="amountFrom"
          inputMode="decimal"
          placeholder={t('amount')}
          aria-label={t('amountFrom')}
          data-testid="transfer-from-amount"
          className="input !w-32"
          required
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <select name="toAccountId" aria-label={t('toAccount')} className="input min-w-40 flex-1" required>
          {accounts.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          name="amountTo"
          inputMode="decimal"
          placeholder={t('amount')}
          aria-label={t('amountTo')}
          data-testid="transfer-to-amount"
          className="input !w-32"
          required
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          type="date"
          name="transferDate"
          aria-label={t('date')}
          defaultValue={today}
          className="input !w-40"
          required
        />
        <input
          name="note"
          placeholder={t('note')}
          aria-label={t('note')}
          className="input min-w-40 flex-1"
        />
      </div>
      <button
        type="submit"
        data-testid="save-transfer"
        className="btn-secondary w-full"
        disabled={pending}
      >
        {pending ? tc('loading') : `↔️ ${t('transfer')}`}
      </button>
      {state.ok && <p className="text-sm font-semibold text-green-700">✅ {tc('saved')}</p>}
      {state.error && (
        <p className="text-sm font-semibold text-red-700">
          {state.error === 'fx_missing'
            ? t('fxMissing')
            : state.error === 'same_account'
              ? t('sameAccount')
              : tc('error')}
        </p>
      )}
    </form>
  );
}

export function VoidTransferButton({ id }: { id: string }) {
  const t = useTranslations('accounting');
  return (
    <button
      type="button"
      className="text-xs font-semibold text-red-700 underline"
      onClick={() => {
        const reason = window.prompt(t('voidReason'));
        if (!reason || reason.trim().length < 2) return;
        void voidTransferAction(id, reason.trim());
      }}
    >
      ✖ {t('void')}
    </button>
  );
}
