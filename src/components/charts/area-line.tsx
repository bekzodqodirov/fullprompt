import { TickLabel, XLabels } from './axis';
import { compactUsd } from './format';
import { tipAria } from './tip-text';

/**
 * The hero's twelve months of net profit as ONE line on a SIGNED axis — a loss
 * month goes below zero instead of being drawn at it, which is what a profit
 * line exists to show (the column charts clamp a negative month to 0 and keep
 * the real figure in the tip; a line cannot hide a dip that way).
 *
 * Three honesty rules shape it:
 *
 *  - the area wash is drawn ONLY ABOVE ZERO. The same blue tint below the
 *    zero line reads as positive mass — a loss would look like a second hump
 *    of profit (judge O20). The polygon is cut at the zero crossing by
 *    arithmetic, not by a clip-path, so no id has to be unique on the page.
 *  - the current month is not finished, so the last segment is DASHED and the
 *    last point a HOLLOW ring — the sparkline's rule, one size up. Never a
 *    pro-rated guess, never a faded mark under 3:1.
 *  - text is never inside the scaled SVG: tick labels sit above their lines,
 *    the end label is right-anchored to the plot (it cannot overflow the card
 *    whatever its length, #400), the x-axis anchors its two ends.
 *
 * Hover is the house pattern: one full-height `<button data-tip>` per month,
 * so the target is the month and not the 2 px line, reachable by keyboard,
 * read by `ChartTip`. Every value is also in the caller's table twin.
 */
export interface AreaLinePoint {
  key: string;
  label: string;
  value: number;
}

// Literal maps: Tailwind compiles only classes it can see.
const END_MARK: Record<'partial' | 'whole', string> = {
  partial: 'border-2 border-viz-in bg-surface-raised',
  whole: 'bg-viz-in',
};

export function AreaLine({
  points,
  bottom,
  top,
  ticks,
  partialLast,
  tips,
  labelled,
  endLabel,
  ariaLabel,
  testid,
  height = 'h-[150px]',
}: {
  points: AreaLinePoint[];
  /** The axis floor and ceiling, from the caller's signed ticks (≤ 0 ≤ top). */
  bottom: number;
  top: number;
  ticks: number[];
  /** The last point is a month still running: dashed segment, hollow ring. */
  partialLast: boolean;
  tips: string[];
  /** Point indexes to label on the x-axis. */
  labelled: Set<number>;
  /** The latest value as a person reads it, drawn beside the last point. */
  endLabel: string;
  ariaLabel: string;
  testid?: string;
  height?: 'h-[120px]' | 'h-[150px]';
}) {
  const n = points.length;
  const span = top - bottom || 1;
  const clamp = (value: number) => Math.min(top, Math.max(bottom, value));
  /** Percent above the plot's floor — how HTML is placed. */
  const fromBottom = (value: number) => ((clamp(value) - bottom) / span) * 100;
  /** The viewBox's y, which grows DOWN. */
  const y = (value: number) => 100 - fromBottom(value);
  const x = (i: number) => ((i + 0.5) / n) * 100;
  // Where zero is; an axis that does not contain it (a caller's mistake) puts
  // the wash's floor on the nearer edge rather than outside the plot.
  const zeroY = y(0);
  const values = points.map((point) => point.value);
  const last = values[n - 1];

  const coords = (from: number, to: number) =>
    values
      .slice(from, to)
      .map((value, i) => `${x(from + i).toFixed(2)},${y(value).toFixed(2)}`)
      .join(' ');
  const dashed = partialLast && n >= 2;
  const solid = n >= 2 ? coords(0, dashed ? n - 1 : n) : '';
  const tail = dashed ? coords(n - 2, n) : '';
  const area = areaAboveZero(values, x, y, zeroY);

  const lastY = last === undefined ? 0 : y(last);
  // The end label goes BELOW a point near the top, ABOVE otherwise, so it
  // never climbs out of the plot's own top padding.
  const endStyle = lastY < 35 ? { top: `calc(${lastY}% + 8px)` } : { bottom: `calc(${100 - lastY}% + 8px)` };

  return (
    <div data-testid={testid} className="select-none pt-4">
      <div className={`relative ${height}`}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
          role="img"
          aria-label={ariaLabel}
        >
          {ticks
            .filter((tick) => tick !== 0)
            .map((tick) => (
              <line
                key={tick}
                x1="0"
                x2="100"
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-line"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          {area && <path d={area} className="fill-viz-in/10" data-area="" />}
          <line
            x1="0"
            x2="100"
            y1={zeroY}
            y2={zeroY}
            className="stroke-line-strong"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            data-zero=""
          />
          {solid && (
            <polyline
              points={solid}
              fill="none"
              className="stroke-viz-in"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {tail && (
            <polyline
              points={tail}
              fill="none"
              className="stroke-viz-in"
              strokeWidth="2"
              strokeDasharray="4 3"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              data-partial=""
            />
          )}
        </svg>
        {last !== undefined && (
          <span
            aria-hidden
            className={`absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${END_MARK[partialLast ? 'partial' : 'whole']}`}
            style={{ left: `${x(n - 1)}%`, top: `${lastY}%` }}
          />
        )}
        <div className="absolute inset-0 flex">
          {points.map((point, i) => (
            <button
              key={point.key}
              type="button"
              data-tip={tips[i]}
              aria-label={tipAria(tips[i])}
              className="h-full min-w-0 flex-1 rounded hover:bg-ink-400/10 focus-visible:bg-ink-400/10"
            />
          ))}
        </div>
        {ticks.map((tick) => (
          <TickLabel key={tick} at={fromBottom(tick)}>
            {compactUsd(tick)}
          </TickLabel>
        ))}
        {last !== undefined && endLabel && (
          <span
            data-end-label=""
            className="pointer-events-none absolute right-0 whitespace-nowrap rounded-sm bg-surface-raised/85 px-0.5 font-mono text-xs font-semibold leading-none tabular-nums text-ink-900"
            style={endStyle}
          >
            {endLabel}
          </span>
        )}
      </div>
      <XLabels bands={points} labelled={labelled} />
    </div>
  );
}

/**
 * The wash's outline: the line where it is above zero, the zero line where it
 * is not, with a vertex at every crossing so the cut is exact rather than
 * stepped at the nearest month. `null` when no month is above zero — an
 * all-loss year has a line and no wash. SVG coordinates, two decimals.
 */
function areaAboveZero(
  values: number[],
  x: (i: number) => number,
  y: (value: number) => number,
  zeroY: number,
): string | null {
  if (values.length < 2 || !values.some((value) => value > 0)) return null;
  const vertices: [number, number][] = [[x(0), zeroY]];
  values.forEach((value, i) => {
    vertices.push([x(i), value > 0 ? y(value) : zeroY]);
    const next = values[i + 1];
    if (next !== undefined && ((value > 0 && next < 0) || (value < 0 && next > 0))) {
      const t = value / (value - next);
      vertices.push([x(i) + t * (x(i + 1) - x(i)), zeroY]);
    }
  });
  vertices.push([x(values.length - 1), zeroY]);
  return `M${vertices.map(([vx, vy]) => `${vx.toFixed(2)},${vy.toFixed(2)}`).join('L')}Z`;
}
