'use client';

import { useEffect, useRef } from 'react';

/**
 * Tell the server this conversation is being looked at (round 88).
 *
 * A POST from an effect rather than a write inside the server page: the page
 * is prefetched by every hover on the list, and a prefetch that marked chats
 * read would clear the warning for conversations nobody opened. An effect
 * runs only when the screen is really mounted in front of somebody.
 *
 * It fires on mount AND whenever the newest incoming message on screen
 * changes (`newest`). Once per mount was not enough: the chat pulse redraws
 * the thread in place when the client writes again, the manager watches the
 * message arrive — and nothing re-marked it, so it rang thirty minutes later
 * about a message that was read the second it landed (the lead chats round's
 * design judge, seventh finding). Its answer is not read — the mark it moves
 * is shown on the NEXT render (the list, the badge, the home count), never on
 * this screen. `keepalive` so closing the tab straight after opening still
 * counts as having read it.
 */
export function ChatMarkRead({ clientId, newest }: { clientId: string; newest?: string | null }) {
  useEffect(() => {
    void fetch('/api/chat/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId }),
      keepalive: true,
    }).catch(() => {});
  }, [clientId, newest]);
  return null;
}

/**
 * The LEAD thread's read mark — fired when the newest end of the chat is
 * actually ON SCREEN, not when the card mounts (the lead chats round).
 *
 * On a phone `CardCols` puts the rail first and the chat far below it:
 * opening a lead card to move its stage or read its phone number must not
 * silence an unread question the manager never scrolled to. Arriving by the
 * list row's `#tg-thread` anchor scrolls the chat into view, which marks it.
 *
 * It sits as the FIRST child of the `flex-col-reverse` scroll box — the
 * newest end — so it is visible exactly when the latest message is.
 * Re-armed per newest incoming message (`newest`), for the same reason as
 * `ChatMarkRead`: a message drawn by the pulse while the chat is in view has
 * been seen. Still an effect, so a prefetch never marks (#650).
 */
export function LeadChatReadSentinel({ leadId, newest }: { leadId: string; newest: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void fetch('/api/chat/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leadId }),
        keepalive: true,
      }).catch(() => {});
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [leadId, newest]);
  return (
    <div ref={ref} aria-hidden className="h-px w-full shrink-0" data-testid="lead-chat-read" />
  );
}
