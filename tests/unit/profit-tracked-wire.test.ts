import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «Partiya» (0107), the owner's rule: the admin or the accountant marks which
 * trucks «Partiya foydasi» reads. Source-shape, because the action calls
 * `authorize` and no integration test can press it (#531).
 */
const read = (path: string) => readFileSync(path, 'utf8');
const slice = (text: string, from: string) => {
  const at = text.indexOf(from);
  expect(at, from).toBeGreaterThan(-1);
  const next = text.indexOf('\nexport ', at + from.length);
  return text.slice(at, next === -1 ? undefined : next);
};

describe('the «Partiya» mark', () => {
  it('is set by finance.reports, with an explicit value and an audit row', () => {
    const action = slice(
      read('src/app/(protected)/batches/batch-actions-server.ts'),
      'export async function setProfitTrackedAction',
    );
    expect(action).toContain("authorize('finance.reports'");
    expect(action).toContain("formData.get('tracked') === '1'");
    expect(action).toContain('before: { profitTracked: batch.profitTracked }');
  });

  it('is offered on the card only to the people who may set it', () => {
    const page = read('src/app/(protected)/batches/[id]/page.tsx');
    expect(page).toMatch(/permissions\.has\('finance\.reports'\) && \(\s*<ProfitTracked/);
  });

  it('every truck-profit table reads only marked trucks and names the rest', () => {
    const screen = read('src/app/(protected)/accounting/profit/page.tsx');
    expect(screen).toContain('trips!.filter((row) => row.tracked)');
    expect(screen).toContain('untrackedTrips(trips)');
    const file = read('src/modules/wms/accounting/xlsx.ts');
    expect(file).toContain('all.filter((row) => row.tracked)');
    expect(file).toContain('untrackedTrips(all)');
    const dash = read('src/app/(protected)/dashboard/sections/money.tsx');
    expect(dash).toContain('trips.filter((row) => row.tracked)');
  });
});
