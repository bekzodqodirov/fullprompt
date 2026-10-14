import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { unsplitHref } from '@/modules/wms/accounting/unsplit-href';

/**
 * Where «money on no box» leads (docs/YOLKIRA-TAQSIMOT.md §6.3.6-7): ONE
 * answer for the dashboard's attention row and the Balans sentence. Comments
 * are stripped before a source is read (#725).
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const W = { from: '2026-01-01', to: '2026-10-14' };
const PROFIT = '/accounting/profit?view=batch&bolinmagan=1&from=2026-01-01&to=2026-10-14';

describe('unsplitHref', () => {
  it('one truck opens its Xarajatlar tab, for a reader the tab admits', () => {
    expect(unsplitHref(['b1'], W, true)).toBe('/batches/b1/xarajatlar');
    // The same truck twice is still one truck.
    expect(unsplitHref(['b1', 'b1'], W, true)).toBe('/batches/b1/xarajatlar');
  });

  it('several trucks — or a reader the tab would bounce — open the profit page’s «bo‘linmagan» list', () => {
    expect(unsplitHref(['b1', 'b2'], W, true)).toBe(PROFIT);
    expect(unsplitHref(['b1'], W, false)).toBe(PROFIT);
    expect(unsplitHref([], W, true)).toBe(PROFIT);
  });

  it('both surfaces ask it, and the profit page reads the same parameter', () => {
    expect(read('src/modules/wms/reports/attention.ts')).toMatch(/href: unsplitHref\(\s*unallocated\.map/);
    expect(read('src/app/(protected)/accounting/balance/page.tsx')).toContain('const heldHref = unsplitHref(');
    const profit = read('src/app/(protected)/accounting/profit/page.tsx');
    expect(profit).toContain("params[UNSPLIT_PARAM] === '1'");
    expect(profit).toContain('unsplitOnly ? row.unallocatedUsd > 0.009 : row.tracked');
  });
});
