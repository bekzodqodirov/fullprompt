'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The line that says the tap landed.
 *
 * The server is in Germany and the people using this are in Uzbekistan, so a
 * screen that renders in 150 ms still takes roughly half a second to arrive —
 * and until it does, App Router shows the OLD page with nothing moving. The
 * owner read that as «sistema qotib ishlayabti»: the app was not so much slow
 * as silent. Measured first (round 45): once the accounting N+1 was gone, no
 * page's server time was the problem — the round trip was.
 *
 * NO Next navigation hooks, deliberately. The first version used
 * `useSearchParams()`, which forces the component under a `<Suspense>`
 * boundary — and Next renders that boundary as its fallback on the server and
 * hydrates it LATE. The click listener was therefore attached long after the
 * page appeared, so the bar could not show for exactly the taps it exists for.
 * Watching `location.href` costs one 90 ms timer, and only while a navigation
 * is actually in flight.
 *
 * A capture-phase listener starts the clock the instant a link is pressed,
 * before any request exists, which is the whole point.
 *
 * It stays INVISIBLE for the first 140 ms. A prefetched page arrives in less
 * than that, and a bar that flashes on every instant navigation teaches people
 * to distrust it — it should mean "this one is taking a moment", not "a tap
 * happened".
 *
 * Portalled to `document.body` for the same reason the dock is: the header
 * carries `backdrop-blur`, and a `backdrop-filter` traps fixed descendants
 * inside its own containing block.
 */

/** Never let the bar suggest it has finished when it has not. */
const CEILING = 92;
/** Below this, the navigation was instant and deserves no furniture. */
const SHOW_AFTER_MS = 140;
/** A navigation that never lands must not leave a bar on screen for ever. */
const GIVE_UP_MS = 20_000;

export function NavProgress() {
  const [progress, setProgress] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const startedAt = useRef(0);
  const startedHref = useRef('');
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function start(event: MouseEvent) {
      // Anything the browser handles itself is not our navigation.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (!anchor.getAttribute('href') || anchor.hasAttribute('download')) return;
      if (anchor.target && anchor.target !== '_self') return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // The same page, or a jump inside it, produces no server work.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      // An API route or a download leaves the app entirely; the browser's own
      // indicator covers those.
      if (url.pathname.startsWith('/api/')) return;
      startedAt.current = Date.now();
      startedHref.current = window.location.href;
      setProgress(0);
      if (showTimer.current) clearTimeout(showTimer.current);
      showTimer.current = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    }
    document.addEventListener('click', start, true);
    return () => {
      document.removeEventListener('click', start, true);
      if (showTimer.current) clearTimeout(showTimer.current);
    };
  }, []);

  // One ticker, alive only while a navigation is. It creeps the bar towards
  // the ceiling — slower as it goes, so a long wait never looks like a stalled
  // one — and watches for the URL that says the screen has landed.
  useEffect(() => {
    if (progress === null) return;
    if (progress >= 100) {
      const done = setTimeout(() => {
        setProgress(null);
        setVisible(false);
      }, 220);
      return () => clearTimeout(done);
    }
    const tick = setTimeout(() => {
      if (window.location.href !== startedHref.current) {
        setProgress(100);
        return;
      }
      if (Date.now() - startedAt.current > GIVE_UP_MS) {
        setProgress(null);
        setVisible(false);
        return;
      }
      setProgress((current) => {
        if (current === null || current >= CEILING) return current;
        return current + Math.max(0.6, (CEILING - current) / 12);
      });
    }, 90);
    return () => clearTimeout(tick);
  }, [progress]);

  // Nothing on the server: the portal needs a document.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5">
      {progress !== null && visible && (
        <div
          data-testid="nav-progress"
          className="h-full bg-brand-600 transition-[width,opacity] duration-200 ease-out"
          style={{ width: `${progress}%`, opacity: progress >= 100 ? 0 : 1 }}
        />
      )}
    </div>,
    document.body,
  );
}
