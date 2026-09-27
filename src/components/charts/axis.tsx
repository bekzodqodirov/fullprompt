import type { ReactNode } from 'react';

/**
 * The two pieces of axis every new dashboard chart shares — the tick label and
 * the x-axis row — kept in one place so the three charts cannot drift apart in
 * how they print a scale (#513, at the size of a label).
 *
 * Both are HTML over the plot, never `<text>` inside a scaled SVG: a viewBox
 * chart shrank its text to 45 % in the sidebar layout at 768 px, and HTML
 * stays 11 px at every width.
 */

/**
 * A tick's value, printed just ABOVE its gridline at the plot's left edge,
 * with a translucent surface behind it so a tall bar or the line crossing it
 * cannot swallow the number. `at` is the line's height in percent of the plot.
 * Above the line rather than beside it: a side gutter would take ~40 px from
 * a 328 px phone chart for four numbers.
 */
export function TickLabel({ at, children }: { at: number; children: ReactNode }) {
  return (
    <span
      className="pointer-events-none absolute left-0 rounded-sm bg-surface-raised/85 pr-1 font-mono text-2xs leading-none tabular-nums text-ink-500"
      style={{ bottom: `calc(${at}% + 2px)` }}
    >
      {children}
    </span>
  );
}

// A literal map: Tailwind compiles only classes it can see.
const ANCHOR: Record<'start' | 'mid' | 'end', string> = {
  start: 'left-0',
  mid: '-translate-x-1/2',
  end: 'right-0',
};

/**
 * The x-axis of a banded chart. A label sits under the centre of its band —
 * except the first, which STARTS at the plot's left edge, and the last, which
 * ENDS at its right edge. Centred, an edge label hangs half its width outside
 * the card, and a nowrap overhang is exactly what makes a phone rescale the
 * whole page (#400). Which bands are labelled is the caller's choice; the
 * values themselves are in every band's tip and in the table twin, so the row
 * is hidden from a screen reader rather than read twice.
 */
export function XLabels({ bands, labelled }: { bands: { key: string; label: string }[]; labelled: Set<number> }) {
  const n = bands.length;
  return (
    <div className="relative mt-1 h-4" aria-hidden>
      {bands.map((band, i) => {
        if (!labelled.has(i)) return null;
        const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'mid';
        return (
          <span
            key={band.key}
            data-x-anchor={anchor}
            className={`absolute top-0 whitespace-nowrap text-2xs leading-none text-ink-500 ${ANCHOR[anchor]}`}
            style={anchor === 'mid' ? { left: `${((i + 0.5) / n) * 100}%` } : undefined}
          >
            {band.label}
          </span>
        );
      })}
    </div>
  );
}
