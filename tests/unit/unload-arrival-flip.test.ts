import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The first unload scan flips the truck to «arrived» (review of the fixes,
 * lock-rv2-2). The status it tests was read at the top of the input, without
 * the truck's lock, so a truck finished meanwhile would be put back to
 * «arrived» by a phone's late scan unless the UPDATE itself asks. Source-shape
 * because the window is a race no behavioural test can hold open (#531).
 */
describe('the arrival flip', () => {
  it('re-checks «in transit» in its own WHERE', () => {
    const src = readFileSync('src/modules/wms/scanning/unload.ts', 'utf8');
    const at = src.indexOf(".set({ status: 'arrived', arrivedAt: new Date() })");
    expect(at).toBeGreaterThan(0);
    const where = src.slice(at, src.indexOf(';', at));
    expect(where).toContain("eq(batches.status, 'in_transit')");
  });
});
