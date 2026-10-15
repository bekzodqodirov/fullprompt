'use client';

import { useEffect } from 'react';
import type { ThreadReadMark, ThreadRef } from '@/modules/platform/notifications/thread-ref';

/** POST the read mark — one request, never awaited by anything on screen. */
export function markThreadsRead(refs: ThreadReadMark[]): void {
  if (refs.length === 0) return;
  void fetch('/api/threads/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refs }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * «I have this thread on screen» (0127) — a card's lenta or the calc page
 * marks its thread read for the person looking at it, UP TO what it drew:
 * each ref carries `asOf`, the newest message's moment as the server page
 * read it before rendering the list (`threadReadMarks`). A null `asOf` is a
 * thread with nothing on it — no mark.
 *
 * From an EFFECT, never during render and never in a server page: App Router
 * prefetches a link on hover, and a mark written while rendering would read a
 * thread the person never opened (round 88's #649). The effect is keyed on
 * the refs AND their `asOf`, so a `router.refresh()` that brings in a new
 * message (the calc page's pulse, a chat pulse) re-marks what it now shows —
 * a refresh re-renders this component with new props, it does not remount
 * it. The route asks each thread's door and re-derives whose mark moves; this
 * posts ids and instants and nothing else.
 */
/**
 * The effect's key — the refs AND their instants, without the empty ones.
 * Exported for the test: a key that dropped the instant would mark once and
 * never again while a refresh brought new messages in.
 */
export function readMarkKey(refs: readonly (ThreadRef & { asOf: string | null })[]): string {
  return refs
    .filter((ref) => ref.asOf)
    .map((ref) => `${ref.kind}|${ref.id}|${ref.asOf}`)
    .join(',');
}

export function ThreadSeen({ refs }: { refs: (ThreadRef & { asOf: string | null })[] }) {
  const key = readMarkKey(refs);
  useEffect(() => {
    if (!key) return;
    markThreadsRead(
      key.split(',').map((part) => {
        const [kind, id, asOf] = part.split('|');
        return { kind: kind as ThreadRef['kind'], id: id!, asOf: asOf! };
      }),
    );
  }, [key]);
  return null;
}
