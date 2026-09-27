import { TickLabel, XLabels } from './axis';
import { num } from './format';
import { tipAria } from './tip-text';

/**
 * Thirty days of intake, one column per day, in m³.
 *
 * Colour is the ordinal ramp, and deliberately NOT its first step: `ord1`
 * measures 2.11:1 against the card in light mode and 2.13:1 in dark — under
 * the 3:1 a mark that stands alone needs — so the past days are `ord2` and
 * today, which is still filling up, the darkest step `ord4`. Today is also the
 * one direct label, worded by the caller as «so far», because a morning's
 * half-day next to twenty-nine whole ones is the bar a reader must not misread.
 *
 * A zero day draws no bar at all (a 2 px stub reads as «a little»), but keeps
 * its full-height `<button data-tip>`, so «nothing came in on the 14th» is
 * still something the chart says when asked. The x-axis anchors its first and
 * last labels to the plot's edges so a nowrap date never hangs off a phone.
 */

// Literal map: Tailwind compiles only classes it can see.
const DAY_BAR: Record<'past' | 'today', string> = {
  past: 'bg-viz-ord2',
  today: 'bg-viz-ord4',
};

export function DayColumns({
  days,
  values,
  todayIndex,
  top,
  ticks,
  tips,
  labelled,
  todayLabel,
  testid,
}: {
  days: { key: string; label: string }[];
  values: number[];
  /** The running day, drawn darker and labelled; null when the window has none. */
  todayIndex: number | null;
  top: number;
  ticks: number[];
  tips: string[];
  labelled: Set<number>;
  /** «Bugun (hozircha) 12.4», drawn at today's column. */
  todayLabel?: string;
  testid?: string;
}) {
  const n = days.length;
  const scale = top > 0 ? top : 1;
  const h = (value: number) => Math.min(100, (Math.max(0, value) / scale) * 100);
  const today = todayIndex !== null && todayIndex >= 0 && todayIndex < n ? todayIndex : null;

  return (
    <div data-testid={testid} className="select-none pt-4">
      <div className="relative h-[120px] md:h-[150px]">
        {ticks
          .filter((tick) => tick > 0 && tick <= scale)
          .map((tick) => (
            <div key={tick} className="absolute inset-x-0 border-t border-line" style={{ bottom: `${h(tick)}%` }} />
          ))}
        <div className="absolute inset-x-0 bottom-0 border-t border-line-strong" />
        <div className="absolute inset-0 flex">
          {days.map((day, i) => {
            const height = h(values[i] ?? 0);
            return (
              <div key={day.key} className="relative flex min-w-0 flex-1 items-end justify-center">
                {height > 0 && (
                  <div
                    data-day-bar=""
                    className={`w-3/5 max-w-3 rounded-t-[3px] ${DAY_BAR[i === today ? 'today' : 'past']}`}
                    style={{ height: `${height}%` }}
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
        {/* No «0»: the baseline says it, and at the left edge the label sat on
            the first day's bar. */}
        {ticks
          .filter((tick) => tick > 0 && tick <= scale)
          .map((tick) => (
            <TickLabel key={tick} at={h(tick)}>
              {num(tick, 1)}
            </TickLabel>
          ))}
        {today !== null && todayLabel && (
          <span
            data-today-label=""
            className="pointer-events-none absolute whitespace-nowrap rounded-sm bg-surface-raised/85 px-0.5 font-mono text-2xs font-semibold leading-none tabular-nums text-ink-700"
            // In the plot's top padding over today's column, anchored on the
            // side with room (#400). Not at the bar's end: a morning's bar is
            // short, and a 20-character label there sat on top of the five
            // taller days before it (seen in the round's own screenshot).
            style={{
              ...(today >= n / 2 ? { right: `${((n - today - 1) / n) * 100}%` } : { left: `${(today / n) * 100}%` }),
              bottom: 'calc(100% + 2px)',
            }}
          >
            {todayLabel}
          </span>
        )}
      </div>
      <XLabels bands={days} labelled={labelled} />
    </div>
  );
}
