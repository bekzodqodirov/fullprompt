import type { ReactNode } from 'react';

/**
 * The board toolbar's ⋯ — everything a salesperson does NOT press twenty
 * times a day (round 72): the door to the other board, the funnel settings,
 * the card-lines chooser. One button, so the toolbar stays four controls
 * wide at 360 px and the board keeps the screen.
 *
 * A native `<details>` anchored to the toolbar ROW (#471), like every other
 * fold on the row. The panel is positioned, so closed it costs the board no
 * height (#515).
 */
export function BoardMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details data-testid="board-menu-fold">
      <summary
        className="btn-secondary btn-icon cursor-pointer list-none marker:content-none"
        aria-label={label}
        data-testid="board-menu"
      >
        ⋯
      </summary>
      <div className="absolute right-0 top-full z-40 mt-1 w-64 max-w-[calc(100vw-1.5rem)] space-y-1 rounded-2xl border border-line bg-surface-raised p-2 shadow-lg">
        {children}
      </div>
    </details>
  );
}

/** One row of the ⋯ menu — a Link or button styled as a menu item. */
export const boardMenuItem =
  'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-semibold hover:bg-surface-sunken';
