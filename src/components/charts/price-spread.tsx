import {
  domainOf,
  FEW,
  histogram,
  position,
  sampleOf,
  type Domain,
  type SeriesStats,
} from '@/modules/wms/customs/import-stats-math';
import { unitPrice } from './format';

/**
 * Where the customs declarations of one code price it — and where the VED's
 * own baza sits among them (his C1-C6 of 2026-10-07).
 *
 * The job is DISTRIBUTION, so the form is a histogram of the whole code on
 * one x-axis (price per unit), and under it one box row per series on the
 * SAME scale: «Hammasi», «Nomi o'xshash» and, on a dona tab, his ±25 %
 * weight line. A box alone hides a code holding a thousand different parts
 * (often two or three humps); a histogram alone cannot say which humps the
 * name or the weight pick out. Small multiples on one axis, never a second y.
 *
 * Colour: ONE sequential hue (the dashboard's ordinal ramp, already
 * validated for 3:1 on both surfaces), so there is no legend — every row is
 * named by its TEXT label, which is also what makes it colour-blind safe.
 * Ink, never a hue, carries the median and the VED's marker.
 *
 * Render-only: no hooks, no `'use client'`, data props only and no render
 * slots (import-stats-wire.test.ts). Hover is a native `title` per bar: the
 * decision values are direct labels (the chips) and the table twin, and the
 * dashboard's ChartTip cannot be mounted here — the dialog's panel carries a
 * transform, which re-bases `position: fixed`, so the tip would land
 * somewhere else on the screen.
 */

export interface SpreadRow {
  key: 'all' | 'named' | 'weight';
  label: string;
  stats: SeriesStats;
}

// Literal maps: Tailwind compiles only classes it can see.
const ROW_TESTID: Record<SpreadRow['key'], string> = {
  all: 'calc-import-box-all',
  named: 'calc-import-box-named',
  weight: 'calc-import-box-weight',
};

const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;

export function PriceSpread({
  all,
  rows,
  marker,
  medianLabel,
  oneValueLabel,
  count,
}: {
  /** The «Hammasi» series of the active tab — the histogram and the axis. */
  all: SeriesStats;
  /** The box rows, «Hammasi» first; a row with n = 0 is not passed. */
  rows: SpreadRow[];
  /** The VED's own baza, already checked to be in THIS tab's basis. */
  marker: { value: number; label: string } | null;
  medianLabel: string;
  oneValueLabel: string;
  /** «3 ta» — an exact bar's count, in the reader's language. */
  count: (n: number) => string;
}) {
  const domain = domainOf(all);
  if (!domain) return null;
  const hist = histogram(sampleOf(all), domain);
  const exact = all.prices !== null && all.prices.length > 0;
  const top = Math.max(0, ...hist.bins.map((b) => b.share));
  const at = (v: number | null) => (v === null ? null : position(v, domain));
  const p25 = at(all.p25);
  const p50 = at(all.p50);
  const p75 = at(all.p75);
  const you = marker ? position(marker.value, domain) : null;
  const single = domain.lo === domain.hi;
  const n = all.n;

  return (
    <div data-testid="calc-import-strip" className="select-none">
      {/* The plot sits in the box rows' value column on desktop, so every row
          shares ONE x scale (a label column beside a full-width histogram
          would move the axis between them). */}
      <div className="md:grid md:grid-cols-[9.5rem_1fr] md:gap-2">
        <div className="hidden md:block" />
        <div className="min-w-0">
          {/* The bars get 72 / 96 px; the 20 px above them is the «siz» marker's. */}
          <div className="relative h-[92px] pt-5 md:h-[116px]">
            <div className="relative h-full">
              {/* The middle half of the declarations, as a wash behind the bars. */}
              {p25 && p75 && !single ? (
                <div
                  className="absolute inset-y-0 bg-viz-ord1/20"
                  style={{ left: `${p25.pct}%`, width: `${Math.max(0, p75.pct - p25.pct)}%` }}
                />
              ) : null}
              <div className="absolute inset-x-0 bottom-0 border-t border-line-strong" />
              {single ? (
                <div className="absolute inset-0 flex items-end justify-center">
                  <div
                    className="h-full w-6 rounded-t-[3px] bg-viz-ord2"
                    title={`${unitPrice(domain.lo)} · ${oneValueLabel}`}
                    aria-label={`${unitPrice(domain.lo)} · ${oneValueLabel}`}
                  />
                </div>
              ) : (
                <div className="absolute inset-0 flex items-end gap-[2px]">
                  {hist.bins.map((bin, i) => {
                    const height = top > 0 ? (bin.share / top) * 100 : 0;
                    const tip = `${unitPrice(bin.from)}–${unitPrice(bin.to)} · ${
                      exact ? count(Math.round(bin.share * n)) : `≈${pct(bin.share)}`
                    }`;
                    return (
                      <div key={i} className="flex h-full min-w-0 flex-1 items-end" title={tip} aria-label={tip}>
                        {/* An empty bin draws no bar: a 2 px stub reads as «a little». */}
                        {height > 0 ? (
                          <div className="w-full rounded-t-[3px] bg-viz-ord2" style={{ height: `${height}%` }} />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
              {p25 && !single ? (
                <div className="pointer-events-none absolute inset-y-0 w-px bg-ink-500" style={{ left: `${p25.pct}%` }} />
              ) : null}
              {p75 && !single ? (
                <div className="pointer-events-none absolute inset-y-0 w-px bg-ink-500" style={{ left: `${p75.pct}%` }} />
              ) : null}
              {p50 ? (
                <div
                  className="pointer-events-none absolute inset-y-0 w-[2px] -translate-x-1/2 bg-ink-900"
                  style={{ left: `${p50.pct}%` }}
                />
              ) : null}
            </div>
            {/* The VED's own number: position, not judgement (C5 a). Ink and
                never red, amber or the money-out hue — brand-600 sits within a
                few points of `bad`, and a red ▼ on a price spread reads as the
                out-of-range warning he declined. Anchored on the side with
                room, so the label cannot hang off a phone (#400). */}
            {you && marker ? (
              <span
                data-testid="calc-import-you"
                className="pointer-events-none absolute top-0 whitespace-nowrap font-mono text-2xs font-semibold leading-none tabular-nums text-ink-900"
                style={
                  you.pct > 50
                    ? { right: `${100 - you.pct}%`, transform: 'translateX(0.35rem)' }
                    : { left: `${you.pct}%`, transform: 'translateX(-0.35rem)' }
                }
              >
                {you.pct > 50
                  ? `${marker.label} ${you.clamped === 'high' ? '›' : '▼'}`
                  : `${you.clamped === 'low' ? '‹' : '▼'} ${marker.label}`}
              </span>
            ) : null}
          </div>
          <Axis domain={domain} median={all.p50} medianLabel={medianLabel} />
        </div>
      </div>

      <div className="mt-1 space-y-1">
        {rows.map((row) => (
          <BoxRow key={row.key} row={row} domain={domain} />
        ))}
      </div>
    </div>
  );
}

/** Ends and the median under the plot. The ends are ANCHORED to the plot's
 * edges and the median label shifts by its own position, so no label can
 * hang outside the card; a median too near an end leaves the end to speak. */
function Axis({ domain, median, medianLabel }: { domain: Domain; median: number | null; medianLabel: string }) {
  const mid = median === null ? null : position(median, domain);
  const showMid = mid !== null && mid.clamped === null && mid.pct >= 22 && mid.pct <= 78;
  return (
    <div className="relative mt-1 h-4 text-2xs leading-none text-ink-500" aria-hidden>
      <span className="absolute left-0 top-0 whitespace-nowrap font-mono tabular-nums">
        {domain.clippedLow > 0 ? `‹ ${pct(domain.clippedLow)} · ` : ''}
        {unitPrice(domain.lo)}
      </span>
      {showMid && median !== null ? (
        <span
          className="absolute top-0 whitespace-nowrap font-mono font-semibold tabular-nums text-ink-900"
          style={{ left: `${mid.pct}%`, transform: `translateX(-${mid.pct}%)` }}
        >
          {medianLabel} {unitPrice(median)}
        </span>
      ) : null}
      {domain.hi !== domain.lo ? (
        <span className="absolute right-0 top-0 whitespace-nowrap font-mono tabular-nums">
          {unitPrice(domain.hi)}
          {domain.clippedHigh > 0 ? ` · ${pct(domain.clippedHigh)} ›` : ''}
        </span>
      ) : null}
    </div>
  );
}

/** One series on the shared scale: p25-p75 as a box with an ink median
 * tick, or — under FEW declarations — one dot per declaration. */
function BoxRow({ row, domain }: { row: SpreadRow; domain: Domain }) {
  const s = row.stats;
  const p25 = s.p25 === null ? null : position(s.p25, domain);
  const p50 = s.p50 === null ? null : position(s.p50, domain);
  const p75 = s.p75 === null ? null : position(s.p75, domain);
  const dots = s.n < FEW ? (s.prices ?? []) : [];
  return (
    <div data-testid={ROW_TESTID[row.key]} className="md:grid md:grid-cols-[9.5rem_1fr] md:items-center md:gap-2">
      <span className="block truncate text-2xs text-ink-700 md:text-right" title={row.label}>
        {row.label}
      </span>
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 border-t border-line" />
        {s.n >= FEW && p25 && p75 ? (
          <div
            className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-full bg-viz-ord3/30"
            style={{ left: `${p25.pct}%`, width: `max(4px, ${p75.pct - p25.pct}%)` }}
          />
        ) : null}
        {s.n >= FEW && p50 ? (
          <div
            className="absolute top-1/2 h-4 w-[2px] -translate-x-1/2 -translate-y-1/2 bg-ink-900"
            style={{ left: `${p50.pct}%` }}
          />
        ) : null}
        {dots.map((v, i) => {
          const at = position(v, domain);
          return at ? (
            <span
              key={i}
              className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-viz-ord3 ring-2 ring-surface-raised"
              style={{ left: `${at.pct}%` }}
              title={unitPrice(v)}
            />
          ) : null;
        })}
      </div>
    </div>
  );
}
