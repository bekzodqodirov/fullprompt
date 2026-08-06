'use client';

import { useCallback, type ReactNode } from 'react';

/**
 * A row whose `<details>` popovers close each other (round 72).
 *
 * The board toolbar carries three native folds anchored to the same right
 * corner — filter, views, ⋯ — and native details do not coordinate: two open
 * at once stack into one unreadable pile. One capture-phase toggle listener
 * on the row closes the siblings of whichever just opened; the folds stay
 * server-rendered `<details>`, so everything still works without JavaScript
 * (they simply stop closing each other).
 *
 * Wired through a ref, not a React prop: React's DOM typings carry no
 * `onToggle` for a div, and `toggle` does not bubble — it must be caught in
 * the CAPTURE phase to be seen at the row at all.
 */
export function PopoverRow({ className, children }: { className: string; children: ReactNode }) {
  const attach = useCallback((row: HTMLDivElement | null) => {
    if (!row) return;
    row.addEventListener(
      'toggle',
      (event) => {
        const opened = event.target;
        if (!(opened instanceof HTMLDetailsElement) || !opened.open) return;
        for (const details of row.querySelectorAll('details')) {
          // Only sibling top-level folds — a fold nested INSIDE an open panel
          // (the ⋯ menu's card-fields) must not close its parent.
          if (details !== opened && !details.contains(opened) && !opened.contains(details)) {
            details.open = false;
          }
        }
      },
      true,
    );
  }, []);

  return (
    <div ref={attach} className={className}>
      {children}
    </div>
  );
}
