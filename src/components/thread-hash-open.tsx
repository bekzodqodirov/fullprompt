'use client';

import { useEffect } from 'react';

/**
 * Land a `#calc-thread-<id>` link OPEN (§3.5 b): the fold sits inside the
 * CalcPanel, itself a `<details>`, and a browser scrolls to an element inside
 * a closed `<details>` without opening it — the dock row, the ping's link and
 * the lenta's chip would all arrive at a closed panel with nothing in view.
 *
 * On mount and on every `hashchange`: every `<details>` ancestor of the named
 * element is opened, then it is scrolled into view.
 */
export function ThreadHashOpen() {
  useEffect(() => {
    const reveal = () => {
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      const target = document.getElementById(decodeURIComponent(hash));
      if (!target) return;
      for (let el: HTMLElement | null = target; el; el = el.parentElement) {
        if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
      }
      target.scrollIntoView({ block: 'start' });
    };
    reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, []);
  return null;
}
