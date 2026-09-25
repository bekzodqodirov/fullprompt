/**
 * A 12-point trend under a stat tile. Decoration for a figure the tile already
 * prints, so it carries no values of its own and no hover: a tile is a Link,
 * and a tooltip inside a link is unreachable on a phone (dataviz rule).
 *
 * The history is recessive ink; the LAST point is a hollow ring in the series
 * colour — hollow because the current month is not finished, which is the
 * honest way to draw a month-to-date end point without a pro-rated guess or a
 * faded mark that falls under 3:1 contrast. The ring is an HTML element placed
 * over the SVG, so it stays round whatever the tile's width.
 */
export function Sparkline({ values, zeroLine = false }: { values: number[]; zeroLine?: boolean }) {
  if (values.length < 2) return <div className="h-6" aria-hidden />;
  const min = Math.min(...values, zeroLine ? 0 : Number.POSITIVE_INFINITY);
  const max = Math.max(...values, zeroLine ? 0 : Number.NEGATIVE_INFINITY);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * 100;
  const y = (v: number) => 100 - ((v - min) / span) * 100;
  const points = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const last = values[values.length - 1]!;
  return (
    <div className="relative h-6" aria-hidden>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        {zeroLine && min < 0 && max > 0 && (
          <line x1="0" x2="100" y1={y(0)} y2={y(0)} className="stroke-line-strong" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        )}
        <polyline
          points={points}
          fill="none"
          className="stroke-ink-400"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-viz-in bg-surface-raised"
        style={{ left: '100%', top: `${y(last)}%` }}
      />
    </div>
  );
}
