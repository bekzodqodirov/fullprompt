import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { receipts } from '@/modules/platform/db/schema';
import {
  hasNoWarehouse,
  inScope,
  warehouseScope,
  warehouseScopeEither,
} from '@/modules/platform/rbac/scope';

const UNSCOPED = { warehouseScoped: false, warehouseIds: [] };
const SCOPED = { warehouseScoped: true, warehouseIds: ['w-cn'] };
const STRANDED = { warehouseScoped: true, warehouseIds: [] };

describe('warehouse scope', () => {
  it('applies no filter to an unscoped viewer', () => {
    expect(warehouseScope(UNSCOPED, receipts.warehouseId)).toBeUndefined();
    expect(warehouseScopeEither(UNSCOPED, receipts.warehouseId, receipts.warehouseId)).toBeUndefined();
  });

  it('filters a scoped viewer to their own warehouses', () => {
    expect(warehouseScope(SCOPED, receipts.warehouseId)).toBeDefined();
  });

  it('shows NOTHING to a scoped viewer with no warehouse — not everything', () => {
    // The bug this helper exists to make unwriteable. Thirteen screens said
    // `scoped && ids.length ? inArray(...) : undefined`, and the `: undefined`
    // meant a new hire with no assignment read the whole company.
    const filter = warehouseScope(STRANDED, receipts.warehouseId);
    expect(filter).toBeDefined();
    expect(filter).toEqual(sql`false`);
    expect(warehouseScopeEither(STRANDED, receipts.warehouseId, receipts.warehouseId)).toEqual(
      sql`false`,
    );
  });

  it('flags the stranded case so a screen can explain the empty list', () => {
    expect(hasNoWarehouse(STRANDED)).toBe(true);
    expect(hasNoWarehouse(SCOPED)).toBe(false);
    expect(hasNoWarehouse(UNSCOPED)).toBe(false);
  });

  it('guards a single row the same way the list is guarded', () => {
    expect(inScope(UNSCOPED, 'w-uz')).toBe(true);
    expect(inScope(UNSCOPED, null)).toBe(true);
    expect(inScope(SCOPED, 'w-cn')).toBe(true);
    expect(inScope(SCOPED, 'w-uz')).toBe(false);
    // A row with no warehouse is not "everyone's row" for a scoped viewer.
    expect(inScope(SCOPED, null)).toBe(false);
    expect(inScope(STRANDED, 'w-cn')).toBe(false);
  });
});
