import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ru from '../../messages/ru.json';
import { STOCK_COLUMNS } from '@/modules/wms/inventory/columns';

/**
 * «Yuk qaysi partiyada kelgani» on the stock table and both plan screens
 * (owner, 2026-08-29). The RULE has one home — round 92's arrivals module —
 * and every new surface must read it from there; a second statement of
 * «which movement is an arrival» is how the agent sheet and the stock table
 * would come to disagree about the same carton (#513).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

describe('the partiya surfaces read the ONE arrivals home', () => {
  it('the stock screen and its XLSX use arrivalCodesForPairs, keyed on (lot, warehouse)', () => {
    /**
     * The export's HALVES moved apart in the round that gave the sheet
     * photographs and XYZ: the route still asks the arrivals module, and the
     * spreadsheet that consumes the answer is now `reports/stock-xlsx`. So
     * each half is read where it lives — and the fence still closes, because
     * the builder's only source for that map is the argument the route hands
     * it (asserted below).
     */
    for (const path of [
      'src/app/(protected)/stock/page.tsx',
      'src/app/api/reports/stock/route.ts',
    ]) {
      const src = read(path);
      expect(src, path).toContain('arrivalCodesForPairs(');
      // The pair: a lot standing in two warehouses arrived on two different
      // answers, and keying on the lot alone prints one of them on both
      // shelves.
      expect(src, path).toMatch(/warehouseId: line\.whId|\|\$\{line\.whId\}/);
      expect(src, path).not.toMatch(/landedHereSql|ARRIVED_ON_A_TRUCK/);
    }
    // The sheet READS that map, and by the same pair key.
    const builder = read('src/modules/wms/reports/stock-xlsx.ts');
    expect(builder).toMatch(/arrivalCodes\.get\(`\$\{line\.lot\.id\}\|\$\{line\.whId\}`\)/);
    expect(builder).not.toMatch(/landedHereSql|ARRIVED_ON_A_TRUCK/);
    // …and the route's own answer reaches it rather than being recomputed.
    expect(read('src/app/api/reports/stock/route.ts')).toMatch(
      /buildStockXlsx\(\{[\s\S]{0,200}arrivalCodes,/,
    );
  });

  it('the plan editor API and the plan view read arrivalsForLots at the plan ORIGIN', () => {
    const route = read('src/app/api/plans/stock/route.ts');
    expect(route).toContain('arrivalsForLots(');
    // BOTH feeds — the loose lots and the crates. One occurrence let the
    // crate half stand in for a stripped lot half (the proof stayed green).
    expect([...route.matchAll(/arrival:/g)].length).toBeGreaterThanOrEqual(2);
    const view = read('src/app/(protected)/plans/[id]/page.tsx');
    expect(view).toContain('arrivalsForLots(');
    expect(view).toContain('plan.originWarehouseId');
  });

  it('the editor renders the arrival for loose lots AND crates', () => {
    const editor = read('src/app/(protected)/plans/new/plan-editor.tsx');
    expect(editor).toContain('lot.arrival');
    expect(editor).toContain('crate.arrival');
  });

  it('the column exists, its label resolves, and the XLSX carries it', () => {
    expect(STOCK_COLUMNS.some((column) => column.key === 'partiya')).toBe(true);
    expect((ru as unknown as { stock: Record<string, string> }).stock.colBatch).toBeTruthy();
    // The column lives with the sheet it draws (see the note above).
    const xlsx = read('src/modules/wms/reports/stock-xlsx.ts');
    expect(xlsx).toMatch(/key: 'partiya', column: \{ header: L\.batch/);
  });
});
