import { describe, expect, it } from 'vitest';
import { isInternalLeg } from '@/modules/wms/batches/internal';

/**
 * «Ichki reys» (owner, 2026-09-24): a truck that crosses no border. Decided
 * by the two warehouses' countries — `batches.type` has two writers that
 * disagree and no reader, so it cannot carry this.
 */
describe('isInternalLeg', () => {
  it('a leg inside China is internal', () => {
    expect(isInternalLeg('CN', 'CN')).toBe(true); // Yiwu → Kashgar
  });

  it('a leg inside Uzbekistan is NOT — it is sometimes priced (owner U1b)', () => {
    expect(isInternalLeg('UZ', 'UZ')).toBe(false); // Andijan → Tashkent
    expect(isInternalLeg('uz', 'UZ ')).toBe(false);
  });

  it('a leg across a border is not', () => {
    expect(isInternalLeg('CN', 'UZ')).toBe(false);
  });

  it('reads the free-text column the way a person typed it', () => {
    expect(isInternalLeg(' cn', 'CN ')).toBe(true);
  });

  it('an unknown country is a crossed border: the price door stays where it was', () => {
    expect(isInternalLeg('', '')).toBe(false);
    expect(isInternalLeg(null, 'CN')).toBe(false);
  });
});
