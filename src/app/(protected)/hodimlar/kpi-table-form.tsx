'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { saveKpiTableAction, type StaffFormState } from './actions';
import { RefusalText } from './forms';

/**
 * The KPI table's editor (`admin.settings.manage`): ONE full grid saved as a
 * new version starting a chosen month — the shape of the version it opens on,
 * with every top and every rate editable. The last row and the last column
 * are the OPEN tops («>150», «350 dan yuqori»), fixed as open because the
 * validator demands exactly one of each.
 *
 * Controlled state serialised into ONE hidden `grid` field, so a refusal —
 * the commonest is `kpi_version_paid` — keeps every typed cell (#377).
 */
export function KpiTableForm({
  tiers: initialTiers,
  bands: initialBands,
  rates: initialRates,
  month: initialMonth,
}: {
  /** Closed tier tops, ascending; the open top is implied last. */
  tiers: number[];
  bands: number[];
  /** rates[tier][band], the open tier/band last. */
  rates: number[][];
  /** `YYYY-MM` the new version starts. */
  month: string;
}) {
  const t = useTranslations('hodimlar');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<StaffFormState, FormData>(saveKpiTableAction, {});
  const [tiers, setTiers] = useState(initialTiers.map(String));
  const [bands, setBands] = useState(initialBands.map(String));
  const [rates, setRates] = useState(initialRates.map((row) => row.map(String)));
  const [month, setMonth] = useState(initialMonth);

  const grid = JSON.stringify(
    [...tiers, null].flatMap((tier, i) =>
      [...bands, null].map((band, j) => ({
        maxM3: tier === null ? null : tier.replace(',', '.'),
        maxDensity: band === null ? null : band,
        rateUsd: (rates[i]?.[j] ?? '').replace(',', '.'),
      })),
    ),
  );

  return (
    <form action={formAction} className="space-y-2" data-testid="kpi-table-form">
      <input type="hidden" name="grid" value={grid} />
      <label className="block text-2xs">
        <span className="label">{t('table.from')}</span>
        <input
          type="month"
          name="month"
          className="input input-sm !w-40"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          required
        />
      </label>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead>
            <tr>
              <th className="p-1 text-left text-2xs text-ink-500">{t('table.corner')}</th>
              {bands.map((band, j) => (
                <th key={j} className="p-1">
                  <input
                    inputMode="numeric"
                    aria-label={t('table.bandTop')}
                    className="input input-sm !w-16"
                    value={band}
                    onChange={(e) => setBands(bands.map((b, k) => (k === j ? e.target.value : b)))}
                  />
                </th>
              ))}
              <th className="p-1 text-2xs text-ink-500">{t('table.open')}</th>
            </tr>
          </thead>
          <tbody>
            {[...tiers, null].map((tier, i) => (
              <tr key={i}>
                <td className="p-1">
                  {tier === null ? (
                    <span className="text-2xs text-ink-500">{t('table.open')}</span>
                  ) : (
                    <input
                      inputMode="decimal"
                      aria-label={t('table.tierTop')}
                      className="input input-sm !w-16"
                      value={tier}
                      onChange={(e) => setTiers(tiers.map((v, k) => (k === i ? e.target.value : v)))}
                    />
                  )}
                </td>
                {[...bands, null].map((_, j) => (
                  <td key={j} className="p-1">
                    <input
                      inputMode="decimal"
                      aria-label={t('table.rate')}
                      className="input input-sm !w-16"
                      value={rates[i]?.[j] ?? ''}
                      onChange={(e) =>
                        setRates(rates.map((row, r) => (r === i ? row.map((v, c) => (c === j ? e.target.value : v)) : row)))
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn-primary" disabled={pending} data-testid="kpi-table-save">
          {tc('save')}
        </button>
        {state.ok && <span className="text-sm text-good">✅</span>}
        <RefusalText state={state} />
      </div>
      <p className="text-2xs text-ink-500">{t('table.saveHint')}</p>
    </form>
  );
}
