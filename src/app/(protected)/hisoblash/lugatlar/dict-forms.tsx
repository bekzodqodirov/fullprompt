'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  lookupRatesAction,
  saveBazaAction,
  savePriceBookAction,
  saveRatesAction,
  type CalcFormState,
} from '../actions';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import {
  BAZA_BASES,
  DUTY_UNITS,
  isBazaBasis,
  type BazaBasis,
  type DutyMode,
  type DutyUnit,
} from '@/modules/wms/calc/pricing';
import { LAW_SHAPE_KEY, lawValues, unitWordsOf } from '@/modules/wms/calc/law-words';
import { unitLabel } from '@/modules/wms/calc/units';
import { basisLabel } from '@/modules/wms/calc/basis';
import { readNumberCell, type NumberCell } from '@/modules/wms/calc/number-cell';

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
 * always means «from now» — in the office's day, whatever the browser's
 * clock is set to (R5).
 */
const today = () => tashkentDay();

export function BazaForm() {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [amount, setAmount] = useState('');
  const [basis, setBasis] = useState<BazaBasis>('unit');
  const [date, setDate] = useState(today());
  /** «1,125» / «15,000» — asked, never guessed (his B4 a). A dictionary baza
   * reaches the rows through «bazalarni olish», so a typed baza here is a
   * typed baza there: the same one reader as the calculation's cells. */
  const [ambiguous, setAmbiguous] = useState<Extract<NumberCell, { state: 'ambiguous' }> | null>(null);

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
            onChange={(e) => {
              setAmount(e.target.value);
              // A keystroke that settles the shape takes the question away.
              if (readNumberCell(e.target.value).state !== 'ambiguous') setAmbiguous(null);
            }}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('basis')}</span>
          <select
            className="input input-sm !w-20"
            aria-label={t('basis')}
            value={basis}
            onChange={(e) => {
              if (isBazaBasis(e.target.value)) setBasis(e.target.value);
            }}
          >
            {/* The ONE vocabulary (m³ since 0125), never sm3 — nothing is
                VALUED per cm³ of displacement (a vehicle's baza is per dona). */}
            {BAZA_BASES.map((b) => (
              <option key={b} value={b}>
                {basisLabel(b, t('perUnit'))}
              </option>
            ))}
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
          onClick={() => {
            const cell = readNumberCell(amount);
            if (cell.state === 'ambiguous') {
              setAmbiguous(cell);
              return;
            }
            if (cell.state !== 'ok') {
              setError('bad_number');
              return;
            }
            setAmbiguous(null);
            startTransition(async () => {
              const result: CalcFormState = await saveBazaAction({
                name,
                label: name,
                tnvedCode: code,
                bazaUsd: cell.value,
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
            });
          }}
        >
          {tc('save')}
        </button>
      </div>
      {ambiguous ? (
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-2 text-sm" data-testid="baza-ambiguous">
          <p className="font-semibold text-warn">
            {t('ambiguous.baza', { a: ambiguous.decimalText, b: ambiguous.thousandsText })}
          </p>
          <p className="mt-0.5 text-2xs text-ink-600">{t('ambiguous.hint')}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary !min-h-11 font-mono"
              data-testid="baza-ambiguous-decimal"
              onClick={() => {
                setAmount(ambiguous.decimalText);
                setAmbiguous(null);
              }}
            >
              {ambiguous.decimalText}
            </button>
            <button
              type="button"
              className="btn-secondary !min-h-11 font-mono"
              data-testid="baza-ambiguous-thousands"
              onClick={() => {
                setAmount(ambiguous.thousandsText);
                setAmbiguous(null);
              }}
            >
              {ambiguous.thousandsText}
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="chip chip-warn" data-testid="baza-error">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_found') : error}
        </p>
      ) : null}
    </div>
  );
}

export function RatesForm() {
  type ModeChoice = 'book' | DutyMode;
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [duty, setDuty] = useState('');
  const [vat, setVat] = useState('12');
  const [date, setDate] = useState(today());
  // The law's SHAPE (P2.1, judge MR-14). «lug‘atdagidek» is the default and
  // posts NO mode — the service then carries the shape of the row that
  // answers the code today, heading included, so correcting a percentage
  // never strips a floor. Only an explicit «foiz» posts 'advalor'.
  const [mode, setMode] = useState<ModeChoice>('book');
  const [specific, setSpecific] = useState('');
  const [unit, setUnit] = useState<DutyUnit>('kg');
  // What the book says for the typed code TODAY — so «lug‘atdagidek» is a
  // value the person can SEE before saving over it (MR-14's prefill).
  // Keyed by the code it answers: a row for a code the person has since
  // changed is simply not shown, with no reset to run.
  const [standing, setStanding] = useState<{ code: string; row: BookRow | null } | null>(null);
  const words = useMemo(() => unitWordsOf((k) => t(`units.${k}` as 'units.dona')), [t]);

  useEffect(() => {
    const clean = code.replace(/\D/g, '');
    if (!/^\d{4,10}$/.test(clean)) return;
    // A stale answer for a code the person has since changed must not land.
    let live = true;
    const timer = window.setTimeout(() => {
      lookupRatesAction(clean)
        .then((res) => {
          if (!live) return;
          const row = res.row ?? null;
          setStanding({ code: clean, row });
          if (row) {
            // Fill only what the person has not typed themselves.
            setDuty((d) => (d.trim() === '' ? String(row.dutyPct) : d));
            setVat((v) => (v === '12' ? String(row.vatPct) : v));
            if (row.dutySpecific !== null) setSpecific((s) => (s.trim() === '' ? String(row.dutySpecific) : s));
            if (row.dutyUnit) setUnit(row.dutyUnit);
          }
        })
        .catch(() => {
          /* no prefill — the form still saves what is typed */
        });
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [code]);

  const needsSpecific = mode === 'max' || mode === 'plus' || mode === 'specific';
  const shown = standing && standing.code === code.replace(/\D/g, '') ? standing : null;

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
          <span className="label">{t('law.mode')}</span>
          <select
            className="input input-sm !w-auto"
            data-testid="rate-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as ModeChoice)}
          >
            <option value="book">{t('law.modeBook')}</option>
            <option value="advalor">{t('law.modeAdvalor')}</option>
            <option value="max">{t('law.modeMax')}</option>
            <option value="plus">{t('law.modePlus')}</option>
            <option value="specific">{t('law.modeSpecific')}</option>
          </select>
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
        {needsSpecific ? (
          <>
            <label className="text-2xs">
              <span className="label">{t('law.specificAmount')}</span>
              <input
                className="input input-sm !w-20 font-mono tabular-nums"
                inputMode="decimal"
                data-testid="rate-specific"
                value={specific}
                onChange={(e) => setSpecific(e.target.value)}
              />
            </label>
            <label className="text-2xs">
              <span className="label">{t('law.unit')}</span>
              <select
                className="input input-sm !w-auto"
                data-testid="rate-unit"
                value={unit}
                onChange={(e) => setUnit(e.target.value as DutyUnit)}
              >
                {DUTY_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {unitLabel(u, words)}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
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
              // A shape that names a floor needs the floor: refused in words
              // here, before a press reaches the server's bare range check.
              const amount = specific.trim() === '' ? null : Number(specific.replace(',', '.'));
              if (needsSpecific && amount === null) {
                setError('shape_incomplete');
                return;
              }
              const result: CalcFormState = await saveRatesAction({
                tnvedCode: code,
                dutyPct: Number(duty.replace(',', '.')),
                vatPct: Number(vat.replace(',', '.')),
                effectiveDate: date,
                ...(mode === 'book'
                  ? {}
                  : mode === 'advalor'
                    ? { dutyMode: 'advalor' as const }
                    : { dutyMode: mode, dutySpecific: amount, dutyUnit: unit }),
              });
              setError(result.error ?? null);
              if (!result.error) {
                setCode('');
                setDuty('');
                setSpecific('');
                setMode('book');
                router.refresh();
              }
            })
          }
        >
          {tc('save')}
        </button>
      </div>
      {shown ? (
        <p className="text-2xs text-ink-600" data-testid="rate-book-now">
          {shown.row
            ? t('law.bookNow', {
                law: `${shown.row.tnvedCode}: ${t(LAW_SHAPE_KEY[shown.row.dutyMode], lawValues(shown.row, words))} / ${t('vat')} ${shown.row.vatPct}%`,
              })
            : t('law.bookNone')}
        </p>
      ) : null}
      {error ? (
        <p className="chip chip-warn" data-testid="rate-error">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_found') : error}
        </p>
      ) : null}
    </div>
  );
}

/** The row that answers a typed code today, as the prefill reads it. */
type BookRow = {
  tnvedCode: string;
  dutyPct: number;
  vatPct: number;
  dutyMode: DutyMode;
  dutySpecific: number | null;
  dutyUnit: DutyUnit | null;
};

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
