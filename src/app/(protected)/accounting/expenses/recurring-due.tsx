'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { closingRule, paidSoFar, remainderOf, type PaidPart } from '@/modules/wms/accounting/recurring-math';
import { RECURRING_ERRORS } from './recurring-errors';
import {
  linkRecurringAction,
  payRecurringAction,
  skipRecurringAction,
  unskipRecurringAction,
  type AccountingFormState,
} from '../actions';

/**
 * The four doors of a recurring month (owner's Q6): «To'landi», «Bog'lash»,
 * «Bu oy yo'q», «Qaytarish». Nothing here — and nothing anywhere — posts a
 * month by itself; each fold writes exactly what a kassa holder says
 * happened, on the day it happened.
 */

/** The refusal of any recurring door, in words; an unknown code is the general sentence. */
export function RecurringError({ code }: { code?: string }) {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  if (!code) return null;
  const key = RECURRING_ERRORS[code] ?? 'common.error';
  const [ns, ...rest] = key.split('.');
  const leaf = rest.join('.');
  return (
    <p className="w-full text-sm font-semibold text-bad [overflow-wrap:anywhere]" data-testid="recurring-error">
      {ns === 'accounting' ? t(leaf) : tc(leaf)}
    </p>
  );
}

/** Greyed while the press is in flight (M10) — `useFormStatus` reads the enclosing form. */
function PendingButton({
  children,
  className,
  testId,
  name,
  value,
}: {
  children: ReactNode;
  className: string;
  testId: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name={name} value={value} disabled={pending} className={className} data-testid={testId}>
      {children}
    </button>
  );
}

export interface PayTill {
  id: string;
  name: string;
  currency: string;
}

export interface PayPartner {
  id: string;
  name: string;
}

/**
 * «✓ To'landi» (a book entry: «✓ Yozish»). The template supplies DEFAULTS
 * only: the kassa, the amount and the day are what the person says left.
 */
export function RecurringPayFold({
  recurringId,
  month,
  dueDate,
  cash,
  template,
  paidParts,
  defaultPayer,
  defaultPayerClosed,
  tills,
  partners,
  currencies,
  hasCandidates,
  today,
}: {
  recurringId: string;
  /** 'YYYY-MM'. */
  month: string;
  /** 'YYYY-MM-DD' — a book entry is dated on it (M6). */
  dueDate: string;
  cash: boolean;
  template: { amount: number; currency: string; note: string | null };
  paidParts: PaidPart[];
  /** 'till:<id>' | 'partner:<id>' | '' — only when that option is offered. */
  defaultPayer: string;
  /** The template's usual kassa or firm has been closed since. */
  defaultPayerClosed: boolean;
  tills: PayTill[];
  partners: PayPartner[];
  currencies: string[];
  hasCandidates: boolean;
  today: string;
}) {
  const t = useTranslations('accounting');
  const [state, formAction] = useActionState<AccountingFormState, FormData>(payRecurringAction, {});
  // Controlled, so a refusal keeps what was typed (#463's rule).
  const [payer, setPayer] = useState(defaultPayer);
  const [firmCurrency, setFirmCurrency] = useState(template.currency);
  const till = payer.startsWith('till:') ? tills.find((row) => `till:${row.id}` === payer) : undefined;
  const byFirm = payer.startsWith('partner:');
  const currency = till ? till.currency : byFirm ? firmCurrency : template.currency;
  // The remainder is a default only when it can be KNOWN in the currency the
  // money is leaving in; otherwise the box starts empty and says why.
  const defaultAmount = (cur: string) => {
    const left = remainderOf(template, paidParts, cur);
    return left === null ? '' : String(left);
  };
  const [amount, setAmount] = useState(() => defaultAmount(currency));
  const [touched, setTouched] = useState(false);
  const [date, setDate] = useState(today);
  const [confirmNew, setConfirmNew] = useState(false);
  const [note, setNote] = useState(template.note ?? '');

  const follow = (nextCurrency: string) => {
    if (!touched) setAmount(defaultAmount(nextCurrency));
  };
  const typed = parseTypedMoney(amount);
  // The service's own rule (#513): one button only when the amount alone
  // closes the month; otherwise the person says which it is (O3).
  const needsChoice =
    cash && typed !== null && closingRule(template, paidParts, { amount: typed, currency }) === 'choose';
  const paid = paidSoFar(paidParts, template.currency);

  return (
    <details className="w-full" data-testid="recurring-pay">
      <summary className="cursor-pointer text-sm font-bold text-brand-700">
        {cash ? t('recurringPay') : t('recurringRecord')}
      </summary>
      <form action={formAction} className="mt-2 space-y-2">
        <input type="hidden" name="recurringId" value={recurringId} />
        <input type="hidden" name="month" value={month} />
        {cash ? (
          <>
            <select
              name="payer"
              aria-label={t('paidBy')}
              data-testid="recurring-pay-payer"
              className="input"
              value={payer}
              required
              onChange={(event) => {
                const next = event.target.value;
                setPayer(next);
                const picked = tills.find((row) => `till:${row.id}` === next);
                follow(picked ? picked.currency : next.startsWith('partner:') ? firmCurrency : template.currency);
              }}
            >
              <option value="">{t('recurringPayerPick')}</option>
              {tills.length > 0 && (
                <optgroup label={t('recurringTillGroup')}>
                  {tills.map((row) => (
                    <option key={row.id} value={`till:${row.id}`}>
                      {row.name} ({row.currency})
                    </option>
                  ))}
                </optgroup>
              )}
              {partners.length > 0 && (
                <optgroup label={t('recurringPartnerGroup')}>
                  {partners.map((row) => (
                    <option key={row.id} value={`partner:${row.id}`}>
                      {row.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {defaultPayerClosed && !payer && (
              <p className="text-xs font-semibold text-warn">{t('recurringDefaultTillClosed')}</p>
            )}
          </>
        ) : (
          // A book entry names no kassa and no payer (U06) and is dated on its
          // own day: nothing to choose but the amount.
          <input type="hidden" name="expenseDate" value={dueDate} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            name="amount"
            inputMode="decimal"
            aria-label={t('amount')}
            placeholder={t('amount')}
            data-testid="recurring-pay-amount"
            className="input min-w-0 flex-1"
            value={amount}
            onChange={(event) => {
              setTouched(true);
              setAmount(event.target.value);
            }}
            required
          />
          {byFirm ? (
            <select
              name="currency"
              aria-label={t('currency')}
              className="input !w-24 shrink-0"
              value={firmCurrency}
              onChange={(event) => {
                setFirmCurrency(event.target.value);
                follow(event.target.value);
              }}
            >
              {currencies.map((code) => (
                <option key={code}>{code}</option>
              ))}
            </select>
          ) : (
            // A kassa speaks its own currency — derived by the service, never
            // posted (a USD salary out of the so'm kassa is written in so'm).
            <span className="shrink-0 font-mono text-sm font-bold">{currency}</span>
          )}
        </div>
        {till && till.currency !== template.currency && (
          <p className="text-xs text-ink-500">{t('recurringOtherCurrency', { currency: till.currency })}</p>
        )}
        {paidParts.length > 0 && (
          <p className="text-xs text-ink-500">
            {t('recurringPaidSoFar', {
              paid,
              total: `${template.amount.toLocaleString('en-US')} ${template.currency}`,
            })}
          </p>
        )}
        {cash ? (
          <label className="block text-sm">
            <span className="block text-xs text-ink-500">{t('date')}</span>
            {/* The day the money actually left; never after tomorrow (#995, wc's `max`). */}
            <input
              type="date"
              name="expenseDate"
              aria-label={t('date')}
              data-testid="recurring-pay-date"
              className="input"
              value={date}
              max={latestTxDate()}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </label>
        ) : (
          <p className="text-xs text-ink-500">
            {t('date')}: {dueDate.slice(8, 10)}.{dueDate.slice(5, 7)}.{dueDate.slice(0, 4)}
          </p>
        )}
        {hasCandidates && (
          // Never disabled (#171): an unticked box posts nothing, which IS «no».
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="confirmNew"
              checked={confirmNew}
              onChange={(event) => setConfirmNew(event.target.checked)}
              data-testid="recurring-pay-confirm-new"
              className="mt-1"
            />
            <span>{t('recurringConfirmNew')}</span>
          </label>
        )}
        <input
          name="note"
          aria-label={t('note')}
          placeholder={t('note')}
          className="input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        {needsChoice ? (
          <div className="flex flex-col gap-2">
            <PendingButton name="partial" value="off" className="btn-primary w-full" testId="recurring-pay-close">
              {t('recurringCloseWith')}
            </PendingButton>
            <PendingButton name="partial" value="on" className="btn-secondary w-full" testId="recurring-pay-partial">
              {t('recurringPartialRest')}
            </PendingButton>
          </div>
        ) : (
          <PendingButton className="btn-primary w-full" testId="recurring-pay-save">
            {cash ? t('recurringPay') : t('recurringRecord')}
          </PendingButton>
        )}
        <RecurringError code={state.error} />
      </form>
    </details>
  );
}

/**
 * «Bog'lash» — one hand-typed payment that may be this month's (M1). The
 * same closing rule as the pay fold, over the candidate's own amount.
 */
export function RecurringLinkForm({
  recurringId,
  month,
  expenseId,
  cash,
  template,
  paidParts,
  candidate,
}: {
  recurringId: string;
  month: string;
  expenseId: string;
  cash: boolean;
  template: { amount: number; currency: string };
  paidParts: PaidPart[];
  candidate: { amount: number; currency: string };
}) {
  const t = useTranslations('accounting');
  const [state, formAction] = useActionState<AccountingFormState, FormData>(linkRecurringAction, {});
  const needsChoice = cash && closingRule(template, paidParts, candidate) === 'choose';
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="recurringId" value={recurringId} />
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="expenseId" value={expenseId} />
      {needsChoice ? (
        <>
          <PendingButton name="partial" value="off" className="btn-secondary" testId="recurring-link">
            {t('recurringLinkClose')}
          </PendingButton>
          <PendingButton name="partial" value="on" className="btn-secondary" testId="recurring-link-partial">
            {t('recurringLinkPartial')}
          </PendingButton>
        </>
      ) : (
        <PendingButton className="btn-secondary" testId="recurring-link">
          {t('recurringLinkClose')}
        </PendingButton>
      )}
      <RecurringError code={state.error} />
    </form>
  );
}

/** «Bu oy yo'q» — this month will not be paid, and why. */
export function RecurringSkipFold({ recurringId, month }: { recurringId: string; month: string }) {
  const t = useTranslations('accounting');
  const [state, formAction] = useActionState<AccountingFormState, FormData>(skipRecurringAction, {});
  const [reason, setReason] = useState('');
  return (
    <details className="w-full" data-testid="recurring-skip">
      <summary className="cursor-pointer text-xs font-semibold text-ink-500">{t('recurringSkip')}</summary>
      <form action={formAction} className="mt-1 space-y-2">
        <input type="hidden" name="recurringId" value={recurringId} />
        <input type="hidden" name="month" value={month} />
        <input
          name="reason"
          aria-label={t('recurringSkipReason')}
          placeholder={t('recurringSkipReason')}
          data-testid="recurring-skip-reason"
          className="input"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          required
        />
        <PendingButton className="btn-secondary w-full" testId="recurring-skip-save">
          {t('recurringSkipSave')}
        </PendingButton>
        <RecurringError code={state.error} />
      </form>
    </details>
  );
}

/** «Qaytarish» — undo a «Bu oy yo'q»; the month is listed again. */
export function UnskipButton({ id }: { id: string }) {
  const t = useTranslations('accounting');
  const [state, formAction] = useActionState<AccountingFormState, FormData>(unskipRecurringAction, {});
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <PendingButton className="btn-secondary" testId="recurring-unskip">
        {t('recurringUnskip')}
      </PendingButton>
      <RecurringError code={state.error} />
    </form>
  );
}
