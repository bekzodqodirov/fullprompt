'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { saveLinesAction, type DealFormState } from './actions';

export interface LineRow {
  id: string;
  description: string;
  tnvedCode: string | null;
  quantity: string | null;
  unit: string | null;
  quotedVolumeM3: string | null;
  quotedWeightKg: string | null;
  quotedAmount: string | null;
}

const BLANK: Omit<LineRow, 'id'> = {
  description: '',
  tnvedCode: null,
  quantity: null,
  unit: null,
  quotedVolumeM3: null,
  quotedWeightKg: null,
  quotedAmount: null,
};

/**
 * The deal's priced items.
 *
 * Sometimes one, often two to four, sometimes a file with fifty goods the VED
 * manager groups by TNVED into about thirty lines. The whole set is replaced
 * on save rather than diffed — an empty submission is a real "there are no
 * lines, the price is one figure" answer, which is how half the owner's deals
 * are actually priced.
 *
 * Rows with no description are dropped server-side, so an unfilled spare row
 * costs nothing.
 */
export function LinesForm({ dealId, lines }: { dealId: string; lines: LineRow[] }) {
  const t = useTranslations('deals');
  const tc = useTranslations('common');
  const action = saveLinesAction.bind(null, dealId);
  const [state, formAction, pending] = useActionState<DealFormState, FormData>(action, {});
  const [rows, setRows] = useState<Omit<LineRow, 'id'>[]>(
    lines.length > 0 ? lines : [{ ...BLANK }],
  );

  return (
    <form action={formAction} className="space-y-2" data-testid="deal-lines-form">
      {lines.length === 0 && <p className="text-xs text-ink-500">{t('noLines')}</p>}

      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="rounded-xl border border-line p-2">
            <input
              name="lineDescription"
              defaultValue={row.description}
              data-testid="line-description"
              placeholder={t('description')}
              className="input"
            />
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              <input
                name="lineTnved"
                defaultValue={row.tnvedCode ?? ''}
                placeholder={t('tnved')}
                aria-label={t('tnved')}
                className="input"
              />
              <input
                name="lineQuantity"
                defaultValue={row.quantity ?? ''}
                inputMode="decimal"
                placeholder={t('quantity')}
                aria-label={t('quantity')}
                className="input"
              />
              <input
                name="lineUnit"
                defaultValue={row.unit ?? ''}
                placeholder={t('unit')}
                aria-label={t('unit')}
                className="input"
              />
              <input
                name="lineVolume"
                defaultValue={row.quotedVolumeM3 ?? ''}
                inputMode="decimal"
                placeholder={t('volume')}
                aria-label={t('volume')}
                className="input"
              />
              <input
                name="lineWeight"
                defaultValue={row.quotedWeightKg ?? ''}
                inputMode="decimal"
                placeholder={t('weight')}
                aria-label={t('weight')}
                className="input"
              />
              <input
                name="lineAmount"
                defaultValue={row.quotedAmount ?? ''}
                inputMode="decimal"
                placeholder={t('amount')}
                aria-label={t('amount')}
                className="input"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setRows((current) => [...current, { ...BLANK }])}
          className="btn-secondary flex-1"
        >
          + {t('addLine')}
        </button>
        <button type="submit" disabled={pending} data-testid="save-lines" className="btn-primary flex-1">
          {pending ? tc('loading') : state.ok ? '✅' : t('save')}
        </button>
      </div>

      {state.error && (
        <p role="alert" className="text-sm font-semibold text-bad">
          {t(`errors.${state.error}` as 'errors.validation')}
        </p>
      )}
    </form>
  );
}
