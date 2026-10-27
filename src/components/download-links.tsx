'use client';

import { useEffect } from 'react';
import { signedDownloadUrl } from './download-url';

/**
 * Every file link on every screen goes through a download link
 * (`platform/auth/download-link.ts`) — ONE listener, not a component per link.
 *
 * Opened from a Telegram «↗️ Ochish» button, the system runs in Telegram's
 * in-app browser, which hands a file's address to the phone's download
 * manager; the manager fetches it with no login cookie and the phone says
 * «Download unsuccessful» (the owner, 2026-10-27, «1d … 3 c»). So a press on
 * an `/api/…` link first asks the server for a short-lived signed address and
 * follows THAT — which works with or without the cookie, in Chrome, in a
 * webview, in the download manager.
 *
 * Delegation, in the capture phase, for the reason the chat bubble's buttons
 * use it (round 95): the links live in server components by the hundred, and
 * a client wrapper per link would be a hydration root per file. Anything the
 * browser should handle itself is left alone — a modified click, another
 * origin, a link already pointing at a download link, or a press this
 * listener itself made (`data-dl-done`). When the server cannot mint a link
 * (no key, offline, signed out) the plain address is followed, which is what
 * every press did before this existed.
 */
export function DownloadLinks() {
  useEffect(() => {
    function fileAnchor(event: MouseEvent): HTMLAnchorElement | null {
      if (event.defaultPrevented || event.button !== 0) return null;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('data-dl-done')) return null;
      if (!anchor.getAttribute('href')) return null;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return null;
      if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/dl')) return null;
      // A new-tab link under a MOUSE is a desktop browser's, where the cookie
      // travels and the new tab is the point (a PDF beside the screen). Taken
      // over, it would open a blank tab first and point it at the link — a
      // tab some browsers leave standing when the answer is a download. The
      // download manager's problem is a phone's.
      if (anchor.target === '_blank' && window.matchMedia?.('(pointer: fine)').matches) return null;
      return anchor;
    }

    function follow(target: string, anchor: HTMLAnchorElement) {
      // A one-off anchor carries the original's `download` name; marked, so
      // this listener lets its own click through.
      const link = document.createElement('a');
      link.href = target;
      link.setAttribute('data-dl-done', '');
      if (anchor.hasAttribute('download')) link.setAttribute('download', anchor.getAttribute('download') ?? '');
      link.rel = 'noreferrer';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
    }

    function onClick(event: MouseEvent) {
      const anchor = fileAnchor(event);
      if (!anchor) return;
      event.preventDefault();
      const url = new URL(anchor.href, window.location.href);
      // A new tab must be opened INSIDE the press, or a browser's popup rule
      // refuses it once the fetch has taken its time; it is pointed at the
      // link when the link arrives. A webview that opens no window gets the
      // same address in place.
      const tab = anchor.target === '_blank' ? window.open('about:blank', '_blank') : null;
      if (tab) tab.opener = null;
      void signedDownloadUrl(`${url.pathname}${url.search}`).then((target) => {
        if (tab && !tab.closed) tab.location.href = target;
        else follow(target, anchor);
      });
    }

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  return null;
}
