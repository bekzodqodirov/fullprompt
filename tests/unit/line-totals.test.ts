import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { linesVolumeM3, roundM3, volumeIsLinesSum } from '@/modules/wms/calc/line-totals';

/**
 * His 2.7 b: the shipment's m³ is SUMMED from the goods lines
 * (docs/SAKKIZ-R2.md K2, K13). Two rules carry the whole money risk, and both
 * are literals here, written by hand:
 *
 * - ALL or NOTHING. One line without a figure makes the Σ a smaller number
 *   wearing the shipment's name, and freight is priced on it — so the answer
 *   is «no Σ», never a partial one (the reconcile's `covered` rule).
 * - The column's scale. Every m³ column is numeric(12,3), so the Σ is rounded
 *   half-up to the thousandth on the DECIMAL, never on the binary float.
 */
describe('linesVolumeM3 — the Σ of the lines, all or nothing', () => {
  const lines = (...v: (number | null)[]) => v.map((volumeM3) => ({ volumeM3 }));

  it('adds every line when every line states a volume', () => {
    expect(linesVolumeM3(lines(1.2, 1.6))).toBe(2.8);
  });

  it('a line without a volume leaves no Σ at all', () => {
    expect(linesVolumeM3(lines(1.2, null))).toBeNull();
    // A zero is not a volume either — «0 m³» on a line is a blank cell.
    expect(linesVolumeM3(lines(1.2, 0))).toBeNull();
  });

  it('no lines is no Σ', () => {
    expect(linesVolumeM3([])).toBeNull();
  });

  it('rounds on the decimal, so 0.1 + 0.2 is 0.3', () => {
    expect(linesVolumeM3(lines(0.1, 0.2))).toBe(0.3);
    // Half-up at the thousandth, the column's scale.
    expect(linesVolumeM3(lines(0.0005, 1))).toBe(1.001);
    expect(roundM3(1.0005)).toBe(1.001);
  });

  it('a NaN is not a volume', () => {
    expect(linesVolumeM3(lines(1.2, Number.NaN))).toBeNull();
    expect(linesVolumeM3(lines(Number.NaN))).toBeNull();
  });
});

describe('volumeIsLinesSum — did the stored m³ come from the lines (K13)', () => {
  const lines = [{ volumeM3: 1.2 }, { volumeM3: 1.6 }];

  it('a stored total equal to the Σ reads «from the lines»', () => {
    expect(volumeIsLinesSum(2.8, lines)).toBe(true);
  });

  it('a stored total that differs does not', () => {
    expect(volumeIsLinesSum(5, lines)).toBe(false);
  });

  it('nothing stored is nothing to label', () => {
    expect(volumeIsLinesSum(null, lines)).toBe(false);
  });

  it('lines that cannot make a Σ label nothing either', () => {
    expect(volumeIsLinesSum(1.2, [{ volumeM3: 1.2 }, { volumeM3: null }])).toBe(false);
  });

  it('the workspace derives its flag from this rule, over every item', () => {
    // The one home for «did this m³ come from the lines» is `loadWorkspace`'s
    // field (K13); a second spelling beside it would be #513. Source shape,
    // because the field is read by round 2's packages and by nothing yet.
    const source = readFileSync('src/modules/wms/calc/workspace.ts', 'utf8');
    expect(source).toContain('volumeFromLines: volumeIsLinesSum(volumeM3, items)');
  });
});
