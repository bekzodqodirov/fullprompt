'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { SearchHit } from '@/modules/wms/search/service';

/**
 * The search box that opens over whatever you were doing.
 *
 * The app bar's icon stays an ordinary link to `/search`, and this intercepts
 * the click: with no JavaScript, or before hydration, pressing it still goes
 * to a working page. Ctrl/⌘+K opens the same panel from anywhere.
 *
 * A PORTAL, not a child (dock.tsx's lesson): the header carries a
 * backdrop-blur, which makes it the containing block for `fixed` descendants
 * and would pin a "full screen" overlay inside a 56 px strip.
 */
export function SearchPalette({ children }: { children: React.ReactNode }) {
  const t = useTranslations('search');
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLInputElement>(null);

  // The layout survives navigation, so an overlay left open stands over the
  // next page (nav.tsx and dock.tsx both do exactly this).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((was) => !was);
      }
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);

  // Debounced, and every answer is checked against the text that asked for it:
  // typing fast means several requests in flight and the slow one must not
  // overwrite the fresh one.
  useEffect(() => {
    if (!open) return;
    const query = text.trim();
    if (query.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHits([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        if (!live) return;
        const data = res.ok ? ((await res.json()) as { hits: SearchHit[] }) : { hits: [] };
        if (live) {
          setHits(data.hits);
          setCursor(0);
        }
      } finally {
        if (live) setBusy(false);
      }
    }, 220);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, open]);

  function go(hit: SearchHit | undefined) {
    if (!hit) return;
    setOpen(false);
    router.push(hit.href);
  }

  return (
    <>
      {/* CAPTURE, not bubble. Next's `<Link>` puts its own handler on the
          anchor, so a bubbling handler on this wrapper runs AFTER the
          navigation has already been started — the icon left the page and the
          panel never opened. The capture phase runs outer-to-inner, and
          `Link` skips its own work when the event is already default-
          prevented, so this is the one place that can win the click. */}
      <span
        onClickCapture={(event) => {
          // Only take over an ordinary left click; ⌘-click still opens the
          // page in a new tab, which is a thing people do with search.
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </span>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
            <button
              type="button"
              aria-label={t('close')}
              className="absolute inset-0 bg-ink-900/40"
              onClick={() => setOpen(false)}
            />
            <div
              data-testid="search-palette"
              className="absolute inset-x-3 top-3 max-h-[80dvh] overflow-y-auto rounded-2xl bg-surface-raised p-3 shadow-pop md:inset-x-auto md:left-1/2 md:w-[34rem] md:-translate-x-1/2"
            >
              <input
                ref={box}
                type="search"
                value={text}
                data-testid="palette-input"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setCursor((at) => Math.min(at + 1, hits.length - 1));
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setCursor((at) => Math.max(at - 1, 0));
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    go(hits[cursor]);
                  }
                }}
                placeholder={t('placeholder')}
                className="input"
              />

              <ul className="mt-2 space-y-0.5">
                {hits.map((hit, index) => (
                  <li key={`${hit.kind}-${hit.id}`}>
                    <button
                      type="button"
                      data-testid="palette-hit"
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => go(hit)}
                      className={`flex w-full items-baseline gap-2 rounded-lg px-2 py-2 text-left ${
                        index === cursor ? 'bg-surface-sunken' : ''
                      }`}
                    >
                      <span className="chip chip-neutral shrink-0">
                        {t(`kind.${hit.kind}` as 'kind.client')}
                      </span>
                      {/* The CODE never truncates: it is the thing somebody
                          typed and the thing they are checking they found.
                          `B-000123` rendered as `B-0…` is a row that cannot
                          be told from the row above it. The label gives way
                          instead. */}
                      <span className="shrink-0 whitespace-nowrap font-semibold">{hit.code}</span>
                      {hit.label && (
                        <span className="truncate text-sm text-ink-500">{hit.label}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>

              {!busy && text.trim().length >= 2 && hits.length === 0 && (
                <p className="px-2 py-3 text-sm text-ink-500">{t('nothing')}</p>
              )}
              {text.trim().length >= 2 && (
                <a
                  href={`/search?q=${encodeURIComponent(text.trim())}`}
                  className="mt-1 block px-2 py-2 text-xs text-ink-500 underline"
                >
                  {t('seeAll')}
                </a>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
