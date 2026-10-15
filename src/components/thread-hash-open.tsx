'use client';

import { useEffect } from 'react';

/** Open every closed `<details>` the element sits in — the fold first, then the panel. */
function openAncestors(target: HTMLElement): void {
  for (let el: HTMLElement | null = target; el; el = el.parentElement) {
    // `open = true` and nothing else: ThreadFold's `onToggle` follows the DOM
    // and marks its thread read from there.
    if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
  }
}

/**
 * Land a `#calc-thread-<id>` link OPEN (§3.5 b): the fold sits inside the
 * CalcPanel, itself a `<details>`, and a browser scrolls to an element inside
 * a closed `<details>` without opening it — the dock row, the ping's link and
 * the lenta's chip would all arrive at a closed panel with nothing in view.
 *
 * Three ways in, because they arrive differently:
 *   - a fresh load (the ping's link) — on mount;
 *   - a native anchor's hash change — `hashchange`;
 *   - a Next `<Link>` to the SAME page (the lenta's chip on the card that
 *     owns the request, the dock's row for the card on screen) — no
 *     `hashchange` at all: Next takes the click, sees only the hash differ
 *     and calls `history.pushState`, which fires nothing. So a CAPTURE-phase
 *     click on the document, which runs before Next's own handler on the
 *     anchor: the folds are opened synchronously and Next's scroll then
 *     lands on an element that is visible; our own scroll follows a frame
 *     later for the case where it did not scroll at all.
 */
export function ThreadHashOpen() {
  useEffect(() => {
    const reveal = () => {
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      const target = document.getElementById(decodeURIComponent(hash));
      if (!target) return;
      openAncestors(target);
      target.scrollIntoView({ block: 'start' });
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.('a[href*="#"]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      let url: URL;
      try {
        url = new URL(anchor.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin || url.pathname !== window.location.pathname || !url.hash) return;
      const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
      if (!target) return;
      openAncestors(target);
      requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('hashchange', reveal);
      document.removeEventListener('click', onClick, true);
    };
  }, []);
  return null;
}
