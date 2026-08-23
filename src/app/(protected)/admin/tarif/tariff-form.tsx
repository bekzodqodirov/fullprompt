'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { saveTariffAction } from '../../hisoblash/actions';

/**
 * One band: a zone, a floor, a ceiling and a price.
 *
 * The ceiling can be left empty — that is the open-ended top row, the one
 * priced per kilogram. Everything else must state both bounds, because the
 * lookup refuses a density no row covers, and that refusal is the whole point
 * of the gaps in the owner's own table being visible rather than guessed.
 *
 * A zone box rather than a fixed list of two: a third route needs a row here
 * and no code anywhere.
 */
export function TariffForm({ zones }: { zones: string[] }) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [zone, setZone] = useState(zones[0] ?? 'cn');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [price, setPrice] = useState('');
  const [perKg, setPerKg] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-2xs">
          <span className="label">{t('zone')}</span>
          <input
            className="input input-sm !w-28"
            list="tariff-zones"
            data-testid="tariff-zone"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
          />
          <datalist id="tariff-zones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </label>
        <label className="text-2xs">
          <span className="label">{t('minDensity')} kg/m³</span>
          <input
            className="input input-sm !w-24 font-mono tabular-nums"
            data-testid="tariff-min"
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('maxDensity')} kg/m³</span>
          <input
            className="input input-sm !w-24 font-mono tabular-nums"
            placeholder="∞"
            data-testid="tariff-max"
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
        </label>
        <label className="text-2xs">
          <span className="label">{t('price')} $</span>
          <input
            className="input input-sm !w-24 font-mono tabular-nums"
            data-testid="tariff-price"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-1 text-2xs">
          <input type="checkbox" checked={perKg} onChange={(e) => setPerKg(e.target.checked)} />
          {t('perKgCol')}
        </label>
        <label className="text-2xs">
          <span className="label">{t('effectiveDate')}</span>
          <input
            type="date"
            className="input input-sm !w-36"
            data-testid="tariff-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={pending || min.trim() === '' || price.trim() === ''}
          data-testid="tariff-save"
          onClick={() =>
            startTransition(async () => {
              const result = await saveTariffAction({
                zone,
                minDensity: Number(min.replace(',', '.')),
                maxDensity: max.trim() === '' ? null : Number(max.replace(',', '.')),
                priceUsd: Number(price.replace(',', '.')),
                perKg,
                effectiveDate: date,
              });
              setError(result.error ?? null);
              if (!result.error) {
                setMin('');
                setMax('');
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
        <p className="chip chip-warn" data-testid="tariff-error">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_found') : error}
        </p>
      ) : null}
    </div>
  );
}
