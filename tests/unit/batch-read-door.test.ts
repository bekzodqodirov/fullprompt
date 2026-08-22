import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BATCH_READERS, mayReadBatches } from '@/modules/wms/batches/read-door';
import { NAV } from '@/modules/platform/rbac/nav';

/**
 * Every screen that shows trucks asks the SAME door.
 *
 * The list existed three times before it existed once, and the two pages that
 * had no copy — /trucks and /map — had no door at all: any signed-in login
 * read every truck's plate, route and per-client contents, and /map added
 * every warehouse's stock broken down by client code. One list, four
 * consumers, and this file is what stops a fifth consumer starting from
 * scratch.
 */
describe('the batch read door', () => {
  const PAGES = [
    'src/app/(protected)/transit/page.tssx'.replace('tssx', 'tsx'),
    'src/app/(protected)/trucks/page.tsx',
    'src/app/(protected)/map/page.tsx',
  ];

  it.each(PAGES)('%s asks mayReadBatches and refuses', (page) => {
    const source = readFileSync(page, 'utf8');
    expect(source).toMatch(/if \(!mayReadBatches\(actor\.permissions\)\) redirect\('\/'\);/);
  });

  it('the search asks the same door', () => {
    const source = readFileSync('src/modules/wms/search/service.ts', 'utf8');
    expect(source).toContain('mayReadBatches(actor.permissions)');
  });

  it('the two scoped pages fence trucks on BOTH ends of the trip', () => {
    for (const page of ['src/app/(protected)/map/page.tsx', 'src/app/(protected)/trucks/page.tsx']) {
      const source = readFileSync(page, 'utf8');
      expect(source, page).toMatch(
        /warehouseScopeEither\(actor,\s*batches\.originWarehouseId,\s*batches\.destWarehouseId\)/,
      );
    }
  });

  it('the map scopes the per-client stock like the stock screen', () => {
    const source = readFileSync('src/app/(protected)/map/page.tsx', 'utf8');
    expect(source).toMatch(/allWh\.filter\(\(w\) => inScope\(actor, w\.id\)\)/);
  });

  it('the MENU promises exactly what the door checks — platform cannot import wms', () => {
    const items = NAV.flatMap((s) => s.items).filter(
      (i) => i.href === '/trucks' || i.href === '/map',
    );
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect([...(item.permissions ?? [])].sort(), item.href).toEqual([...BATCH_READERS].sort());
    }
  });

  it('the door itself answers both ways', () => {
    expect(mayReadBatches(new Set(['plans.manage']))).toBe(true);
    expect(mayReadBatches(new Set(['crm.leads', 'finance.view']))).toBe(false);
  });
});
