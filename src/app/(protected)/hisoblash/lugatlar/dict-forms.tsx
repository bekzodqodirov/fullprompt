'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  saveBazaAction,
  savePriceBookAction,
  saveRatesAction,
  type CalcFormState,
} from '../actions';

/**
 * Adding a row to either VED dictionary.
 *
 * Controlled inputs and no `<form action>`, for the reason four rounds have
 * now found the hard way (#377/#419/#463/#521): the commonest refusal here is
 * a mistyped number, and a refusal that also empties the boxes makes the
 * person retype everything they got right.
 *
 * The date defaults to TODAY rather than being left empty. A dictionary row
 * with no date cannot be read at all — «the newest row on or before the day
 * being priced» has nothing to compare — and a person adding a baza almost
 * always means «from now».
 */
const today = () => new Date().toISOString().slice(0, 10);

export function BazaForm() {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [basis, setBasis] = useState<'unit' | 'kg' | 'juft' | 'litr' | 'm2'>('unit');
  const [date, setDate] = useState(today());

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-2xs">
          <span className="label">{t('product')}</span>
          <input
            className="input input-sm !w-44"
            data-testid="baza-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">TNVED</span>
          <input
            className="input input-sm !w-28"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('baza')}</span>
          <input
            className="input input-sm !w-24 font-mono tabular-nums"
            data-testid="baza-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('basis')}</span>
          <select
            className="input input-sm !w-20"
            aria-label={t('basis')}
            value={basis}
            onChange={(e) => setBasis(e.target.value as 'unit' | 'kg' | 'juft' | 'litr' | 'm2')}
          >
            {/* The law's units minus sm3 — nothing is VALUED per cm³ of
                displacement (a vehicle's baza is per dona). */}
            <option value="unit">{t('perUnit')}</option>
            <option value="kg">kg</option>
            <option value="juft">juft</option>
            <option value="litr">litr</option>
            <option value="m2">m²</option>
          </select>
        </label>
        <label className="text-2xs">
          <span className="label">{t('effectiveDate')}</span>
          <input
            type="date"
            className="input input-sm !w-36"
            data-testid="baza-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={pending || !name.trim() || amount.trim() === ''}
          data-testid="baza-save"
          onClick={() =>
            startTransition(async () => {
              const result: CalcFormState = await saveBazaAction({
                name,
                label: name,
                tnvedCode: code,
                bazaUsd: Number(amount.replace(',', '.')),
                basis,
                effectiveDate: date,
              });
              setError(result.error ?? null);
              if (!result.error) {
                setName('');
                setCode('');
                setAmount('');
                router.refresh();
              }
            })
          }
        >
          {tc('save')}
        </button>
      </div>
      {error ? (
        <p className="chip chip-warn" data-testid="baza-error">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_found') : error}
        </p>
      ) : null}
    </div>
  );
}

export function RatesForm() {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [duty, setDuty] = useState('');
  const [vat, setVat] = useState('12');
  const [date, setDate] = useState(today());

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-2xs">
          <span className="label">TNVED</span>
          <input
            className="input input-sm !w-32"
            data-testid="rate-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('duty')} %</span>
          <input
            className="input input-sm !w-20 font-mono tabular-nums"
            data-testid="rate-duty"
            value={duty}
            onChange={(e) => setDuty(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('vat')} %</span>
          <input
            className="input input-sm !w-20 font-mono tabular-nums"
            data-testid="rate-vat"
            value={vat}
            onChange={(e) => setVat(e.target.value)}
          />
        </label>
        {/* The «Сбор $» box is GONE (audit A2): the declaration fee is one per
              DECLARATION, computed from the BHM scale, and a per-code number
              here was charged a second time inside every group. */}
                  <label className="text-2xs">
          <span className="label">{t('effectiveDate')}</span>
          <input
            type="date"
            className="input input-sm !w-36"
            data-testid="rate-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={pending || !code.trim() || duty.trim() === ''}
          data-testid="rate-save"
          onClick={() =>
            startTransition(async () => {
              const result: CalcFormState = await saveRatesAction({
                tnvedCode: code,
                dutyPct: Number(duty.replace(',', '.')),
                vatPct: Number(vat.replace(',', '.')),
                effectiveDate: date,
              });
              setError(result.error ?? null);
              if (!result.error) {
                setCode('');
                setDuty('');
                router.refresh();
              }
            })
          }
        >
          {tc('save')}
        </button>
      </div>
      {error ? (
        <p className="chip chip-warn" data-testid="rate-error">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_found') : error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The price book — the fourth dictionary, and the only one keyed on nothing
 * but a TNVED code.
 *
 * That key is the round's whole design. A product NAME does not normalise
 * («Ayollar kurtkasi» / «куртка жен.» / «women's jacket» are one thing and
 * three strings), while a code is written down, confirmed by a person before
 * anything can be sealed against it, and is already the grain the customs
 * side works in. So «what do we usually charge for this» has an answer that
 * two VED people reach the same way.
 */
export function PriceBookForm() {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [price, setPrice] = useState('');
  const [unit, setUnit] = useState<'m3' | 'kg'>('m3');
  const [date, setDate] = useState(today());

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-2xs">
          <span className="label">TNVED</span>
          <input
            className="input input-sm !w-32"
            data-testid="price-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('product')}</span>
          <input
            className="input input-sm !w-44"
            data-testid="price-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('price')} $</span>
          <input
            className="input input-sm !w-24 font-mono tabular-nums"
            data-testid="price-amount"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('priceUnit')}</span>
          <select
            className="input input-sm !w-20"
            aria-label={t('priceUnit')}
            data-testid="price-unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value as 'm3' | 'kg')}
          >
            <option value="m3">{t('unitM3')}</option>
            <option value="kg">{t('unitKg')}</option>
          </select>
        </label>
        <label className="text-2xs">
          <span className="label">{t('effectiveDate')}</span>
          <input
            type="date"
            className="input input-sm !w-36"
            data-testid="price-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={pending || !code.trim() || !label.trim() || price.trim() === ''}
          data-testid="price-save"
          onClick={() =>
            startTransition(async () => {
              const result: CalcFormState = await savePriceBookAction({
                tnvedCode: code,
                label,
                priceUsd: Number(price.replace(',', '.')),
                unit,
                effectiveDate: date,
              });
              setError(result.error ?? null);
              if (!result.error) {
                setCode('');
                setLabel('');
                setPrice('');
                router.refresh();
              }
            })
          }
        >
          {tc('save')}
        </button>
      </div>
      {error ? (
        <p className="chip chip-warn" data-testid="price-error">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_found') : error}
        </p>
      ) : null}
    </div>
  );
}
