'use client';

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';

/**
 * The scaffold every overlay in this app was writing by hand.
 *
 * Three copies existed before this one — the dock, the search palette and the
 * ••• sheet — and they had drifted: Escape closed exactly one of them, none
 * restored the body's scroll, and each carried its own copy of the same
 * close-on-navigation effect. A fourth hand-written copy would have been the
 * third one without Escape.
 *
 * A PORTAL to the body, always: the app bar carries a `backdrop-blur`, which
 * makes the header a containing block for `fixed` descendants and once pinned
 * a "full screen" drawer inside a 56 px strip (dock.tsx's lesson).
 *
 * `onClose` is asked BEFORE closing and told WHY, so a caller holding
 * half-typed words can refuse a stray backdrop tap — and cannot accidentally
 * refuse a navigation, where the page underneath has already gone and a
 * confirm dialog would be a trap.
 */
export function Overlay({
  open,
  onClose,
  closeLabel,
  children,
  className = '',
  testId,
}: {
  open: boolean;
  /**
   * Return false to keep it open. `reason` says what happened: 'route' is a
   * navigation and must never be refused.
   */
  onClose: (reason: 'backdrop' | 'escape' | 'route') => boolean | void;
  /** Already translated: a client component cannot resolve a namespace. */
  closeLabel: string;
  children: ReactNode;
  /** Positioning of the panel itself; the scaffold owns only the backdrop. */
  className?: string;
  testId?: string;
}) {
  const pathname = usePathname();

  // The layout survives navigation, so an overlay left open stands over the
  // next page. The route changing IS the close signal — and it closes without
  // asking, because the page underneath has already gone.
  useEffect(() => {
    if (open) onClose('route');
    // Only the pathname: `onClose` is a new function on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose('escape');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      {/* A button, not a div: the way out has to be reachable from a keyboard. */}
      <button
        type="button"
        aria-label={closeLabel}
        className="absolute inset-0 bg-ink-900/40"
        onClick={() => onClose('backdrop')}
      />
      <div data-testid={testId} className={className}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
