import { describe, expect, it } from 'vitest';
import { groupingListing, type GroupingGood } from '@/modules/wms/tnved/service';

/**
 * What the grouping model READS (docs/SAKKIZ-R2.md §7.5).
 *
 * The name alone was all it had, and a name is the weakest evidence there is
 * about a code: «Kurtka» is a jacket of WHAT. The line's weight, its volume,
 * its measure pair and its note («100% полиэстер») are what decide the
 * subheading — what a declarant reads. The listing is the one place those
 * reach the model, so the test reads the listing itself, every literal
 * written by hand.
 */
const good = (over: Partial<GroupingGood>): GroupingGood => ({
  name: 'Kurtka',
  quantity: null,
  unit: null,
  weightKg: null,
  volumeM3: null,
  measure: null,
  note: null,
  ...over,
});

describe('the grouping listing carries the line, not only its name', () => {
  it('weight, volume, measure and note, in that order, after the count', () => {
    const text = groupingListing([
      good({
        quantity: 300,
        unit: 'шт',
        weightKg: 150,
        volumeM3: 1.2,
        note: '100% полиэстер',
      }),
      good({ name: 'Kafel', measure: '120 m2', weightKg: 2400 }),
    ]);
    expect(text).toBe(
      ['0. Kurtka — 300 шт · 150 кг · 1.2 м³ · прим.: 100% полиэстер', '1. Kafel — 2400 кг · 120 m2'].join('\n'),
    );
  });

  it('a bare name stays a bare line — nothing invented for a line that states nothing', () => {
    expect(groupingListing([good({})])).toBe('0. Kurtka');
  });

  it('a long note is cut at 120 characters, and a note’s own newlines do not break the list', () => {
    const note = `${'a'.repeat(100)}\n${'b'.repeat(100)}`;
    const line = groupingListing([good({ note })]);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain(`прим.: ${'a'.repeat(100)} ${'b'.repeat(19)}…`);
  });

  it('figures read as a person writes them — no floating-point tails', () => {
    expect(groupingListing([good({ weightKg: 0.1 + 0.2, volumeM3: 1.23456 })])).toBe('0. Kurtka — 0.3 кг · 1.235 м³');
  });
});
