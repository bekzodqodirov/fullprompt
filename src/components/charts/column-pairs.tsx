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
  // The strip's bars reach 30 % of its height each way, which leaves the rest
  // of the half for a label AT the bar's end — a label on top of its own bar
  // was unreadable (the round's screenshot).
  const netPct = (value: number) => (netMax > 0 ? Math.min(30, (Math.abs(value) / netMax) * 30) : 0);
  const netH = (value: number) => `${netPct(value)}%`;
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
      {/* The plot: 150 px, gridlines, then the bands, then the tick labels ON
          TOP of the bars (drawn under them, a tall month hid «$50K» — seen in
          the round's own screenshot). The top padding is the top label's room. */}
      <div className="relative mt-4 h-[150px]">
        {ticks.map((tick) => (
          <div
            key={tick}
            className="absolute inset-x-0 border-t border-line"
            style={{ bottom: `${(tick / top) * 100}%` }}
          />
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
        {ticks.map((tick) => (
          <span
            key={tick}
            className="pointer-events-none absolute left-0 rounded-sm bg-surface-raised/85 pr-1 font-mono text-2xs leading-none tabular-nums text-ink-500"
            style={{ bottom: `calc(${(tick / top) * 100}% + 2px)` }}
          >
            {compactUsd(tick)}
          </span>
        ))}
      </div>

      {/* The net strip: 64 px, zero in the middle, profit up, loss down. */}
      <p className="mt-2 text-2xs text-ink-500">{netLabel}</p>
      <div className="relative h-16">
        <div className="absolute inset-x-0 top-1/2 border-t border-line-strong" />
        <div className="absolute inset-0 flex">
          {months.map((month, i) => {
            const value = net[i] ?? 0;
            const up = value >= 0;
            const end = `calc(50% + ${netPct(value)}% + 1px)`;
            return (
              <div key={month.key} className="relative flex min-w-0 flex-1 justify-center">
                <div
                  className={`absolute w-2.5 ${up ? `bottom-1/2 rounded-t-[3px] ${SERIES_BG.in}` : `top-1/2 rounded-b-[3px] ${SERIES_BG.out}`}`}
                  style={{ height: netH(value) }}
                />
                {netLabelled.has(i) && Math.abs(value) > 0.5 && (
                  <span
                    className={`pointer-events-none absolute whitespace-nowrap font-mono text-2xs leading-none tabular-nums ${
                      value < 0 ? 'text-bad' : 'text-ink-700'
                    } ${i === last ? 'right-0' : ''}`}
                    style={up ? { bottom: end } : { top: end }}
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
