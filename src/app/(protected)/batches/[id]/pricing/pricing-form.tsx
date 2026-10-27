'use client';

import { useActionState, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { addTransactionAction, type TxFormState } from '@/app/(protected)/finance/actions';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { deviationOf, needsConfirmation } from '@/modules/wms/finance/deal-price-hint';
import { shownDealChoice } from '@/modules/wms/finance/truck-deal';
import { TruckDealSelect, questionValues, type TruckDealQuestion } from '@/components/truck-deal-select';
import { truckDealErrorKey } from '@/components/truck-deal-errors';

/**
 * One client's negotiated price for this batch → a ledger charge.
 *
 * The amount and the currency are CONTROLLED: React resets a form when its
 * action returns, and a refused price (no FX rate, an unreadable number) must
 * not eat what was typed (#377/#463). A price that WAS saved clears, or a
 * second tap would post a second charge for the same client.
 *
 * The charge's DATE is visible and editable (audit A13). It used to ride a
 * hidden input stamped with the page's render day — in UTC, so a price set
 * before 05:00 in the office was filed on yesterday, and a tab left open
 * overnight posted yesterday's date with nobody able to see it. `today` is
 * Tashkent's day, computed on the server; the person can see it and change it
 * before saving.
 *
 * `expectedUsd` is the deal's price for this cargo (his item 7): a dollar
 * price more than 5 % away from it stops the press once and asks, and the
 * second press saves (his «confirmation sorasin va tasdiqlatib narx
 * qoyaversin»). A warning, never a refusal — the price is still his to set.
 *
 * `secondBill` names the client's cartons aboard whose price already sits on
 * an earlier truck — one price for the whole road (owner, 2026-09-30, 1a/4a:
 * «ogohlantirish bilan qolsin»). A price here is then a second bill, so the
 * press asks first, in any currency; one confirmation covers both questions.
 *
 * `question` (his Q8 «c», 2026-10-27: «logist o'zi tanlaydi»): two or more of
 * the client's deals ride this truck, so the person chooses which one the
 * price goes to (`TruckDealSelect`), and every such press asks once — the
 * price is THAT deal's part, a «muddatli» deal lets it through the handover,
 * and the 5 % check compares with the chosen deal's own expected part
 * (`expectedByDeal`, the owner's and the accountant's sight only — law 4).
 * `dealsSeen` is the question the page drew, posted always, so a prixod
 * re-filed before the press is refused (`deals_changed`) and redrawn, never
 * answered for somebody. `pricedHere` — the client's live prices already on
 * this truck — makes ANY further price here ask once: a second bill is
 * always a question, not a habit.
 */
export function PricingForm({
  clientId,
  batchId,
  currencies,
  today,
  expectedAll = null,
  expectedByDeal = {},
  secondBill = null,
  dealsSeen,
  question = null,
  pricedHere = [],
}: {
  clientId: string;
  batchId: string;
  currencies: string[];
  today: string;
  /** The deals' price for ALL this client's cargo here (null when unknown). */
  expectedAll?: number | null;
  /** Each candidate deal's own expected part here (an ambiguous client only). */
  expectedByDeal?: Record<string, number | null>;
  secondBill?: { n: number; codes: string } | null;
  dealsSeen: string;
  question?: TruckDealQuestion | null;
  pricedHere?: { usd: number; dealCode: string | null }[];
}) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const router = useRouter();
  const [amount, setAmount] = useState('');
  // The deal chosen, with the question it was chosen under (`shownDealChoice`).
  const [choice, setChoice] = useState<{ deal: string; seen: string } | null>(null);
  const shown = question ? shownDealChoice(choice, dealsSeen, questionValues(question)) : '';
  const chosen = question?.options.find((option) => option.id === shown) ?? null;
  // The figure the 5 % check compares with: the chosen deal's own part, or —
  // «bitimsiz», or a client with nothing to choose — the whole cargo's.
  const expectedUsd = question ? (shown === '' ? null : shown === 'none' ? expectedAll : (expectedByDeal[shown] ?? null)) : expectedAll;
  // Prices here are dollars (the ledger's unit); the first active currency
  // in the dictionary was CNY, which turned «150» into ¥150 = $20.
  const [currency, setCurrency] = useState(currencies.includes('USD') ? 'USD' : (currencies[0] ?? ''));
  const [txDate, setTxDate] = useState(today);
  // The question the person was asked, as asked: drawn only while the
  // amount, the currency and the deal are still those, and printing the
  // figures it was asked with — a warning about deal A must never be
  // confirmed onto deal B (review).
  const [asked, setAsked] = useState<{
    amount: string;
    currency: string;
    deal: string;
    pct: number | null;
    usd: number | null;
  } | null>(null);
  const confirmed = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<TxFormState, FormData>(
    async (prev, formData) => {
      const result = await addTransactionAction(prev, formData);
      if (result.ok) {
        setAmount('');
        setAsked(null);
        // The next price for this client is usually the OTHER deal's part —
        // chosen again, never carried over.
        setChoice(null);
      }
      if (result.error === 'deals_changed') {
        setChoice(null);
        setAsked(null);
        router.refresh();
      }
      confirmed.current = false;
      return result;
    },
    {},
  );

  return (
    <form
      ref={formRef}
      action={formAction}
      // onSubmit runs before the action; preventing it keeps the action from
      // running at all, which is the whole confirmation.
      onSubmit={(event) => {
        if (confirmed.current) return;
        const typed = parseTypedMoney(amount);
        const deviates = currency === 'USD' && typed !== null && needsConfirmation(typed, expectedUsd);
        // On a two-deal truck every press asks once (Q8 «c»): what the price
        // now means is the deal's part, and the person says so.
        const choiceAsks = question !== null && shown !== '';
        if (!secondBill && !deviates && !choiceAsks && pricedHere.length === 0) return;
        event.preventDefault();
        setAsked({
          amount,
          currency,
          deal: shown,
          pct: deviates ? Math.round((deviationOf(typed!, expectedUsd!) ?? 0) * 100) : null,
          usd: deviates ? expectedUsd : null,
        });
      }}
      className="flex flex-wrap items-center gap-2"
      data-testid="pricing-form"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="type" value="charge" />
      <input type="hidden" name="dealsSeen" value={dealsSeen} />
      {question && (
        <TruckDealSelect
          question={question}
          value={shown}
          stale={choice !== null && shown === ''}
          onChange={(value) => {
            setChoice(value ? { deal: value, seen: dealsSeen } : null);
            setAsked(null);
          }}
        />
      )}
      <input
        name="txDate"
        type="date"
        aria-label={t('date')}
        className="input !w-40 shrink-0"
        value={txDate}
        max={latestTxDate()}
        onChange={(event) => setTxDate(event.target.value)}
        required
      />
      <input
        name="amount"
        aria-label={t('amount')}
        className="input !w-28 flex-1"
        inputMode="decimal"
        placeholder={t('amount')}
        value={amount}
        onChange={(event) => {
          setAmount(event.target.value);
          setAsked(null);
        }}
        required
      />
      <select
        name="currency"
        aria-label={t('currency')}
        className="input !w-24 shrink-0"
        value={currency}
        onChange={(event) => {
          setCurrency(event.target.value);
          setAsked(null);
        }}
      >
        {currencies.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <button type="submit" disabled={pending} className="btn-primary shrink-0 px-4 disabled:opacity-60">
        {pending ? '…' : state.ok && amount === '' ? '✅' : `🧾 ${t('setPrice')}`}
      </button>
      {asked && asked.amount === amount && asked.currency === currency && asked.deal === shown && (
        <div role="alert" className="w-full space-y-2 rounded-lg border border-warn bg-warn/10 p-2 text-sm" data-testid="pricing-deviation">
          {secondBill && (
            <p className="font-semibold text-warn" data-testid="pricing-second-bill">
              ⚠ {t('secondBillWarn', { n: secondBill.n, codes: secondBill.codes })}
            </p>
          )}
          {question && asked.deal === 'none' && (
            <p className="font-semibold text-warn" data-testid="pricing-deal-ask">
              ⚠ {t('truckDealAskNone')}
            </p>
          )}
          {chosen && (
            <p className="font-semibold text-warn" data-testid="pricing-deal-ask">
              ⚠{' '}
              {chosen.pct !== null
                ? t('truckDealAsk', { code: chosen.code, pct: chosen.pct })
                : t('truckDealAskNoShare', { code: chosen.code })}
            </p>
          )}
          {chosen?.deferred && (
            <p className="font-semibold text-warn" data-testid="pricing-deal-ask-deferred">
              ⏳ {t('truckDealDeferred', { code: chosen.code })}
            </p>
          )}
          {pricedHere.length > 0 && (
            <p className="font-semibold text-warn" data-testid="pricing-priced-here-ask">
              ⚠{' '}
              {t('pricedHereAsk', {
                list: pricedHere
                  .map((row) => `$${row.usd.toFixed(2)} → ${row.dealCode ?? t('pricedHereNoDeal')}`)
                  .join(' · '),
              })}
            </p>
          )}
          {asked.pct !== null && asked.usd !== null && (
            <p className="font-semibold text-warn">
              ⚠{' '}
              {t(asked.pct > 0 ? 'priceAboveDeal' : 'priceBelowDeal', {
                pct: Math.abs(asked.pct),
                usd: `$${asked.usd.toFixed(2)}`,
              })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {/* Disabled while the save runs: the alert stays up until the
                answer, and a second tap here would post a second charge
                (review — every price for a davomi client comes through here). */}
            <button
              type="button"
              disabled={pending}
              className="btn-primary px-3 disabled:opacity-60"
              data-testid="pricing-deviation-confirm"
              onClick={() => {
                confirmed.current = true;
                formRef.current?.requestSubmit();
              }}
            >
              {t('priceConfirmAnyway')}
            </button>
            <button type="button" className="btn-secondary px-3" onClick={() => setAsked(null)}>
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}
      {state.error && (
        <p role="alert" className="w-full text-sm font-semibold text-bad" data-testid="pricing-form-error" data-error={state.error}>
          {state.error === 'fx_missing'
            ? t('fxMissing')
            : state.error === 'validation'
              ? t('amountUnreadable')
              : state.error === 'internal_batch'
                ? t('internalBatchRefused')
                : state.error === 'client_not_aboard'
                  ? t('clientNotAboard')
                  : state.error === 'batch_cancelled'
                    ? t('batchCancelledRefused')
                    : truckDealErrorKey(state.error)
                      ? t(truckDealErrorKey(state.error)!)
                      : tc('error')}
        </p>
      )}
    </form>
  );
}
