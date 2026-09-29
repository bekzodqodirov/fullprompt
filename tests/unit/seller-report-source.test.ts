import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The seller's CARGO has one reader (0117): the receipt's own seller stamp,
 * carton by carton (`staff/cargo.ts`). The report, /upsale's KPI block and
 * /hodimlar all ask it, so the three screens cannot print three different
 * m³ for one seller's month (#513) — the old `cargoByManager` summed
 * `receipt_lots` by the client's CURRENT manager, and `sellerCargo` summed
 * them by the DEAL's owner, and both are deleted.
 */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('one reader for a seller’s cargo', () => {
  it('the report reads the stamp, never a lot sum of its own', () => {
    const report = code('src/modules/wms/crm/seller-report.ts');
    expect(report).toMatch(/import \{ stampedCargo, unstampedCargo \} from '\.\.\/staff\/cargo';/);
    expect(report).not.toMatch(/receiptLots|receipt_lots/);
    expect(report).not.toMatch(/function cargoByManager/);
  });

  it('/upsale’s cargo block reads the same function', () => {
    const page = code('src/app/(protected)/upsale/page.tsx');
    expect(page).toMatch(/stampedCargo\(/);
    expect(code('src/modules/wms/calc/upsale-service.ts')).not.toMatch(/export async function sellerCargo/);
  });

  it('the cargo reader counts cartons, not lots', () => {
    const cargo = code('src/modules/wms/staff/cargo.ts');
    expect(cargo).toMatch(/JOIN boxes b ON b\.lot_id = rl\.id/);
    expect(cargo).toMatch(/rl\.total_volume_m3 \/ rl\.box_count AS m3/);
  });

  it('the page says which part is which', () => {
    const page = code('src/app/(protected)/reports/sotuvchilar/page.tsx');
    expect(page).toContain("t('cargoByStamp')");
    expect(page).toContain("t('moneyByStamp')");
    expect(page).toContain("t('clientsByBook')");
    expect(page).not.toContain('moneyByBook');
  });
});

describe('one attribution for the seller’s money (4a)', () => {
  it('the report’s money is the stamp’s', () => {
    const report = code('src/modules/wms/crm/seller-report.ts');
    expect(report).toMatch(/revenueByStamp\(/);
    expect(report).toMatch(/costByStamp\(/);
    expect(report).not.toContain('profitByClient');
    expect(report).not.toContain('managerOf');
    // The dashboard card is the report's number, never a third calculation (#513).
    expect(code('src/modules/wms/staff/seller-profit.ts')).toMatch(/sellerPerformanceAll\(/);
  });

  it('the full attribution sentence is the full table’s; the own card reads one line of its own', () => {
    // The sentence names the «—» row and the unlinked / split lines — figures
    // only the full table carries — so a seller's own card must not print it.
    const page = code('src/app/(protected)/reports/sotuvchilar/page.tsx');
    expect(page).toMatch(/\{scope === 'all' \? \(\s*<p[^>]*data-testid="seller-attribution"/);
    expect(page).toMatch(/data-testid="seller-attribution-own"[^>]*>\s*\{t\('ownAttribution'\)\}/);
  });

  it('the «—» row is explained whenever it carries a figure', () => {
    const page = code('src/app/(protected)/reports/sotuvchilar/page.tsx');
    expect(page).toContain('const nobodyShown = nobody !== undefined &&');
    expect(page).toMatch(/\{nobodyShown \? \(\s*<p[^>]*data-testid="seller-nobody-note"/);
  });
});
