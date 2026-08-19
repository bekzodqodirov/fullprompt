'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Refresh a chat surface when — and only when — its thread actually changed.
 *
 * The predecessor was `AutoRefresh`: a blind `router.refresh()` every 10 s
 * (2 s while anything sat in the outbox, `failed` rows included, which only
 * a human's ✕ clears) — a FULL server re-render of the heaviest pages, per
 * visible tab, for ever. Round 108 measured what that does to the one Node
 * process that serves everything: at 8-16 concurrent renders every click in
 * the company waits over a second.
 *
 * This polls `/api/chat/pulse` — a few indexed counts behind the same
 * fences the page reads through — and refreshes only when the token moves.
 * The rules, each one a design-review finding:
 * - the BASELINE is server-rendered (`initial`), computed in the same render
 *   that drew the rows: a client-invented baseline swallows anything that
 *   landed between render and first poll, for ever on a quiet thread;
 * - two speeds stay: ~2 s while something is genuinely in flight (the
 *   server says so via `fast` — queued/sending, never failed), ~5 s idle,
 *   because round 91 was fought over exactly the queued→sent beat;
 * - a 120 s unconditional refresh floor bounds every class the token cannot
 *   see (a client renamed, a rate window reopening) at two minutes;
 * - ticks chain via setTimeout with an abort deadline — a slow server must
 *   not stack requests, which is the pileup this component exists to cure;
 * - errors keep the loop (a deploy's transient 500 must not kill a tab that
 *   looks alive); three CONSECUTIVE auth refusals fire one last refresh —
 *   the page's own guard then walks the reader to /login — and stop.
 */
export function ChatPulse({
  query,
  initial,
  fast,
}: {
  /** The pulse route's query string, e.g. `client=<id>&sibling=1`. */
  query: string;
  /** The token for what THIS render already shows. */
  initial: string;
  /** Whether this render left something in flight. */
  fast: boolean;
}) {
  const router = useRouter();
  const last = useRef(initial);
  const fastRef = useRef(fast);
  // 0 = «this render IS the refresh»; stamped in the effect — the purity
  // lint refuses a clock read during render, and it is right to.
  const lastRefreshAt = useRef(0);

  // Every server render hands down the token for what is now on screen —
  // adopt it, or the first poll after a refresh re-refreshes once for free.
  useEffect(() => {
    last.current = initial;
    fastRef.current = fast;
  }, [initial, fast]);

  useEffect(() => {
    let stopped = false;
    let authFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | null = null;
    lastRefreshAt.current = Date.now();

    function schedule(ms?: number) {
      if (stopped) return;
      timer = setTimeout(() => void tick(), ms ?? (fastRef.current ? 2_000 : 5_000));
    }

    async function tick() {
      if (stopped) return;
      if (document.visibilityState !== 'visible') {
        schedule();
        return;
      }
      if (Date.now() - lastRefreshAt.current > 120_000) {
        lastRefreshAt.current = Date.now();
        router.refresh();
        schedule();
        return;
      }
      const controller = new AbortController();
      inFlight = controller;
      const deadline = setTimeout(() => controller.abort(), 4_000);
      try {
        const res = await fetch(`/api/chat/pulse?${query}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (res.ok) {
          authFailures = 0;
          const data = (await res.json()) as { t?: unknown; fast?: unknown };
          fastRef.current = data.fast === true;
          if (typeof data.t === 'string' && data.t !== last.current) {
            last.current = data.t;
            lastRefreshAt.current = Date.now();
            router.refresh();
          }
        } else if (res.status === 401 || res.status === 403 || res.status === 404) {
          authFailures += 1;
          if (authFailures >= 3) {
            stopped = true;
            router.refresh();
            return;
          }
        }
        // Other statuses (a deploy's 500) keep the loop without counting.
      } catch {
        // Network blip or the abort deadline — keep looping.
      } finally {
        clearTimeout(deadline);
        inFlight = null;
      }
      schedule();
    }

    schedule();
    // Coming back to the tab asks straight away — the blind loop's one
    // virtue was catching up within a tick of a return.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !stopped) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      inFlight?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
    // Key on the STRING (round 45's lesson: never an object identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return null;
}
