// FIRST: the components compile to the classic `React.createElement`.
import '../fixtures/react-global';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PriceSpread, medianLabelFits } from '@/components/charts/price-spread';
import { unitPrice } from '@/components/charts/format';
import { LADDER_STEPS, domainOf, type SeriesStats } from '@/modules/wms/customs/import-stats-math';

/**
 * The strip's axis, RENDERED: the end labels carry the price and nothing
 * else.
 *
 * They used to carry «‹ 5 % ·» / «· 5 % ›» whenever a big sample was drawn
 * p5..p95, and the median label's 22-78 % guard was written for a bare price
 * — so on a phone (~300 px of plot) a median anywhere from about 22 % to 45 %
 * printed over the left end, and neither price could be read. The tails are
 * said under the strip in words now (`clippedSide`, baza-stats.tsx).
 */

const series = (over: Partial<SeriesStats>): SeriesStats => ({
  n: 0,
  min: null,
  max: null,
  p25: null,
  p50: null,
  p75: null,
  ladder: null,
  prices: null,
  exemplars: { p25: null, p50: null, p75: null },
  ...over,
});

// A big sample (n > RAW_MAX) with a tail beyond BOTH ends of p5..p95, and
// four-decimal prices — the longest labels `unitPrice` writes below a dollar.
const ladder = LADDER_STEPS.map((_, i) => Number((0.2001 + i * 0.0031).toFixed(4)));
const all = series({
  n: 500,
  min: 0.0507,
  max: 1.9003,
  ladder,
  p25: ladder[24]!,
  p50: ladder[49]!,
  p75: ladder[74]!,
});

const text = (markup: string, end: 'lo' | 'hi') =>
  markup.match(new RegExp(`data-axis="${end}"[^>]*>([^<]*)<`))?.[1] ?? null;

describe('the price spread axis', () => {
  const markup = renderToStaticMarkup(
    h(PriceSpread, {
      all,
      rows: [{ key: 'all', label: 'Kodning hammasi', stats: all }],
      marker: null,
      medianLabel: 'mediana',
      oneValueLabel: 'Hammasi bir narxda',
      count: (n: number) => `${n} ta`,
    }),
  );
  const domain = domainOf(all)!;

  it('is drawn clipped on both ends — the case the labels used to grow on', () => {
    expect(domain.clippedLow).toBeGreaterThan(0);
    expect(domain.clippedHigh).toBeGreaterThan(0);
  });

  it('prints the bare price at each end', () => {
    expect(text(markup, 'lo')).toBe(unitPrice(domain.lo));
    expect(text(markup, 'hi')).toBe(unitPrice(domain.hi));
    expect(markup).not.toContain('‹ 5');
    expect(markup).not.toContain('5 % ›');
  });
});

describe('the median label fits or is not drawn', () => {
  // The phone's own figures, measured in a browser at 360×800: a 302 px plot,
  // «$0.2001» … «$0.5003» at the ends, the median label 15 cells wide.
  const lo = '$0.2001';
  const hi = '$0.5003';
  it('stays off a four-decimal end at the bottom of the old 22-78 % guard', () => {
    // 22.5 %: measured 0.6 px INTO the left end.
    expect(medianLabelFits(22.5, lo, 'медиана $0.2676', hi)).toBe(false);
    // 30 %: measured 14.7 px clear.
    expect(medianLabelFits(30, lo, 'медиана $0.2902', hi)).toBe(true);
    expect(medianLabelFits(45, lo, 'медиана $0.3352', hi)).toBe(true);
  });
  it('mirrors on the right, and counts a CJK glyph as two cells', () => {
    expect(medianLabelFits(77.5, lo, 'медиана $0.4327', hi)).toBe(false);
    expect(medianLabelFits(70, lo, 'медиана $0.4102', hi)).toBe(true);
    // «中位数 $0.2700» is 11 code points and 14 cells — a CJK glyph is about
    // 11 px, not 6.6 — so at 23 % it runs into the end while a label of the
    // same LENGTH in Latin letters clears it.
    expect(medianLabelFits(23, lo, 'abc $0.2700', hi)).toBe(true);
    expect(medianLabelFits(23, lo, '中位数 $0.2700', hi)).toBe(false);
  });
  it('a wider plot only makes room', () => {
    expect(medianLabelFits(22.5, lo, 'медиана $0.2676', hi, 422)).toBe(true);
  });

  const at = (pct: number) => {
    // The same big clipped sample, with its median moved to `pct` of the axis.
    const lad = [...ladder];
    lad[49] = Number((lad[4]! + (pct / 100) * (lad[94]! - lad[4]!)).toFixed(4));
    const s = series({ ...all, ladder: lad, p50: lad[49]! });
    return renderToStaticMarkup(
      h(PriceSpread, {
        all: s,
        rows: [{ key: 'all', label: 'Весь код', stats: s }],
        marker: null,
        medianLabel: 'медиана',
        oneValueLabel: 'Все по одной цене',
        count: (n: number) => `${n} шт.`,
      }),
    );
  };
  it('is left out where it would run into an end, and drawn where it clears', () => {
    expect(at(22.5)).not.toContain('data-axis="mid"');
    expect(at(45)).toContain('data-axis="mid"');
  });
});
