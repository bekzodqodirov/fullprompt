'use client';

import { useActionState, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { addTruckPricesAction, type TruckPricesState } from '@/app/(protected)/finance/actions';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';
import {
  deviationOf,
  needsConfirmation,
  prefillFor,
  type PrefillFacts,
  type PrefillWhy,
} from '@/modules/wms/finance/deal-price-hint';
import { cardSeenOf, pressTotalOf, rowSaysUnreadable, type RowMark } from './table-rules';

/**
 * One row of the price table: a deal of the client's on this truck, or the
 * «bitimsiz» part (`key` 'none'). Built on the server from the ONE reading of
 * what already stands (`pricedHereReading`) — no client price in it for a
 * reader without the quote sight: `expectedUsd` is null and `prefill.sight`
 * false for the VED (law 4).
 */
export interface PricingTableRow {
  key: string;
  /** The deal's code; the «bitimsiz» row's own words for it. */
  code: string;
  /** What the select drew: `code · goods · pct % · m³ · kg`. */
  label: string;
  deferred: boolean;
  /** The row's own live prices here, summed (dollars) — null when none. */
  hereUsd: number | null;
  /**
   * A price here the lost-cargo door lowered to ZERO stands for this row —
   * its own, or the whole cargo's (`zeroedFor`, review A1).
   */
  zeroed: boolean;
  /** The deal carries a live price of its own off any truck. */
  card: boolean;
  /** Other trucks where the deal has a live price (codes). */
  elsewhere: string[];
  /** The 5 % hint's figure for this row (quote sight only). */
  expectedUsd: number | null;
  /** Null for the «bitimsiz» row — it has no quote and is never pre-filled. */
  prefill: PrefillFacts | null;
}

type Ask =
  | { kind: 'extra'; code: string; usd: number }
  | { kind: 'none_extra'; usd: number }
  | { kind: 'whole'; code: string }
  | { kind: 'card'; code: string }
  | { kind: 'zeroed'; code: string }
  | { kind: 'elsewhere'; code: string; codes: string }
  | { kind: 'above' | 'below'; code: string; pct: number; usd: number }
  | { kind: 'deferred'; code: string };

/**
 * «Narx» tab, a client with two or more of his own deals aboard (the owner,
 * 2026-11-08, his 1a-3a: «1 mashinada 1 clientda 10 15 ta prixoda va har
 * birida bitim bolsa narx berishda faqat 1 dona bitim tanlaydigan bolib
 * qolgan»): one row per deal, «Bitimsiz» when some of his cargo here has no
 * deal, one shared date and currency (a press is one moment in one money),
 * one «Saqlash». Blank rows write nothing (his 3a: a deal left blank stays
 * loud «narx yo'q» above).
 *
 * Every amount box is CONTROLLED and never disabled (#171/#377): a refused
 * press keeps what was typed. A row is pre-filled only by the pure rule
 * (`prefillFor`, asked with the currency the select holds NOW) and only while
 * the person has not touched it: a row emptied on purpose stays empty after a
 * save, and a save clears exactly the rows it wrote (judge P1-UX-3).
 *
 * One confirmation per press, only when there is something to ask — and each
 * line names its row, because each row names its deal: never «is this deal's
 * part this deal's part» (the false «qo'shimcha hisob» on the next deal's
 * part is what this table removes). The alert is the question as asked — the
 * amounts, the currency, the date and the page it was drawn on — and any edit
 * takes it back (`reask`). The rows are read in the browser by the price
 * doors' own reader (`parseTypedMoney`): only an EMPTY row is blank, an
 * unreadable one is marked and refused, never silently dropped (P1-UX-8).
 */
export function PricingTable({
  clientId,
  batchId,
  currencies,
  today,
  dealsSeen,
  pricesSeen,
  rows,
  secondBill = null,
  whole = [],
  onResult,
}: {
  clientId: string;
  batchId: string;
  currencies: string[];
  today: string;
  dealsSeen: string;
  pricesSeen: string;
  rows: PricingTableRow[];
  secondBill?: { n: number; codes: string } | null;
  /** Whole-cargo prices standing here — every filled row asks, naming them. */
  whole?: { usd: number; to: string }[];
  onResult: (result: TruckPricesState) => void;
}) {
  const t = useTranslations('finance');
  const tc = useTranslations('common');
  const router = useRouter();
  const [currency, setCurrency] = useState(currencies.includes('USD') ? 'USD' : (currencies[0] ?? ''));
  const [txDate, setTxDate] = useState(today);
  // What the person typed, by row — a row absent here was never touched and
  // shows its pre-fill. Kept by DEAL id, so a redrawn page keeps a figure on
  // the deal it was typed for and drops one whose deal left (never moved).
  const [typed, setTyped] = useState<Record<string, string>>({});
  const rowKeys = rows.map((row) => row.key).join('|');
  const [keysSeen, setKeysSeen] = useState(rowKeys);
  if (keysSeen !== rowKeys) {
    setKeysSeen(rowKeys);
    const keep = new Set(rows.map((row) => row.key));
    setTyped((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => keep.has(key))));
  }
  // The row a refusal is about, WITH its code: only an unreadable amount is
  // that row's own sentence — every other refusal (a figure too large, a deal
  // that left) only outlines the row and is worded once by the wrapper
  // (`rowSaysUnreadable`, review B2).
  const [bad, setBad] = useState<RowMark>(null);

  const prefillOf = (row: PricingTableRow) => (row.prefill ? prefillFor(row.prefill, currency) : null);
  const valueOf = (row: PricingTableRow): string => {
    if (row.key in typed) return typed[row.key]!;
    const prefill = prefillOf(row);
    return prefill && 'usd' in prefill ? prefill.usd.toFixed(2) : '';
  };

  const [asked, setAsked] = useState<{
    key: string;
    asks: Ask[];
    n: number;
    none: boolean;
    total: number;
    currency: string;
  } | null>(null);
  const confirmed = useRef(false);
  const reask = () => {
    setAsked(null);
    confirmed.current = false;
  };
  // The question's identity: every filled row as typed, the money, the day and
  // the page — an alert about one of them is never confirmed onto another.
  const askKey = () =>
    JSON.stringify({
      rows: rows.map((row) => [row.key, valueOf(row)]),
      currency,
      txDate,
      seen: `${dealsSeen}#${pricesSeen}`,
    });

  const formRef = useRef<HTMLFormElement>(null);
  const [, formAction, pending] = useActionState<TruckPricesState, FormData>(async (prev, formData) => {
    const result = await addTruckPricesAction(prev, formData);
    if (result.ok) {
      setAsked(null);
      setBad(null);
      // Exactly the rows this press wrote clear — and stay touched, so the
      // redrawn page never pre-fills them again.
      setTyped((now) => ({ ...now, ...Object.fromEntries((result.written ?? []).map((key) => [key, ''])) }));
    }
    if (result.error === 'deals_changed' || result.error === 'prices_changed') {
      setAsked(null);
      router.refresh();
    }
    if (result.dealId && result.error) setBad({ key: result.dealId, error: result.error });
    confirmed.current = false;
    onResult(result);
    return result;
  }, {});

  const whyWords = (why: PrefillWhy): string | null => {
    switch (why) {
      // Said once above the table, or by the row's «what stands» line, or not
      // the reader's business (the VED is never offered a client price).
      case 'sight':
      case 'continuation':
      case 'whole':
      case 'priced_here':
      case 'zeroed':
      case 'priced_card':
      case 'priced_elsewhere':
        return null;
      case 'off_elsewhere':
        return t('truckPrefillOffElsewhere');
      case 'follows':
        return t('truckPrefillFollows');
      case 'no_quote':
        return t('truckPrefillNoQuote');
      case 'discount':
        return t('truckPrefillDiscount');
      case 'unscaled':
        return t('truckPrefillUnscaled');
      case 'currency':
        return t('truckPrefillCurrency');
    }
  };

  const askWords = (ask: Ask): string => {
    switch (ask.kind) {
      case 'extra':
        return t('truckTableAskExtra', { code: ask.code, usd: `$${ask.usd.toFixed(2)}` });
      case 'none_extra':
        return t('truckTableAskNoneExtra', { usd: `$${ask.usd.toFixed(2)}` });
      case 'whole':
        return t('truckTableAskWhole', {
          code: ask.code,
          list: whole.map((row) => `$${row.usd.toFixed(2)} → ${row.to}`).join(' · '),
        });
      case 'card':
        return t('truckTableAskCard', { code: ask.code });
      case 'zeroed':
        return t('truckTableAskZeroed', { code: ask.code });
      case 'elsewhere':
        return t('truckTableAskElsewhere', { code: ask.code, codes: ask.codes });
      case 'above':
      case 'below':
        return t(ask.kind === 'above' ? 'truckTableAskAbove' : 'truckTableAskBelow', {
          code: ask.code,
          pct: ask.pct,
          usd: `$${ask.usd.toFixed(2)}`,
        });
      case 'deferred':
        return t('truckDealDeferred', { code: ask.code });
    }
  };

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={(event) => {
        if (confirmed.current) return;
        // Read every row as the door will — the browser's half of the refusal
        // (the action asks again): an unreadable row is marked, never dropped.
        const filled: { row: PricingTableRow; amount: number }[] = [];
        for (const row of rows) {
          const text = valueOf(row).trim();
          if (text === '') continue;
          const amount = parseTypedMoney(text);
          if (amount === null || !(amount > 0)) {
            event.preventDefault();
            setBad({ key: row.key, error: 'validation' });
            onResult({ error: 'validation', dealId: row.key });
            return;
          }
          filled.push({ row, amount });
        }
        if (filled.length === 0) {
          event.preventDefault();
          setBad(null);
          onResult({ error: 'deal_parts_empty' });
          return;
        }
        setBad(null);
        const asks: Ask[] = [];
        for (const { row, amount } of filled) {
          const code = row.key === 'none' ? t('pricedHereNoDeal') : row.code;
          // A price already covering every carton of his here asks on EVERY
          // filled row — truck coverage ignores the deal (judge P1-UX-4).
          if (whole.length > 0) asks.push({ kind: 'whole', code });
          else if (row.hereUsd !== null) {
            asks.push(row.key === 'none' ? { kind: 'none_extra', usd: row.hereUsd } : { kind: 'extra', code, usd: row.hereUsd });
          }
          // A part the lost-cargo door gave back is still a price someone set:
          // typed again, the job is billed for what the compensation took back.
          if (row.zeroed) asks.push({ kind: 'zeroed', code });
          if (row.card) asks.push({ kind: 'card', code });
          if (row.elsewhere.length > 0) asks.push({ kind: 'elsewhere', code, codes: row.elsewhere.join(', ') });
          if (currency === 'USD' && needsConfirmation(amount, row.expectedUsd)) {
            const pct = Math.round((deviationOf(amount, row.expectedUsd!) ?? 0) * 100);
            asks.push({ kind: pct > 0 ? 'above' : 'below', code, pct: Math.abs(pct), usd: row.expectedUsd! });
          }
          if (row.deferred) asks.push({ kind: 'deferred', code });
        }
        if (!secondBill && asks.length === 0) return;
        event.preventDefault();
        setAsked({
          key: askKey(),
          asks,
          // «N ta bitim» counts DEALS; «bitimsiz» is said beside them (B3).
          ...pressTotalOf(filled.map((part) => ({ key: part.row.key, amount: part.amount }))),
          currency,
        });
      }}
      className="space-y-2"
      data-testid="pricing-table"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="dealsSeen" value={dealsSeen} />
      <input type="hidden" name="pricesSeen" value={pricesSeen} />
      {/* The posted deals that carried a card price as drawn — the «bitim
          kartasida narx bor» each row asked, or did not. The write body
          re-reads it under the client lock: a card price written meanwhile
          is `prices_changed`, never a second bill nobody was asked about
          (review A4). Recomputed every render, so it is what this press posts. */}
      <input
        type="hidden"
        name="cardSeen"
        value={cardSeenOf(rows, (row) => valueOf(row).trim() !== '')}
      />
      <p className="text-xs font-semibold text-ink-700">{t('truckTableTitle')}</p>
      <div className="flex flex-wrap items-center gap-2">
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
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {rows.map((row) => {
          const prefill = prefillOf(row);
          const why = prefill && 'none' in prefill && !(row.key in typed) ? whyWords(prefill.none) : null;
          const stands = [
            row.hereUsd !== null ? t('truckTableStandsHere', { usd: `$${row.hereUsd.toFixed(2)}` }) : null,
            row.zeroed ? t('truckTableStandsZeroed') : null,
            row.card ? t('pricedHereCardPrice') : null,
            whole.length > 0 ? t('truckTableStandsWhole') : null,
            row.elsewhere.length > 0 ? t('truckTableStandsElsewhere', { codes: row.elsewhere.join(', ') }) : null,
          ].filter(Boolean);
          return (
            <li
              key={row.key}
              className={`flex flex-wrap items-center gap-x-2 gap-y-1 p-2 ${bad?.key === row.key ? 'ring-2 ring-inset ring-bad' : ''}`}
              data-testid="pricing-table-row"
              data-deal={row.key}
              data-bad={bad?.key === row.key ? bad.error : undefined}
            >
              {/* A goods name is free text, often 40+ characters with no
                  break in it: unbroken it widens the page past 360 px and
                  the phone zooms out (#400) — the select clipped it, a row
                  must wrap it. */}
              <div className="min-w-0 flex-1 basis-48 text-sm [overflow-wrap:anywhere]">
                <p className="font-semibold" data-testid="pricing-table-label">
                  {row.deferred ? '⏳ ' : ''}
                  {row.label}
                </p>
                {stands.length > 0 && (
                  <p className="text-xs text-ink-500" data-testid="pricing-table-stands">
                    {stands.join(' · ')}
                  </p>
                )}
                {why && (
                  <p className="text-xs text-ink-500" data-testid="pricing-table-why" data-why={prefill && 'none' in prefill ? prefill.none : undefined}>
                    {why}
                  </p>
                )}
                {rowSaysUnreadable(bad, row.key) && (
                  <p role="alert" className="text-xs font-semibold text-bad" data-testid="pricing-table-bad">
                    {t('truckTableRowUnreadable', { code: row.key === 'none' ? t('pricedHereNoDeal') : row.code })}
                  </p>
                )}
              </div>
              <input
                name={`deal:${row.key}`}
                aria-label={`${t('amount')} — ${row.key === 'none' ? t('pricedHereNoDeal') : row.code}`}
                className="input !w-32 shrink-0"
                inputMode="decimal"
                placeholder={t('amount')}
                value={valueOf(row)}
                onChange={(event) => {
                  const value = event.target.value;
                  setTyped((now) => ({ ...now, [row.key]: value }));
                  if (bad?.key === row.key) setBad(null);
                  reask();
                }}
                data-testid="pricing-table-amount"
              />
            </li>
          );
        })}
      </ul>
      <button
        type="submit"
        disabled={pending}
        className="btn-primary w-full disabled:opacity-60"
        data-testid="pricing-table-save"
      >
        {pending ? '…' : `🧾 ${t('truckTableSave')}`}
      </button>
      {asked && asked.key === askKey() && (
        <div role="alert" className="space-y-2 rounded-lg border border-warn bg-warn/10 p-2 text-sm" data-testid="pricing-deviation">
          <p className="font-semibold" data-testid="pricing-table-total">
            {t(asked.none ? 'truckTableTotalNone' : 'truckTableTotal', {
              n: asked.n,
              amount: `${asked.total.toFixed(2)} ${asked.currency}`,
            })}
          </p>
          {secondBill && (
            <p className="font-semibold text-warn" data-testid="pricing-second-bill">
              ⚠ {t('secondBillWarn', { n: secondBill.n, codes: secondBill.codes })}
            </p>
          )}
          {asked.asks.map((ask, index) => (
            <p
              key={index}
              className="font-semibold text-warn [overflow-wrap:anywhere]"
              data-testid="pricing-table-ask"
              data-kind={ask.kind}
            >
              {ask.kind === 'deferred' ? '⏳' : '⚠'} {askWords(ask)}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            {/* Disabled while the save runs: the alert stays up until the
                answer, and a second tap would post every row a second time. */}
            <button
              type="button"
              disabled={pending}
              className="btn-primary px-3 disabled:opacity-60"
              data-testid="pricing-deviation-confirm"
              onClick={() => {
                // Armed only for a press the browser will send: a form it
                // refuses (a date past today) fires no submit, and the flag
                // would wave the next press through unasked.
                const form = formRef.current;
                if (!form || !form.reportValidity()) return;
                confirmed.current = true;
                form.requestSubmit();
              }}
            >
              {t('truckTableConfirm')}
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
