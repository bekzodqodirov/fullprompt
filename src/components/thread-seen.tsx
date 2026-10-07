'use client';

import { useEffect } from 'react';
import type { ThreadRef } from '@/modules/platform/notifications/thread-ref';

/** POST the read mark — one request, never awaited by anything on screen. */
export function markThreadsRead(refs: ThreadRef[]): void {
  void fetch('/api/threads/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refs }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * «I have this thread on screen» (0127) — a card's lenta or the calc page
 * marks its thread read for the person looking at it.
 *
 * From an EFFECT, once per distinct set of refs, never during render and
 * never in a server page: App Router prefetches a link on hover, and a mark
 * written while rendering would read a thread the person never opened
 * (round 88's #649). The route asks each thread's door and re-derives whose
 * mark moves; this posts ids and nothing else.
 */
export function ThreadSeen({ refs }: { refs: ThreadRef[] }) {
  const key = refs.map((ref) => `${ref.kind}:${ref.id}`).join(',');
  useEffect(() => {
    if (!key) return;
    markThreadsRead(
      key.split(',').map((part) => {
        const [kind, id] = part.split(':');
        return { kind: kind as ThreadRef['kind'], id: id! };
      }),
    );
  }, [key]);
  return null;
}
