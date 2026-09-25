import { compactUsd } from './format';
import { SERIES_BG } from './legend';

/**
 * Twelve months as grouped column PAIRS (in vs out) on ONE dollar axis, with a
 * net strip underneath on its own symmetric scale — the P&L's «billed vs
 * spent» and the cash flow's «in vs out» drawn the same way, so the two cards
 * read as one grammar and, sharing `top`, on one scale.
 *
 * Everything is HTML positioned by percentage: text is never inside a scaled
 * SVG, so the axis labels are the same 10 px at 360 px and at 1280 px (a
 * viewBox chart shrank its text to 45 % in the sidebar layout at 768 px).
 *
 * Marks follow the method: bars capped at 12 px with air around them, a 2 px
 * surface gap inside a pair, a rounded data end and a square base, hairline
 * solid gridlines with their tick ABOVE the line so no gutter steals width.
 * A negative month (a correction) is drawn at 0 — the tooltip and the table
 * twin keep the real value. Every month band is a focusable button carrying
 * the tooltip, full height, so the hit target is the month, not the 2 px bar.
 */
export interface ColumnPairsProps {
  months: { key: string; label: string; sub?: string }[];
  a: { values: number[] };
  b: { values: number[] };
  net: number[];
  /** Shared axis top (niceTicks over every value on the page's paired charts). */
  top: number;
  ticks: number[];
  /** Shared symmetric scale for the net strips. */
  netMax: number;
  tips: string[];
  /** Month indexes to label on the x-axis. */
  labelled: Set<number>;
  netLabel: string;
  testid?: string;
}

export function ColumnPairs({
  months,
  a,
  b,
  net,
  top,
  ticks,
  netMax,
  tips,
  labelled,
  netLabel,
  testid,
}: ColumnPairsProps) {
  const h = (value: number) => `${Math.max(0, Math.min(100, (Math.max(0, value) / top) * 100))}%`;
  const netH = (value: number) => `${netMax > 0 ? Math.min(50, (Math.abs(value) / netMax) * 50) : 0}%`;
  // Direct labels only where the story is: the current month, and the largest
  // |net| when it is not the current month's neighbour (never a number on
  // every bar — dataviz rule).
  const last = net.length - 1;
  let extreme = 0;
  net.forEach((value, i) => {
    if (Math.abs(value) > Math.abs(net[extreme] ?? 0)) extreme = i;
  });
  const netLabelled = new Set([last, ...(Math.abs(extreme - last) > 1 ? [extreme] : [])]);

  return (
    <div data-testid={testid} className="select-none">
      {/* The plot: 150 px, gridlines + ticks, then the bands. */}
      <div className="relative h-[150px]">
        {ticks.map((tick) => (
          <div
            key={tick}
            className="absolute inset-x-0 border-t border-line"
            style={{ bottom: `${(tick / top) * 100}%` }}
          >
            <span className="absolute -top-3.5 left-0 font-mono text-2xs tabular-nums text-ink-500">
              {compactUsd(tick)}
            </span>
          </div>
        ))}
        <div className="absolute inset-x-0 bottom-0 border-t border-line-strong" />
        <div className="absolute inset-0 flex">
          {months.map((month, i) => (
            <div key={month.key} className="relative flex min-w-0 flex-1 items-end justify-center gap-0.5">
              <div className={`w-full max-w-3 rounded-t-[3px] ${SERIES_BG.in}`} style={{ height: h(a.values[i] ?? 0) }} />
              <div className={`w-full max-w-3 rounded-t-[3px] ${SERIES_BG.out}`} style={{ height: h(b.values[i] ?? 0) }} />
              <button
                type="button"
                data-tip={tips[i]}
                aria-label={tips[i]?.replace(/\t/g, ' ').replace(/\n/g, ' · ')}
                className="absolute inset-0 rounded hover:bg-ink-400/10 focus-visible:bg-ink-400/10"
              />
            </div>
          ))}
        </div>
      </div>

      {/* The net strip: 48 px, zero in the middle, profit up, loss down. */}
      <p className="mt-2 text-2xs text-ink-500">{netLabel}</p>
      <div className="relative h-12">
        <div className="absolute inset-x-0 top-1/2 border-t border-line-strong" />
        <div className="absolute inset-0 flex">
          {months.map((month, i) => {
            const value = net[i] ?? 0;
            const up = value >= 0;
            return (
              <div key={month.key} className="relative flex min-w-0 flex-1 justify-center">
                <div
                  className={`absolute w-2.5 ${up ? `bottom-1/2 rounded-t-[3px] ${SERIES_BG.in}` : `top-1/2 rounded-b-[3px] ${SERIES_BG.out}`}`}
                  style={{ height: netH(value) }}
                />
                {netLabelled.has(i) && Math.abs(value) > 0.5 && (
                  <span
                    className={`pointer-events-none absolute whitespace-nowrap font-mono text-2xs tabular-nums ${
                      value < 0 ? 'text-bad' : 'text-ink-700'
                    } ${up ? 'top-0' : 'bottom-0'} ${i === last ? 'right-0' : ''}`}
                  >
                    {compactUsd(value)}
                  </span>
                )}
                <button
                  type="button"
                  tabIndex={-1}
                  data-tip={tips[i]}
                  aria-hidden
                  className="absolute inset-0"
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* The x-axis: every third month and the last, the partial month named. */}
      <div className="mt-1 flex">
        {months.map((month, i) => (
          <div key={month.key} className="relative min-w-0 flex-1 text-center text-2xs leading-tight text-ink-500">
            {labelled.has(i) && (
              <span className={`block whitespace-nowrap ${i === last ? 'text-right' : ''}`}>
                {month.label}
                {month.sub && <span className="block">{month.sub}</span>}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
