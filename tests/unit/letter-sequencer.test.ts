import { describe, expect, it } from 'vitest';
import {
  computeNextLetters,
  letterAt,
  TOTAL_POSITIONS,
} from '@/modules/wms/letters';

const noSkip = { blacklist: new Set<string>() };

describe('letterAt (A…Z, AA…ZZ ordering, spec 5.3)', () => {
  it('maps single letters', () => {
    expect(letterAt(0)).toBe('A');
    expect(letterAt(3)).toBe('D');
    expect(letterAt(25)).toBe('Z');
  });

  it('maps double letters', () => {
    expect(letterAt(26)).toBe('AA');
    expect(letterAt(27)).toBe('AB');
    expect(letterAt(51)).toBe('AZ');
    expect(letterAt(52)).toBe('BA');
    expect(letterAt(TOTAL_POSITIONS - 1)).toBe('ZZ');
  });
});

describe('computeNextLetters (spec §20 acceptance tests 1–3)', () => {
  it('test 1: letters continue across receipts — after C comes D, E', () => {
    // Position 3 = "D is next" (A,B,C consumed).
    const { letters, nextState } = computeNextLetters({ position: 3, cycleNo: 1 }, 2, noSkip);
    expect(letters).toEqual([
      { letter: 'D', cycleNo: 1 },
      { letter: 'E', cycleNo: 1 },
    ]);
    expect(nextState).toEqual({ position: 5, cycleNo: 1 });
  });

  it('test 2: blacklist skip — AM is skipped, AN assigned', () => {
    const amPosition = 26 + 12; // AM
    const { letters } = computeNextLetters(
      { position: amPosition, cycleNo: 1 },
      1,
      { blacklist: new Set(['AM', 'XU']) },
    );
    expect(letters).toEqual([{ letter: 'AN', cycleNo: 1 }]);
  });

  it('test 2b: XU is skipped too', () => {
    const xuPosition = 26 + 23 * 26 + 20; // XU
    expect(letterAt(xuPosition)).toBe('XU');
    const { letters } = computeNextLetters(
      { position: xuPosition, cycleNo: 1 },
      1,
      { blacklist: new Set(['AM', 'XU']) },
    );
    expect(letters).toEqual([{ letter: 'XV', cycleNo: 1 }]);
  });

  it('test 3: ZZ wrap — after ZZ comes A with cycle_no bumped', () => {
    const { letters, nextState } = computeNextLetters(
      { position: TOTAL_POSITIONS - 1, cycleNo: 1 },
      2,
      noSkip,
    );
    expect(letters).toEqual([
      { letter: 'ZZ', cycleNo: 1 },
      { letter: 'A', cycleNo: 2 },
    ]);
    expect(nextState).toEqual({ position: 1, cycleNo: 2 });
  });

  it('wrap combined with blacklist at the boundary', () => {
    const { letters } = computeNextLetters(
      { position: TOTAL_POSITIONS, cycleNo: 1 },
      1,
      { blacklist: new Set(['A']) },
    );
    expect(letters).toEqual([{ letter: 'B', cycleNo: 2 }]);
  });

  it('ambiguous letters I and O skipped when the option is on', () => {
    const { letters } = computeNextLetters({ position: 7, cycleNo: 1 }, 3, {
      blacklist: new Set(),
      excludeAmbiguous: true,
    });
    // H(7), skip I(8), J, K
    expect(letters.map((l) => l.letter)).toEqual(['H', 'J', 'K']);
  });

  it('ambiguous letters kept by default', () => {
    const { letters } = computeNextLetters({ position: 8, cycleNo: 1 }, 1, noSkip);
    expect(letters).toEqual([{ letter: 'I', cycleNo: 1 }]);
  });

  it('throws if the blacklist would consume every letter (misconfiguration guard)', () => {
    const everything = new Set<string>();
    for (let i = 0; i < TOTAL_POSITIONS; i++) everything.add(letterAt(i));
    expect(() =>
      computeNextLetters({ position: 0, cycleNo: 1 }, 1, { blacklist: everything }),
    ).toThrow();
  });
});
