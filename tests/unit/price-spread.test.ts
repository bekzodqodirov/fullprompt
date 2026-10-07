// FIRST: the components compile to the classic `React.createElement`.
import '../fixtures/react-global';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PriceSpread } from '@/components/charts/price-spread';
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
