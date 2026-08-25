import { describe, expect, it } from 'vitest';
import { groupPerUnit } from '@/modules/wms/calc/history';

/**
 * The per-group customs rate — the one per-product number that is EXACT.
 *
 * `customsFor` runs per group and the seal stores each group's own figure, so
 * a group's customs per cube is arithmetic on stored numbers. Freight is not:
 * it is computed once for the whole request from the request's own density,
 * and allocating a mixed load's band onto one product overstates it (measured
 * on a realistic mix: 2.64×). Nothing here divides freight.
 */
describe('groupPerUnit', () => {
  const group = (over: Record<string, unknown> = {}) => ({
    customs: { customsUsd: 900 },
    volumeM3: 30,
    quantity: 100,
    items: [{ volumeM3: 20, quantity: 60 }, { volumeM3: 10, quantity: 40 }],
    ...over,
  });

  it('divides the group’s own customs by the group’s own measure', () => {
    expect(groupPerUnit(group(), 'volumeM3')).toBe(30); // 900 / 30
    expect(groupPerUnit(group(), 'quantity')).toBe(9); // 900 / 100
  });

  it('REFUSES when only some items carry the measure', () => {
    // `groupMeasure` sums only the items that have one, so a three-item group
    // where one item has a volume reports that item's volume as the group's —
    // and dividing by it prints roughly three times the true rate.
    const partial = group({ items: [{ volumeM3: 20 }, { quantity: 40 }] });
    expect(groupPerUnit(partial, 'volumeM3')).toBeNull();
  });

  it('REFUSES an OLD sealed row whose items have no volume at all', () => {
    // The field was added in phase C; every row sealed before it lacks it, and
    // `undefined` must read as «not measured», never as zero.
    const old = group({ items: [{ quantity: 60 }, { quantity: 40 }] });
    expect(groupPerUnit(old, 'volumeM3')).toBeNull();
    expect(groupPerUnit(old, 'quantity')).toBe(9);
  });

  it('refuses a missing or non-finite customs figure', () => {
    expect(groupPerUnit(group({ customs: null }), 'volumeM3')).toBeNull();
    expect(groupPerUnit(group({ customs: { customsUsd: NaN } }), 'volumeM3')).toBeNull();
  });

  it('refuses a zero or absent divisor instead of dividing by it', () => {
    expect(groupPerUnit(group({ volumeM3: 0 }), 'volumeM3')).toBeNull();
    expect(groupPerUnit(group({ volumeM3: null }), 'volumeM3')).toBeNull();
  });

  it('refuses an empty group', () => {
    expect(groupPerUnit(group({ items: [] }), 'volumeM3')).toBeNull();
  });
});
