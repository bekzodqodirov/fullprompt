'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import { addCompensationAction } from '../actions';

export interface LostReceiptOption {
  receiptId: string;
  number: string | null;
  dealCode: string | null;
  goods: string;
  lost: number;
  total: number;
}
export interface LostChargeOption {
  id: string;
  receiptId: string;
  batchCode: string | null;
  dealCode: string | null;
  amount: number;
  currency: string;
  txDate: string;
}

/**
 * «Yo'qolgan yuk: narx va kompensatsiya» (0105, owner's Q15). ONE press does
 * both of his halves: the prices standing for the lost cargo are lowered
 * (each box a new price; empty = leave it, 0 = remove it) and the rest is
 * written as Kompensatsiya. Controlled inputs, and the action ANSWERS instead
 * of resetting the form — a refusal keeps every figure typed (#377/#463).
 * The total shown is a statement; the server re-derives everything.
 *
 * No kassa, method or deal field exists here (a disabled select posts
 * nothing, #171 — none applies): the deal comes from the prixod, and the
 * cash leaves afterwards by «Pul qaytarildi».
 */
export function CompensationForm({
  clientId,
  currencies,
  today,
  receipts,
  charges,
  truncated,
}: {
  clientId: string;
  currencies: string[];
  today: string;
  receipts: LostReceiptOption[];
  charges: LostChargeOption[];
  truncated: boolean;
}) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [receiptId, setReceiptId] = useState(receipts[0]?.receiptId ?? '');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(currencies.includes('USD') ? 'USD' : (currencies[0] ?? 'USD'));
  const [txDate, setTxDate] = useState(today);
  const [note, setNote] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const mine = useMemo(() => charges.filter((charge) => charge.receiptId === receiptId), [charges, receiptId]);
  // The browser's statement of the total, per currency — only a statement.
  const lowered = mine.reduce((sum, charge) => {
    const typed = (prices[charge.id] ?? '').trim();
    if (!typed) return sum;
    const value = typed === '0' ? 0 : parseTypedMoney(typed);
    return value === null || value >= charge.amount ? sum : sum + (charge.amount - value);
  }, 0);
  const comp = parseTypedMoney(amount) ?? 0;
  // The lowered prices' currency, named only when there is one: a sum over
  // two currencies is a count of nothing, so it stays a bare figure then.
  const loweredCurrencies = [
    ...new Set(mine.filter((charge) => (prices[charge.id] ?? '').trim()).map((charge) => charge.currency)),
  ];
  const loweredCurrency = loweredCurrencies.length === 1 ? ` ${loweredCurrencies[0]}` : '';

  if (receipts.length === 0) {
    return (
      <p className="text-sm text-ink-700" data-testid="tx-compensation-none">
        {t('compensationNoLost')}
      </p>
    );
  }

  return (
    <form
      className="space-y-2"
      data-testid="tx-compensation-form"
      onSubmit={(event) => {
        event.preventDefault();
        setResult(null);
        start(async () => {
          const res = await addCompensationAction({
            clientId,
            receiptId,
            amount,
            currency,
            txDate,
            note,
            reprices: mine.map((charge) => ({ chargeId: charge.id, newAmount: prices[charge.id] ?? '' })),
          });
          if (res.ok) {
            setAmount('');
            setNote('');
            setPrices({});
            setResult({ ok: true, text: t('compensationSaved') });
            router.refresh();
          } else {
            setResult({ ok: false, text: compensationError(res.error, t, tc) });
          }
        });
      }}
    >
      <label className="block text-xs font-semibold text-ink-700">
        {t('compensationReceipt')}
        <select
          name="receiptId"
          required
          className="input mt-1"
          data-testid="tx-receipt"
          value={receiptId}
          onChange={(event) => {
            setReceiptId(event.target.value);
            setPrices({});
          }}
        >
          {receipts.map((row) => (
            <option key={row.receiptId} value={row.receiptId}>
              {row.number ?? '—'} · {row.goods.slice(0, 40)} · {t('compensationLostCount', { count: row.lost, total: row.total })}
              {row.dealCode ? ` · ${row.dealCode}` : ''}
            </option>
          ))}
        </select>
      </label>
      {truncated && <p className="text-xs text-ink-500">{t('compensationTruncated')}</p>}

      {mine.length > 0 && (
        <div className="space-y-1 rounded-lg bg-surface-sunken p-2" data-testid="tx-compensation-charges">
          <p className="text-xs font-semibold text-ink-700">{t('compensationCharges')}</p>
          {mine.map((charge) => (
            <div key={charge.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="min-w-0 flex-1 font-mono text-xs">
                {charge.batchCode ?? charge.dealCode ?? '—'} · {charge.amount} {charge.currency} · {charge.txDate}
              </span>
              <input
                className="input !w-28 shrink-0"
                inputMode="decimal"
                aria-label={t('compensationNewPrice')}
                placeholder={t('compensationNewPrice')}
                data-testid="tx-reprice"
                value={prices[charge.id] ?? ''}
                onChange={(event) => setPrices((prev) => ({ ...prev, [charge.id]: event.target.value }))}
              />
            </div>
          ))}
          <p className="text-xs text-ink-500">{t('compensationZeroHint')}</p>
        </div>
      )}

      <label className="block text-xs font-semibold text-ink-700">{t('compensationAmount')}</label>
      <div className="flex gap-2">
        <input
          className="input flex-1"
          inputMode="decimal"
          aria-label={t('compensationAmount')}
          placeholder={t('amount')}
          data-testid="tx-compensation-amount"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
        <select
          aria-label={t('currency')}
          className="input !w-28 shrink-0"
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
        >
          {currencies.map((code) => (
            <option key={code}>{code}</option>
          ))}
        </select>
      </div>
      <input
        type="date"
        aria-label={t('date')}
        className="input"
        value={txDate}
        max={latestTxDate()}
        onChange={(event) => setTxDate(event.target.value)}
        required
      />
      <input
        className="input"
        required
        minLength={3}
        maxLength={2000}
        placeholder={t('compensationReason')}
        aria-label={t('compensationReason')}
        data-testid="tx-compensation-reason"
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {(lowered > 0 || comp > 0) && (
        <p className="text-sm font-semibold text-ink-700" data-testid="tx-compensation-total">
          {t('compensationTotal', {
            lowered: `${lowered.toFixed(2)}${loweredCurrency}`,
            comp: `${comp.toFixed(2)} ${currency}`,
          })}
        </p>
      )}
      <p className="text-xs text-ink-500">{t('compensationHint')}</p>
      {result && (
        <p role={result.ok ? 'status' : 'alert'} className={`text-sm font-semibold ${result.ok ? 'text-good' : 'text-bad'}`}>
          {result.text}
        </p>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full disabled:opacity-60" data-testid="tx-compensation-save">
        {pending ? '…' : tc('save')}
      </button>
    </form>
  );
}

/** The refusals in words — a literal map (#163), never a key built from the code. */
const COMPENSATION_ERRORS = {
  receipt_mismatch: 'compensationReceiptMismatch',
  no_lost_cargo: 'compensationNoLostCargo',
  charge_not_for_cargo: 'compensationChargeNotForCargo',
  price_not_lower: 'compensationPriceNotLower',
  charge_taken: 'compensationChargeTaken',
  nothing_to_do: 'compensationNothing',
  validation: 'compensationReasonRequired',
  forbidden: 'payoutForbidden',
  fx_missing: 'fxMissing',
  future_date: 'futureDate',
} as const;

function compensationError(
  code: string | undefined,
  t: (key: string) => string,
  tc: (key: string) => string,
): string {
  if (code === 'amount_too_large') return tc('amountTooLarge');
  const key = code ? COMPENSATION_ERRORS[code as keyof typeof COMPENSATION_ERRORS] : undefined;
  return key ? t(key) : tc('error');
}
