'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  deleteViewAction,
  saveViewAction,
  updateViewAction,
} from '@/modules/platform/lists/actions';
import type { SavedView } from '@/modules/platform/lists/service';

/**
 * The board's saved views as ONE toolbar button (round 72).
 *
 * The lists keep `ViewBar` — a table scrolls, so a chips row costs nothing
 * there. A board's height is a viewport calculation and every row above it is
 * paid for (#515), so on the two kanbans the same engine hangs behind a
 * single button: the views are rows in a dropdown, the active one is marked,
 * and the save form appears when the current address is worth naming.
 *
 * Same actions, same `list_views` rows, same testids the specs already press
 * (view-menu / view-chip / view-name / view-save / view-delete) — only the
 * furniture changed.
 */
export function ViewsMenu({
  screen,
  path,
  views,
  currentQuery,
  canPublish,
  label,
}: {
  screen: string;
  path: string;
  views: SavedView[];
  /** The normalized query string of what is on screen right now. */
  currentQuery: string;
  canPublish: boolean;
  /** Already translated — a client component cannot resolve a namespace. */
  label: string;
}) {
  const t = useTranslations('lists');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);

  const active = views.find((view) => view.query === currentQuery);
  const dirty = currentQuery !== '' && !active;

  function run(work: () => Promise<{ error?: string }>) {
    setError(null);
    start(async () => {
      const result = await work();
      if (result?.error) setError(result.error);
    });
  }

  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      data-testid="views-menu"
    >
      <summary
        className={`btn-secondary cursor-pointer list-none px-2.5 marker:content-none ${
          active ? '!border-brand-600 text-brand-700' : 'btn-icon'
        }`}
        aria-label={label}
        title={active ? active.name : label}
        data-testid="view-menu"
      >
        🔖
        {/* State at a glance — the one thing the retired chips row said that
            a bare icon does not: WHICH view the board is wearing. */}
        {active && (
          <span className="ml-1 hidden max-w-24 truncate text-xs font-bold sm:inline">
            {active.name}
          </span>
        )}
      </summary>
      {/* Anchored to the toolbar ROW (`relative` lives there, #471), never to
          this button — right-aligned so it can never leave the screen. */}
      <div className="absolute right-0 top-full z-40 mt-1 w-72 max-w-[calc(100vw-1.5rem)] space-y-3 rounded-2xl border border-line bg-surface-raised p-3 shadow-lg">
        <ul className="space-y-1 text-sm">
          <li>
            <Link
              href={path}
              data-testid="view-all"
              onClick={() => setOpen(false)}
              className={`block rounded-lg px-2 py-1.5 font-semibold ${
                currentQuery === '' ? 'bg-brand-50 text-brand-800' : 'hover:bg-surface-sunken'
              }`}
            >
              {t('allRecords')}
            </Link>
          </li>
          {views.map((view) => (
            <li key={view.id} className="flex items-center gap-1">
              <Link
                href={view.query ? `${path}?${view.query}` : path}
                data-testid="view-chip"
                onClick={() => setOpen(false)}
                title={view.mine ? undefined : t('publicView')}
                className={`min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 font-semibold ${
                  active?.id === view.id ? 'bg-brand-50 text-brand-800' : 'hover:bg-surface-sunken'
                }`}
              >
                {view.pinned && '📌 '}
                {view.name}
                {!view.mine && ' ·'}
                {view.isDefault && ' ★'}
              </Link>
              {view.mine && (
                <button
                  type="button"
                  disabled={pending}
                  title={t('makeDefault')}
                  aria-label={`${t('makeDefault')}: ${view.name}`}
                  className="btn-ghost btn-icon !min-h-8"
                  onClick={() =>
                    run(() => updateViewAction(view.id, { isDefault: !view.isDefault }, path))
                  }
                >
                  {view.isDefault ? '★' : '☆'}
                </button>
              )}
              <button
                type="button"
                disabled={pending}
                title={t('delete')}
                aria-label={`${t('delete')}: ${view.name}`}
                data-testid="view-delete"
                className="btn-ghost btn-icon !min-h-8 text-bad"
                onClick={() => run(() => deleteViewAction(view.id, path))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>

        {dirty && (
          <div className="space-y-2 border-t border-line pt-2">
            <label className="block text-xs font-semibold text-ink-700">{t('saveCurrent')}</label>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('namePlaceholder')}
              data-testid="view-name"
            />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="makeDefault" data-testid="view-default" />
              {t('makeDefault')}
            </label>
            {canPublish && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="makePublic" data-testid="view-public" />
                {t('makePublic')}
              </label>
            )}
            <button
              type="button"
              disabled={pending}
              data-testid="view-save"
              className="btn-primary !min-h-9 w-full"
              onClick={(event) => {
                const box = event.currentTarget.closest('div');
                const form = new FormData();
                form.set('screen', screen);
                form.set('path', path);
                form.set('name', name);
                form.set('query', currentQuery);
                // Plain checkboxes read off the DOM: a real <form> here would
                // nest inside nothing and submit nowhere — the ViewBar lesson.
                for (const key of ['makeDefault', 'makePublic']) {
                  const input = box?.querySelector<HTMLInputElement>(`input[name="${key}"]`);
                  if (input?.checked) form.set(key, 'on');
                }
                run(() => saveViewAction({}, form));
              }}
            >
              {t('save')}
            </button>
          </div>
        )}

        {error && (
          <p className="text-xs text-bad" data-testid="view-error">
            {t(`error.${error}` as 'error.failed')}
          </p>
        )}
      </div>
    </details>
  );
}
