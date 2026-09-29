import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * /stock and its XLSX ask ONE question of the search box (#513): the text
 * predicate was restated in both files, so a change to one would have made
 * the table find a lot the download did not have. Source-shape, comments
 * stripped (#725).
 */

const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the stock search predicate', () => {
  for (const file of ['src/app/(protected)/stock/page.tsx', 'src/app/api/reports/stock/route.ts']) {
    it(`${file} reads stockTextWhere and restates nothing`, () => {
      const source = strip(readFileSync(file, 'utf8'));
      expect(source).toContain("from '@/modules/wms/inventory/stock-filter'");
      expect(source).toMatch(/stockTextWhere\((params\.)?q\)/);
      expect(source).not.toMatch(/ILIKE \$\{'%'/);
      expect(source).not.toMatch(/productNameZh\} ILIKE/);
    });
  }

  it('the predicate reads the marking and no barcode (DECISIONS #1224)', () => {
    const source = strip(readFileSync('src/modules/wms/inventory/stock-filter.ts', 'utf8'));
    // The factory's text code lives in the marking.
    expect(source).toContain('receipts.unclaimedMarking} ILIKE ${like}');
    expect(source).toContain('likeNeedle(');
    expect(source).not.toMatch(/factoryBarcode|factory-barcode/);
  });
});
