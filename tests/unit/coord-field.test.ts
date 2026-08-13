import { describe, expect, it } from 'vitest';
import { coordField } from '@/modules/platform/forms/coord';

/**
 * Round 100 (9B): the empty coordinate box must stay NULL. The naive zod
 * recipe (`z.coerce.number` after trim) turns '' into 0, and 0°N 0°E is a
 * real place that passes every range check — the design review caught the
 * warehouse dot quietly moving to the Atlantic the first time the form was
 * saved with the boxes untouched.
 */
describe('coordField', () => {
  const lat = coordField(-90, 90);

  it('an empty box is NO ANSWER, never zero', () => {
    expect(lat.parse('')).toBeUndefined();
    expect(lat.parse('   ')).toBeUndefined();
  });

  it('reads the number, comma decimals included', () => {
    expect(lat.parse('41.311081')).toBeCloseTo(41.311081, 6);
    expect(lat.parse('41,311081')).toBeCloseTo(41.311081, 6);
  });

  it('zero typed on purpose IS a coordinate', () => {
    expect(lat.parse('0')).toBe(0);
  });

  it('refuses what is not on the planet', () => {
    expect(lat.safeParse('99').success).toBe(false);
    expect(lat.safeParse('-91').success).toBe(false);
    expect(coordField(-180, 180).safeParse('181').success).toBe(false);
    expect(lat.safeParse('salom').success).toBe(false);
  });
});
