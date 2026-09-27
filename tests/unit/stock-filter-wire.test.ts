import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * /stock and its XLSX ask ONE question of the search box (#513): the text
 * predicate was restated in both files, so adding the factory barcode
 * (0112, Q10 c) to one would have made the table find a lot the download did
 * not have. Source-shape, comments stripped (#725).
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

  it('the predicate carries the barcode half', () => {
    const source = strip(readFileSync('src/modules/wms/inventory/stock-filter.ts', 'utf8'));
    expect(source).toContain('receiptLots.factoryBarcode} = ${key}');
    expect(source).toContain('likeNeedle(');
  });
});
