'use client';

import { useRouter } from 'next/navigation';
import { useRef, useTransition } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Which columns this list shows, per person.
 *
 * The choice is a `?cols=` parameter rather than a stored preference, for one
 * reason that decides everything else: a saved view is a query string, so a
 * column set becomes savable, shareable and pinnable for free — the same
 * mechanism as the filters beside it.
 *
 * The current query arrives as a PROP rather than from `useSearchParams()`:
 * that hook forces a Suspense boundary which hydrates late, and this codebase
 * has already lost three rebuilds to a control whose click listener was not
 * attached yet (#434).
 *
 * A `<details>` again (see ViewBar): no modal, no layout shift, and the whole
 * thing still works while the list's own GET form is mid-typing.
 */
export function ColumnPicker({
  columns,
  visible,
  query,
}: {
  /** Every column the viewer MAY see, in the screen's own order. */
  columns: { key: string; label: string; always?: boolean }[];
  visible: string[];
  /** The screen's current query string, without the leading `?`. */
  query: string;
}) {
  const t = useTranslations('lists');
  const router = useRouter();
  const [pending, start] = useTransition();
  const box = useRef<HTMLDetailsElement>(null);
  const shown = new Set(visible);

  function go(mutate: (search: URLSearchParams) => void) {
    const search = new URLSearchParams(query);
    mutate(search);
    // Close on the way out. The panel is absolutely positioned OVER the table
    // it is about to change, and a `<details>` keeps its own open state across
    // a navigation — so left open it hides the very column that just appeared
    // and swallows the next tap on the list.
    if (box.current) box.current.open = false;
    start(() => router.push(search.toString() ? `?${search.toString()}` : '?'));
  }

  function apply(next: Set<string>) {
    // Keep the screen's own order — the URL says which columns are on, never
    // in what order the table draws them.
    const value = columns.filter((column) => next.has(column.key)).map((column) => column.key);
    go((search) => search.set('cols', value.join(',')));
  }

  return (
    <details ref={box} className="relative" data-testid="column-picker">
      <summary className="btn-secondary !min-h-10 cursor-pointer list-none px-3 marker:hidden">
        ⋮≡
      </summary>
      {/* Left-anchored and never wider than the screen: a panel hanging off
          either edge rescales the whole page on a phone (#400/#471). The
          callers put this control at the START of its row for the same
          reason. */}
      <div className="absolute left-0 top-full z-30 mt-1 max-h-80 w-[min(16rem,calc(100vw-2rem))] space-y-1 overflow-y-auto rounded-2xl border border-line bg-surface-raised p-3 shadow-lg">
        <p className="text-xs font-semibold text-ink-500">{t('columns')}</p>
        {columns.map((column) => (
          <label key={column.key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={pending || column.always}
              checked={column.always || shown.has(column.key)}
              data-testid={`col-${column.key}`}
              onChange={(event) => {
                const next = new Set(shown);
                if (event.target.checked) next.add(column.key);
                else next.delete(column.key);
                apply(next);
              }}
            />
            <span className={column.always ? 'text-ink-500' : ''}>{column.label}</span>
          </label>
        ))}
        <button
          type="button"
          disabled={pending}
          onClick={() => go((search) => search.delete('cols'))}
          data-testid="cols-reset"
          className="btn-ghost !min-h-8 w-full text-xs"
        >
          {t('resetColumns')}
        </button>
      </div>
    </details>
  );
}
