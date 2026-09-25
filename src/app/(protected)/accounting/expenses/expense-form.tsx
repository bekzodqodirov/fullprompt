'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { addExpenseAction, type AccountingFormState } from '../actions';

interface Option {
  id: string;
  label: string;
}

/** A category, with whether it moves money (U06). */
export interface CategoryOption extends Option {
  cash: boolean;
}

/**
 * One expense. Warehouse and employee stay optional: rent belongs to a
 * warehouse, a salary to a person, and a bank fee to neither — forcing either
 * would make the operator invent an answer.
 */
export function ExpenseForm({
  categories,
  accounts,
  warehouses,
  employees,
  currencies,
  today,
  partners = [],
  prefill,
}: {
  categories: CategoryOption[];
  accounts: Option[];
  warehouses: Option[];
  employees: Option[];
  currencies: string[];
  today: string;
  /**
   * Counterparties who settle expenses on our behalf (round 39): the Chinese
   * warehouses are rented jointly with a transport company and the Chinese
   * staff are paid through it. Picking one means no cash box moves.
   */
  partners?: Option[];
  /**
   * A rasxod xabari being entered (round 107): the REQUEST ROW's own values,
   * loaded server-side by id — never amounts out of a URL, which would be a
   * forged sum under the accountant's rubber stamp. The page keys this form
   * on the request id, so the defaults actually land (the round-61 keyed-
   * inputs trap).
   */
  prefill?: {
    requestId: string;
    amount: string;
    currency: string;
    note: string;
    /** Null when the request was filed from /profile, off any warehouse. */
    warehouseId: string | null;
    /** «O'z pulimdan to'ladim»: the reporter paid, so they are the payer. */
    paidBySelf?: boolean;
    /**
     * The reporter's staff account, found by the page from the request row's
     * author (owner M1a) — pre-selected as the payer so the expense books a
     * debt to them. Absent when they have none yet (the page offers the mint).
     */
    partnerId?: string;
    /** The day the warehouse spent it, not today (audit A29). */
    expenseDate: string;
  };
}) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  // `addExpense` drops the cash box whenever a payer is named — correctly, no
  // till of ours moved — but the form offered both at once and said nothing,
  // so the saved row meant something different from what was typed and only a
  // hand reconciliation of the till would ever show it. The picker now
  // disappears with the choice, the way the counterparty form already hides
  // its cash box for the kinds that move no money.
  const [partnerId, setPartnerId] = useState(prefill?.partnerId ?? '');
  // A NON-cash kind (depreciation) is a book entry: no kassa and no payer
  // (U06). Controlled so the two pickers can leave with the choice — a hidden
  // select posts nothing, and the service refuses a hand-built post anyway.
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const bookEntry = categories.find((option) => option.id === categoryId)?.cash === false;
  const [state, formAction, pending] = useActionState<AccountingFormState, FormData>(
    addExpenseAction,
    {},
  );

  return (
    <form action={formAction} className="card space-y-2">
      <h2 className="text-sm font-bold uppercase text-ink-500">🧾 {t('addExpense')}</h2>
      {prefill && (
        <>
          <input type="hidden" name="requestId" value={prefill.requestId} />
          <p className="rounded-lg bg-warn/10 p-2 text-xs font-semibold" data-testid="expense-request-hint">
            💸 {prefill.paidBySelf ? t('fromRequestSelf') : t('fromRequest')}
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <select
          name="categoryId"
          aria-label={t('category')}
          className="input min-w-44 flex-1"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          required
        >
          {categories.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          name="amount"
          data-testid="expense-amount"
          inputMode="decimal"
          placeholder={t('amount')}
          aria-label={t('amount')}
          defaultValue={prefill ? prefill.amount : undefined}
          className="input !w-32"
          required
        />
        <select
          name="currency"
          aria-label={t('currency')}
          defaultValue={prefill?.currency}
          className="input !w-24"
        >
          {currencies.map((code) => (
            <option key={code}>{code}</option>
          ))}
        </select>
        <input
          type="date"
          name="expenseDate"
          aria-label={t('date')}
          defaultValue={prefill?.expenseDate ?? today}
          // #995's rule, the door's own limit (U21): not after tomorrow.
          max={latestTxDate()}
          className="input !w-40"
          required
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {/* Only while the money is ours. A hidden select posts nothing, so
            the service's own drop becomes unreachable rather than silent. */}
        {!partnerId && !bookEntry && (
          <select name="accountId" aria-label={t('account')} className="input min-w-40 flex-1">
            <option value="">— {t('account')} —</option>
            {accounts.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        <select
          name="warehouseId"
          aria-label={t('warehouse')}
          defaultValue={prefill?.warehouseId ?? ''}
          className="input !w-32"
        >
          <option value="">— {t('warehouse')} —</option>
          {warehouses.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {partners.length > 0 && !bookEntry && (
          <select
            name="partnerId"
            aria-label={t('paidBy')}
            data-testid="expense-partner"
            className="input min-w-40 flex-1"
            value={partnerId}
            onChange={(event) => setPartnerId(event.target.value)}
          >
            <option value="">— {t('paidByUs')} —</option>
            {partners.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        )}
        <select name="employeeId" aria-label={t('employee')} className="input min-w-40 flex-1">
          <option value="">— {t('employee')} —</option>
          {employees.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {/* Already translated in all four bundles and never rendered until now:
          the rule was implied by a disappearing field instead of stated. */}
      {partnerId && !bookEntry && <p className="text-xs text-ink-500">{t('paidByHint')}</p>}
      {bookEntry && (
        <p className="text-xs text-ink-500" data-testid="expense-non-cash-hint">
          {t('nonCashHint')}
        </p>
      )}
      <input
        name="note"
        placeholder={t('note')}
        aria-label={t('note')}
        defaultValue={prefill ? prefill.note : undefined}
        className="input"
      />
      <button
        type="submit"
        data-testid="save-expense"
        className="btn-primary w-full"
        disabled={pending}
      >
        {pending ? tc('loading') : t('save')}
      </button>
      {state.ok && <p className="text-sm font-semibold text-good">✅ {tc('saved')}</p>}
      {state.error && (
        <p className="text-sm font-semibold text-bad">
          {state.error === 'fx_missing'
            ? t('fxMissing')
            : state.error === 'account_currency_mismatch'
              ? t('accountCurrencyMismatch')
              : state.error === 'already_decided'
                ? t('requestTaken')
                : state.error === 'future_date'
                  ? tc('futureDate')
                  : state.error === 'amount_too_large'
                    ? tc('amountTooLarge')
                    : state.error === 'non_cash_category'
                      ? t('nonCashCategory')
                      : state.error === 'account_or_payer_required'
                        ? t('accountOrPayerRequired')
                        : tc('error')}
        </p>
      )}
    </form>
  );
}
