'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The calc page's Q&A pulse (0127) — ChatPulse's rules (chat-pulse.tsx),
 * minus its fast beat: a seller's Telegram reply appears on the VED's open
 * page within a tick, and the page is re-rendered ONLY when the thread's
 * token moves.
 *
 *   - the baseline is server-rendered (`initial`), from the render that drew
 *     the list — a client-invented one swallows what landed in between;
 *   - ticks chain via setTimeout with an abort deadline, every 20 s while the
 *     tab is visible — a slow server never stacks requests;
 *   - `{ token: null }` (the database is a release behind) or three
 *     consecutive 401/403 stop the loop.
 */
export function ThreadPulse({ kind, id, initial }: { kind: 'calc'; id: string; initial: string }) {
  const router = useRouter();
  const last = useRef(initial);

  useEffect(() => {
    last.current = initial;
  }, [initial]);

  useEffect(() => {
    let stopped = false;
    let authFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | null = null;
    const query = `kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`;

    const schedule = () => {
      if (!stopped) timer = setTimeout(() => void tick(), 20_000);
    };

    async function tick() {
      if (stopped) return;
      if (document.visibilityState !== 'visible') {
        schedule();
        return;
      }
      const controller = new AbortController();
      inFlight = controller;
      const deadline = setTimeout(() => controller.abort(), 6_000);
      try {
        const res = await fetch(`/api/threads/pulse?${query}`, { signal: controller.signal, cache: 'no-store' });
        if (res.ok) {
          authFailures = 0;
          const data = (await res.json()) as { token?: unknown };
          if (data.token === null) {
            stopped = true;
            return;
          }
          if (typeof data.token === 'string' && data.token !== last.current) {
            last.current = data.token;
            router.refresh();
          }
        } else if (res.status === 401 || res.status === 403) {
          authFailures += 1;
          if (authFailures >= 3) {
            stopped = true;
            return;
          }
        }
      } catch {
        // A blip or the deadline — keep looping.
      } finally {
        clearTimeout(deadline);
        inFlight = null;
      }
      schedule();
    }

    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      inFlight?.abort();
    };
  }, [kind, id, router]);

  return null;
}
