'use client';

import { useSyncExternalStore, type KeyboardEvent } from 'react';

/**
 * One keyboard contract for every box that talks to a customer.
 *
 * The dock sent on Enter and the thread composer did not — the same person,
 * two behaviors. And on a phone there IS no Shift+Enter, so Enter-send made a
 * multi-line message impossible and fired half-typed sends. The rule is
 * Telegram's own: a physical keyboard sends on Enter (Shift+Enter breaks the
 * line), a finger gets a newline and only the button sends.
 */

/**
 * Is the PRIMARY pointer a finger? The server cannot know, so the server
 * snapshot says false — the desktop rule for one frame nobody can type in —
 * and the store answers truthfully from the first client render on.
 */
const COARSE_QUERY = '(pointer: coarse)';

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(COARSE_QUERY);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(COARSE_QUERY).matches,
    () => false,
  );
}

/**
 * NOTE for e2e: the mobile Playwright project emulates touch, so a spec must
 * press the SEND BUTTON — a keyboard Enter deliberately does not send there.
 */
export function sendOnEnter(
  event: KeyboardEvent<HTMLTextAreaElement>,
  coarse: boolean,
  send: () => void,
): void {
  if (coarse) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

/**
 * The box follows the text up to its CSS max-height, then scrolls inside —
 * a corner resize handle does not exist on touch, so growth replaces it.
 */
export function autogrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}
