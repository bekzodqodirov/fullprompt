'use client';

import { useEffect } from 'react';

/**
 * Tell the server this conversation is being looked at (round 88).
 *
 * A POST from an effect rather than a write inside the server page: the page
 * is prefetched by every hover on the list, and a prefetch that marked chats
 * read would clear the warning for conversations nobody opened. An effect
 * runs only when the screen is really mounted in front of somebody.
 *
 * It fires once per mount and its answer is not read — the mark it moves is
 * shown on the NEXT render (the list, the badge, the home count), never on
 * this screen, so there is nothing here to update and nothing to fail
 * visibly. `keepalive` so closing the tab straight after opening still
 * counts as having read it.
 */
export function ChatMarkRead({ clientId }: { clientId: string }) {
  useEffect(() => {
    void fetch('/api/chat/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId }),
      keepalive: true,
    }).catch(() => {});
  }, [clientId]);
  return null;
}
