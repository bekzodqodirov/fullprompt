'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import {
  deleteMappingAction,
  saveMappingAction,
  type RoutingFormState,
} from './actions';

export interface MappingView {
  key: string;
  target: 'kub' | 'kg' | 'field' | 'note';
  fieldLabel: string | null;
  /** Arrivals carrying this key in the window — 0 is the decay warning. */
  recentCount: number;
}

export interface UnmappedView {
  key: string;
  n: number;
  sample: string;
}

/**
 * The tarjimon: the form's own questions, each with one decision.
 *
 * Discovery is automatic (keys arrive with the leads) AND manual (the row at
 * the bottom) — on deploy morning the seen list is empty precisely when the
 * owner sits down to map his existing form, so waiting for a live lead would
 * be the feature refusing its own setup.
 */
export function FieldMapPanel(props: {
  mappings: MappingView[];
  unmapped: UnmappedView[];
  fields: { id: string; label: string }[];
}) {
  const t = useTranslations('routing');
  const tc = useTranslations('common');
  const [state, formAction, pending] = useActionState<RoutingFormState, FormData>(
    saveMappingAction,
    {},
  );

  const targetLabel = (row: MappingView) => {
    if (row.target === 'kub') return t('targetKub');
    if (row.target === 'kg') return t('targetKg');
    if (row.target === 'note') return t('targetNote');
    return row.fieldLabel ?? '⚠';
  };

  const targetOptions = (
    <>
      <option value="kub">{t('targetKub')}</option>
      <option value="kg">{t('targetKg')}</option>
      {props.fields.map((field) => (
        <option key={field.id} value={`f_${field.id}`}>
          {field.label}
        </option>
      ))}
      <option value="note">{t('targetNote')}</option>
    </>
  );

  return (
    <div className="card space-y-2">
      <h2 className="font-semibold">{t('mapTitle')}</h2>
      <p className="text-xs text-ink-500">{t('mapHint')}</p>

      {props.mappings.length > 0 && (
        <ul className="space-y-1">
          {props.mappings.map((row) => (
            <li
              key={row.key}
              data-testid="map-row"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-sm"
            >
              <span className="min-w-0 flex-1 break-words font-mono text-xs">{row.key}</span>
              <span className="font-semibold">→ {targetLabel(row)}</span>
              {row.recentCount === 0 && (
                <span className="text-xs text-warn" title={t('mapStale')}>
                  ⚠ {t('mapStale')}
                </span>
              )}
              <button
                type="button"
                className="btn-secondary !min-h-9 px-3 text-bad"
                aria-label={tc('delete')}
                onClick={() => void deleteMappingAction(row.key)}
              >
                🗑
              </button>
            </li>
          ))}
        </ul>
      )}

      {props.unmapped.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t('mapUnmapped')}</h3>
          {props.unmapped.map((row) => (
            <form
              key={row.key}
              action={formAction}
              data-testid="unmapped-row"
              className="space-y-1 rounded-lg border border-dashed border-line p-2 text-sm"
            >
              <input type="hidden" name="key" value={row.key} />
              <p className="break-words font-mono text-xs">{row.key}</p>
              <p className="text-xs text-ink-500">
                «{row.sample}» · ×{row.n}
              </p>
              {/* One control per line — two side by side clip at 360 px (#421). */}
              <select name="target" className="input" defaultValue="note">
                {targetOptions}
              </select>
              <button type="submit" disabled={pending} className="btn-secondary w-full !min-h-9">
                {tc('save')}
              </button>
            </form>
          ))}
        </div>
      )}

      <form action={formAction} className="space-y-1 border-t border-line pt-2">
        <p className="text-sm font-semibold">{t('mapManual')}</p>
        <input
          name="key"
          className="input"
          placeholder={t('mapKeyPlaceholder')}
          data-testid="map-key-input"
        />
        <select name="target" className="input" defaultValue="kub">
          {targetOptions}
        </select>
        {state.error && (
          <p role="alert" className="text-sm font-semibold text-bad">
            {t(`errors.${state.error}` as 'errors.forbidden')}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          data-testid="map-save"
          className="btn-primary w-full disabled:opacity-50"
        >
          {pending ? tc('loading') : state.ok ? '✅' : tc('save')}
        </button>
      </form>
    </div>
  );
}
