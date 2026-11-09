'use client';

import { useActionState, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { addTransactionAction, type TxFormState } from '@/app/(protected)/finance/actions';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { deviationOf, needsConfirmation } from '@/modules/wms/finance/deal-price-hint';

/**
 * One client's negotiated price for this batch → a ledger charge — for a
 * client NOBODY has to ask which deal: one deal, deal-less cargo, or one deal
 * beside deal-less cargo (R3a). A client with two or more of his own deals
 * aboard gets the per-deal table instead (`PricingTable`, his 1a of
 * 2026-11-08); this form's old «which deal» select is gone with it — the
 * select stays the client ledger's (`TruckDealSelect`).
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
 * press asks first, in any currency; one confirmation covers every question.
 *
 * `pricedHere` — the client's live prices already on this truck — makes ANY
 * further price here ask once: for such a client one price covers all his
 * cargo here, so a second one IS an extra bill. `dealsSeen` (the question the
 * page drew) and `pricesSeen` (the prices it drew) are posted always, so a
 * prixod re-filed or a colleague's price between the drawing and the press
 * is refused and redrawn (`deals_changed` / `prices_changed`), never answered
 * for somebody. The refusal sentence is the wrapper's (`ClientPricing`): a
 * refusal that turns this client into a table client remounts this body, and
 * the sentence must survive it.
 */
export function PricingForm({
  clientId,
  batchId,
  currencies,
  today,
  expectedAll = null,
  secondBill = null,
  dealsSeen,
  pricesSeen,
  pricedHere = [],
  onResult,
}: {
  clientId: string;
  batchId: string;
  currencies: string[];
  today: string;
  /** The deals' price for ALL this client's cargo here (null when unknown). */
  expectedAll?: number | null;
  secondBill?: { n: number; codes: string } | null;
  dealsSeen: string;
  pricesSeen: string;
  pricedHere?: { usd: number; dealCode: string | null }[];
  onResult: (result: TxFormState) => void;
}) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const expectedUsd = expectedAll;
  // Prices here are dollars (the ledger's unit); the first active currency
  // in the dictionary was CNY, which turned «150» into ¥150 = $20.
  const [currency, setCurrency] = useState(currencies.includes('USD') ? 'USD' : (currencies[0] ?? ''));
  const [txDate, setTxDate] = useState(today);
  // The question the person was asked, as asked: drawn only while the
  // amount, the currency and the page are still those, and printing the
  // figures it was asked with (review).
  const [asked, setAsked] = useState<{
    amount: string;
    currency: string;
    seen: string;
    pct: number | null;
    usd: number | null;
  } | null>(null);
  const confirmed = useRef(false);
  // Anything that changes the question takes back both the alert and a
  // «baribir saqlash» that never reached the action (a press the browser
  // refused leaves the flag armed for the NEXT press — review).
  const reask = () => {
    setAsked(null);
    confirmed.current = false;
  };
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<TxFormState, FormData>(
    async (prev, formData) => {
      const result = await addTransactionAction(prev, formData);
      if (result.ok) {
        setAmount('');
        setAsked(null);
      }
      if (result.error === 'deals_changed' || result.error === 'prices_changed') {
        setAsked(null);
        router.refresh();
      }
      confirmed.current = false;
      onResult(result);
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
        if (!secondBill && !deviates && pricedHere.length === 0) return;
        event.preventDefault();
        setAsked({
          amount,
          currency,
          seen: `${dealsSeen}#${pricesSeen}`,
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
      <input type="hidden" name="pricesSeen" value={pricesSeen} />
      <input
        name="txDate"
        type="date"
        aria-label={t('date')}
        className="input !w-40 shrink-0"
        value={txDate}
        max={latestTxDate()}
        onChange={(event) => {
          setTxDate(event.target.value);
          reask();
        }}
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
          reask();
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
          reask();
        }}
      >
        {currencies.map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <button type="submit" disabled={pending} className="btn-primary shrink-0 px-4 disabled:opacity-60">
        {pending ? '…' : state.ok && amount === '' ? '✅' : `🧾 ${t('setPrice')}`}
      </button>
      {asked && asked.amount === amount && asked.currency === currency && asked.seen === `${dealsSeen}#${pricesSeen}` && (
        <div role="alert" className="w-full space-y-2 rounded-lg border border-warn bg-warn/10 p-2 text-sm" data-testid="pricing-deviation">
          {secondBill && (
            <p className="font-semibold text-warn" data-testid="pricing-second-bill">
              ⚠ {t('secondBillWarn', { n: secondBill.n, codes: secondBill.codes })}
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
            <p className="font-semibold text-warn" data-testid="pricing-deviation-pct">
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
                // Armed only for a press the browser will send: a form it
                // refuses (an empty amount, a date past today) fires no
                // submit, and the flag would wave the next press through.
                const form = formRef.current;
                if (!form || !form.reportValidity()) return;
                confirmed.current = true;
                form.requestSubmit();
              }}
            >
              {t('priceConfirmAnyway')}
            </button>
            <button type="button" className="btn-secondary px-3" onClick={reask}>
              {tc('cancel')}
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
