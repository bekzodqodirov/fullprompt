import { TickLabel, XLabels } from './axis';
import { compactUsd } from './format';
import { tipAria } from './tip-text';

/**
 * Weekly cash as MIRRORED columns: money in grows UP from a middle axis, money
 * out grows DOWN from it, both on ONE scale (`top` is the larger of the two
 * sides' maxima), so the week that spent more than it took reads as a longer
 * lower bar with no arithmetic.
 *
 * Out is `viz-out`, the ORANGE, and never red: red on this page means urgency,
 * and the P&L's own charts already say «out» in orange (globals.css — orange
 * against red measured ΔE 7.1, too close to carry two meanings).
 *
 * The current week is not finished, so its two bars are OUTLINED rather than
 * filled (the hollow-ring rule of the sparkline, drawn as a column): a half
 * week filled solid would read as a bad week. For the same reason the one
 * direct net label belongs on the last COMPLETE week, which the caller names.
 *
 * HTML positioned by percentage, like `ColumnPairs`: nothing scales text, the
 * tick labels sit above their lines with no side gutter, and each week is a
 * full-height `<button data-tip>` so the target is the week, not a 3 px bar.
 */

// Literal maps: Tailwind compiles only classes it can see.
const BAR: Record<'in' | 'out', Record<'whole' | 'partial', string>> = {
  in: { whole: 'bg-viz-in', partial: 'border-2 border-viz-in bg-transparent' },
  out: { whole: 'bg-viz-out', partial: 'border-2 border-viz-out bg-transparent' },
};

export function MirrorColumns({
  bands,
  inflow,
  outflow,
  top,
  ticks,
  tips,
  labelled,
  netLabel,
  testid,
}: {
  bands: { key: string; label: string; partial?: boolean }[];
  inflow: number[];
  outflow: number[];
  /** One scale for both halves: niceTicks over every in AND out value. */
  top: number;
  ticks: number[];
  tips: string[];
  labelled: Set<number>;
  /** One direct label, on the last complete week. */
  netLabel?: { index: number; text: string };
  testid?: string;
}) {
  const n = bands.length;
  const scale = top > 0 ? top : 1;
  // Each half of the plot is 50 %; a negative amount (a correction) is drawn
  // at 0 — the tip and the table twin keep the real figure.
  const half = (value: number) => Math.min(50, (Math.max(0, value) / scale) * 50);
  const netAt = netLabel && netLabel.index >= 0 && netLabel.index < n ? netLabel : null;

  return (
    <div data-testid={testid} className="select-none pt-4">
      <div className="relative h-[180px] md:h-[220px]">
        {ticks
          .filter((tick) => tick > 0 && tick <= scale)
          .map((tick) => (
            <div key={tick}>
              <div className="absolute inset-x-0 border-t border-line" style={{ bottom: `${50 + half(tick)}%` }} />
              <div className="absolute inset-x-0 border-t border-line" style={{ bottom: `${50 - half(tick)}%` }} />
            </div>
          ))}
        <div className="absolute inset-x-0 bottom-1/2 border-t border-line-strong" data-axis="" />
        <div className="absolute inset-0 flex">
          {bands.map((band, i) => {
            const shape = band.partial ? 'partial' : 'whole';
            const up = half(inflow[i] ?? 0);
            const down = half(outflow[i] ?? 0);
            return (
              <div key={band.key} className="relative min-w-0 flex-1">
                {up > 0 && (
                  <div
                    data-in=""
                    className={`absolute bottom-1/2 left-1/2 w-3/5 max-w-4 -translate-x-1/2 rounded-t-[3px] ${BAR.in[shape]}`}
                    style={{ height: `${up}%` }}
                  />
                )}
                {down > 0 && (
                  <div
                    data-out=""
                    className={`absolute left-1/2 top-1/2 w-3/5 max-w-4 -translate-x-1/2 rounded-b-[3px] ${BAR.out[shape]}`}
                    style={{ height: `${down}%` }}
                  />
                )}
                <button
                  type="button"
                  data-tip={tips[i]}
                  aria-label={tipAria(tips[i])}
                  className="absolute inset-0 rounded hover:bg-ink-400/10 focus-visible:bg-ink-400/10"
                />
              </div>
            );
          })}
        </div>
        {ticks
          .filter((tick) => tick > 0 && tick <= scale)
          .map((tick) => (
            <div key={tick}>
              {/* Both halves print the AMOUNT, unsigned: which way the bar
                  grows already says in or out, and the legend names them. */}
              <TickLabel at={50 + half(tick)}>{compactUsd(tick)}</TickLabel>
              <TickLabel at={50 - half(tick)}>{compactUsd(tick)}</TickLabel>
            </div>
          ))}
        {netAt && (
          <span
            data-net-label=""
            className="pointer-events-none absolute whitespace-nowrap rounded-sm bg-surface-raised/85 px-0.5 font-mono text-2xs font-semibold leading-none tabular-nums text-ink-700"
            // In the plot's top padding over its week, anchored to the band's
            // OUTER edge on whichever side has more room, so it can never hang
            // outside the card (#400). Not at the bar's end: anchored there it
            // spreads over the neighbouring weeks, and a taller neighbour's bar
            // is exactly what it would cover.
            style={{
              ...(netAt.index >= n / 2
                ? { right: `${((n - netAt.index - 1) / n) * 100}%` }
                : { left: `${(netAt.index / n) * 100}%` }),
              bottom: 'calc(100% + 2px)',
            }}
          >
            {netAt.text}
          </span>
        )}
      </div>
      <XLabels bands={bands} labelled={labelled} />
    </div>
  );
}
