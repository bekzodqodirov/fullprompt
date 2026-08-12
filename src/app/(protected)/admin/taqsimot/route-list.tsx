'use client';

import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  addRouteAction,
  deleteRouteAction,
  moveRouteAction,
  toggleRouteAction,
  type RoutingFormState,
} from './actions';

export interface RouteView {
  id: string;
  sourceKey: string | null;
  keyword: string | null;
  minM3: number | null;
  maxM3: number | null;
  active: boolean;
  memberNames: string[];
}

/**
 * The ordered rule list. Order IS meaning (first match wins), so the arrows
 * are the main control, not decoration; the fallback sentence at the bottom
 * says where an unclaimed lead goes, because a list that ends in silence reads
 * as «and then it is lost».
 */
export function RouteList(props: {
  routes: RouteView[];
  people: { id: string; name: string }[];
  sources: string[];
}) {
  const t = useTranslations('routing');
  const tc = useTranslations('common');
  const [adding, setAdding] = useState(false);
  const [state, formAction, pending] = useActionState<RoutingFormState, FormData>(
    async (prev, form) => {
      const result = await addRouteAction(prev, form);
      if (result.ok) setAdding(false);
      return result;
    },
    {},
  );

  return (
    <div className="card space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 font-semibold">{t('rulesTitle')}</h2>
        <button
          type="button"
          data-testid="route-add"
          className="btn-secondary !min-h-9 px-3"
          onClick={() => setAdding((value) => !value)}
        >
          {adding ? tc('cancel') : `＋ ${t('add')}`}
        </button>
      </div>

      {props.routes.length === 0 && !adding && (
        <p className="text-sm text-ink-500">{t('noRules')}</p>
      )}

      <ol className="space-y-2">
        {props.routes.map((route, index) => (
          <li
            key={route.id}
            data-testid="route-row"
            className={`rounded-lg border border-line p-2 ${route.active ? '' : 'opacity-60'}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="chip-neutral">{index + 1}</span>
              <span className="font-semibold">
                {route.sourceKey ?? t('anySource')}
                {route.keyword ? ` · «${route.keyword}»` : ''}
                {route.minM3 !== null || route.maxM3 !== null
                  ? ` · ${route.minM3 ?? 0}–${route.maxM3 ?? '∞'} m³`
                  : ''}
              </span>
              {!route.active && <span className="text-xs text-warn">{t('paused')}</span>}
            </div>
            <p className="mt-1 text-sm text-ink-600">→ {route.memberNames.join(' · ')}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-secondary !min-h-9 px-3"
                aria-label={t('moveUp')}
                onClick={() => void moveRouteAction(route.id, 'up')}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn-secondary !min-h-9 px-3"
                aria-label={t('moveDown')}
                onClick={() => void moveRouteAction(route.id, 'down')}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn-secondary !min-h-9 px-3"
                onClick={() => void toggleRouteAction(route.id, !route.active)}
              >
                {route.active ? t('pause') : t('resume')}
              </button>
              <button
                type="button"
                data-testid="route-delete"
                className="btn-secondary !min-h-9 ml-auto px-3 text-bad"
                onClick={() => {
                  if (window.confirm(t('deleteConfirm'))) void deleteRouteAction(route.id);
                }}
              >
                🗑
              </button>
            </div>
          </li>
        ))}
      </ol>

      {adding && (
        <form action={formAction} className="space-y-2 border-t border-line pt-2">
          {/* One control per line on purpose — two selects side by side clip
              their own labels at 360 px (#421, round 86's find again). */}
          <label className="block text-sm">
            <span className="font-semibold">{t('source')}</span>
            <select name="source" className="input mt-1" defaultValue="">
              <option value="">{t('anySource')}</option>
              {props.sources.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-semibold">{t('keyword')}</span>
            <input name="keyword" className="input mt-1" placeholder={t('keywordHint')} />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">{t('minM3')}</span>
            <input name="minM3" type="number" step="0.1" min="0" className="input mt-1" />
          </label>
          <label className="block text-sm">
            <span className="font-semibold">{t('maxM3')}</span>
            <input name="maxM3" type="number" step="0.1" min="0" className="input mt-1" />
            <span className="mt-0.5 block text-xs text-ink-500">{t('m3Hint')}</span>
          </label>
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold">{t('members')}</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {props.people.map((person) => (
                <label key={person.id} className="flex items-center gap-2 py-0.5 text-sm">
                  <input
                    type="checkbox"
                    name="routeMember"
                    value={person.id}
                    className="h-5 w-5 shrink-0"
                  />
                  <span className="min-w-0 truncate">{person.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {state.error && (
            <p role="alert" className="text-sm font-semibold text-bad">
              {t(`errors.${state.error}` as 'errors.members_required')}
            </p>
          )}
          <button
            type="submit"
            disabled={pending}
            data-testid="route-save"
            className="btn-primary w-full disabled:opacity-50"
          >
            {pending ? tc('loading') : tc('save')}
          </button>
        </form>
      )}

      <p className="text-xs text-ink-500">{t('fallbackNote')}</p>
    </div>
  );
}
