/**
 * The identity channel for two or more series. The swatch mirrors the mark
 * (a rect for bars); the words wear ink, never the series colour — a light
 * hue is illegible as text on the card (dataviz rule).
 */

// A literal map: Tailwind compiles only classes it can see (#footgun).
export const SERIES_BG = {
  in: 'bg-viz-in',
  out: 'bg-viz-out',
  ord1: 'bg-viz-ord1',
  ord2: 'bg-viz-ord2',
  ord3: 'bg-viz-ord3',
  ord4: 'bg-viz-ord4',
  muted: 'bg-ink-400',
  strong: 'bg-ink-700',
} as const;

export type SeriesKey = keyof typeof SERIES_BG;

export function Legend({ items }: { items: { key: SeriesKey; label: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-2xs text-ink-500">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span aria-hidden className={`h-2.5 w-2.5 rounded-sm ${SERIES_BG[item.key]}`} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
