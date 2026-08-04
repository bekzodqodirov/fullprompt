'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-render a server page on a timer, while its tab is actually looked at.
 *
 * Born on the conversation screen (owner, round 25): a reply sat marked
 * «navbatda» after Telegram had long delivered it, because the queue empties
 * on the SERVER and nothing told the page. `router.refresh()` re-renders the
 * server components and — the reason it is safe on a screen with a composer —
 * keeps client component state, so nothing a person is typing is lost.
 * Hidden tabs skip the tick: thirty idle chats polling would be pure load.
 */
export function AutoRefresh({ ms = 10_000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, ms);
    return () => clearInterval(tick);
  }, [router, ms]);
  return null;
}
