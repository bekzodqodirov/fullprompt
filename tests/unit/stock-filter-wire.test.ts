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

  for (const file of ['src/app/(protected)/stock/page.tsx', 'src/app/api/reports/stock/route.ts']) {
    it(`${file} builds its base filter and its crates from the one home`, () => {
      const source = strip(readFileSync(file, 'utf8'));
      // The shelf statuses, the scope and the warehouse: the export spelled
      // the statuses out as a literal and bound `wh` unchecked.
      expect(source).toMatch(/stockBoxFilter\(actor, \{ wh(: params\.wh)? \}\)/);
      expect(source).not.toMatch(/'in_stock', 'planned', 'loading', 'ready_for_pickup'/);
      // The crates the rows stand in, over the SAME filter list as the rows.
      expect(source).toMatch(/stockCrates\((scopeFilter|filters), \{ narrowed: Boolean\((params\.)?q\) \}\)/);
    });
  }

  it('the crate list above the stock table is gone — the rows carry the crates', () => {
    const source = strip(readFileSync('src/app/(protected)/stock/page.tsx', 'utf8'));
    expect(source).not.toMatch(/CrateRows|crateStock/);
    expect(source).toContain('<RowCratesFold');
  });

  it('every stock read joins a crate through crateHereOn, never the bare pointer', () => {
    const reads = strip(readFileSync('src/modules/wms/inventory/stock-crates.ts', 'utf8'));
    expect(reads.match(/innerJoin\(crates, crateHereOn\(\)\)/g)?.length).toBe(3);
    expect(reads).not.toMatch(/innerJoin\(crates, eq\(/);
    const filter = strip(readFileSync('src/modules/wms/inventory/stock-filter.ts', 'utf8'));
    // The CR- search matches a carton only while it stands IN that crate.
    expect(filter).toMatch(/EXISTS \(SELECT 1 FROM \$\{crates\} WHERE \$\{crateHereOn\(\)\} AND \$\{crates\.code\} ILIKE \$\{like\}\)/);
  });

  it('the predicate reads the marking and no barcode (DECISIONS #1224)', () => {
    const source = strip(readFileSync('src/modules/wms/inventory/stock-filter.ts', 'utf8'));
    // The factory's text code lives in the marking.
    expect(source).toContain('receipts.unclaimedMarking} ILIKE ${like}');
    expect(source).toContain('likeNeedle(');
    expect(source).not.toMatch(/factoryBarcode|factory-barcode/);
  });
});
