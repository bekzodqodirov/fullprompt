'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The road strip's scroller. On a phone the strip is wider than the screen,
 * and a stop tapped at its right end reloaded the page with the strip back
 * at its left edge — the stop that is now filtering the board was off the
 * screen (seen in the round's own 360 px screenshot). The active stop is
 * brought into view on every change of it; nothing else moves.
 */
export function StripScroll({
  active,
  label,
  children,
}: {
  active: string | null;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [active]);
  return (
    <nav ref={ref} aria-label={label} data-testid="board-strip" className="no-scrollbar -mx-4 overflow-x-auto px-4">
      {children}
    </nav>
  );
}
