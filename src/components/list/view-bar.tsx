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
 * The saved views of one list: a row of chips, and a fold that saves the
 * current one.
 *
 * A view is a NAME for the address bar, so every chip is an ordinary link —
 * which means a view survives a right-click into a new tab, and the browser's
 * back button walks views the way it walks anything else.
 *
 * The save box is a `<details>` rather than a modal on purpose: it opens under
 * the chips without moving them, and on a phone it does not fight the
 * keyboard for the screen.
 */
export function ViewBar({
  screen,
  path,
  views,
  currentQuery,
  canPublish,
}: {
  screen: string;
  /** The screen's own path, for revalidation and for the chips' hrefs. */
  path: string;
  views: SavedView[];
  /** The normalized query string of what is on screen right now. */
  currentQuery: string;
  canPublish: boolean;
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
      else setOpen(false);
    });
  }

  // `relative` sits on the ROW, not on the ⋯: a panel anchored to a chip that
  // has wrapped to the middle of the row starts 300 px in and pushes the
  // document wider than the phone, which makes mobile Chrome zoom the WHOLE
  // page out (#400) — and then every tap lands somewhere else.
  return (
    <div className="relative space-y-2" data-testid="view-bar">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={path}
          data-testid="view-all"
          onClick={() => setOpen(false)}
          className={`chip ${currentQuery === '' ? 'chip-brand' : 'chip-neutral'}`}
        >
          {t('allRecords')}
        </Link>
        {views.map((view) => (
          <span key={view.id} className="inline-flex items-center">
            <Link
              href={view.query ? `${path}?${view.query}` : path}
              data-testid="view-chip"
              onClick={() => setOpen(false)}
              title={view.mine ? undefined : t('publicView')}
              className={`chip ${active?.id === view.id ? 'chip-brand' : 'chip-neutral'}`}
            >
              {view.pinned && '📌 '}
              {view.name}
              {!view.mine && ' ·'}
              {view.isDefault && ' ★'}
            </Link>
          </span>
        ))}

        {/* Saving is only offered once there is something to save — an empty
            list state is already reachable by the «all» chip. */}
        {(dirty || views.length > 0) && (
          <details
            open={open}
            onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary
              data-testid="view-menu"
              className="chip chip-neutral cursor-pointer list-none marker:hidden"
            >
              ⋯
            </summary>
            {/* Full row width up to 18rem, so it can never be wider than the
                screen whatever the chips above it did. */}
            <div className="absolute left-0 top-full z-30 mt-1 w-full max-w-72 space-y-3 rounded-2xl border border-line bg-surface-raised p-3 shadow-lg">
              {dirty && (
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-ink-700">
                    {t('saveCurrent')}
                  </label>
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
                      // Read the boxes off the DOM: they are plain checkboxes
                      // inside a fold, not a form — a form here would submit
                      // the LIST's GET form that wraps the filters.
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

              {views.length > 0 && (
                <ul className="space-y-1 border-t border-line pt-2 text-sm">
                  {views.map((view) => (
                    <li key={view.id} className="flex items-center gap-1">
                      <span className="flex-1 truncate">{view.name}</span>
                      <button
                        type="button"
                        disabled={pending}
                        title={t('pin')}
                        aria-label={`${t('pin')}: ${view.name}`}
                        className="btn-ghost btn-icon !min-h-8"
                        onClick={() =>
                          run(() => updateViewAction(view.id, { pinned: !view.pinned }, path))
                        }
                      >
                        {view.pinned ? '📌' : '📍'}
                      </button>
                      {view.mine && (
                        <button
                          type="button"
                          disabled={pending}
                          title={t('makeDefault')}
                          aria-label={`${t('makeDefault')}: ${view.name}`}
                          className="btn-ghost btn-icon !min-h-8"
                          onClick={() =>
                            run(() =>
                              updateViewAction(view.id, { isDefault: !view.isDefault }, path),
                            )
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
              )}

              {error && (
                <p className="text-xs text-bad" data-testid="view-error">
                  {t(`error.${error}` as 'error.failed')}
                </p>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
