'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { markThreadsRead } from './thread-seen';

/**
 * One calculation's «❓ Savol-javob» fold on the lead or deal card (§3.5 b).
 *
 * UNCONTROLLED open state, seeded once: a controlled `open={unread}` would
 * flip shut the moment the seller's own answer became the newest note — the
 * revalidation after his send would close the fold under the writer's hand
 * (the judge's 13). It starts open for an open job or an unanswered question;
 * a link that names it (`#calc-thread-<id>`) is opened by `ThreadHashOpen`,
 * whose DOM toggle this state follows (`onToggle`) — reading the hash here
 * would draw the server's closed fold and the client's open one, a hydration
 * mismatch.
 *
 * It marks the thread read only while it is OPEN — on mount when it starts
 * open, and on every toggle to open; a closed fold has not been read — and
 * only UP TO `asOf`, the newest message the card's list read before drawing
 * these children: a fold toggled open minutes after the render shows the
 * render's messages, and a note that landed since is not among them. A
 * refresh that brings a newer `asOf` re-marks an open fold.
 */
export function ThreadFold({
  requestId,
  initialOpen,
  asOf,
  summary,
  children,
}: {
  requestId: string;
  initialOpen: boolean;
  asOf: string | null;
  summary: ReactNode;
  children: ReactNode;
}) {
  const id = `calc-thread-${requestId}`;
  const [open, setOpen] = useState(initialOpen);

  useEffect(() => {
    if (open && asOf) markThreadsRead([{ kind: 'calc', id: requestId, asOf }]);
  }, [open, requestId, asOf]);

  return (
    <details
      id={id}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="scroll-mt-20 rounded-xl border border-line"
      data-testid="calc-thread-fold"
    >
      <summary className="cursor-pointer p-2 text-sm font-semibold">{summary}</summary>
      <div className="border-t border-line p-2">{children}</div>
    </details>
  );
}
