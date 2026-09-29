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

  it('the page says which half is which', () => {
    const page = code('src/app/(protected)/reports/sotuvchilar/page.tsx');
    expect(page).toContain("t('cargoByStamp')");
    expect(page).toContain("t('moneyByBook')");
  });
});
