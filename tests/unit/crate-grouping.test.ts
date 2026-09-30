import { describe, expect, it } from 'vitest';
import {
  crateMeasure,
  groupCrates,
  placesOf,
  rowKey,
  seqRanges,
  type CratePart,
} from '@/modules/wms/inventory/crate-grouping';

const NO_DIMS = { lengthCm: null, widthCm: null, heightCm: null, weightKg: null };

function part(over: Partial<CratePart> & Pick<CratePart, 'crateId' | 'lotId' | 'n'>): CratePart {
  return {
    code: `CR-${over.crateId}`,
    kind: 'yashik',
    warehouseId: 'wh',
    letter: 'A',
    lotCode: `GS1-${over.letter ?? 'A'}`,
    seqs: Array.from({ length: over.n }, (_, i) => i + 1),
    kg: over.n * 10,
    m3: over.n,
    dims: NO_DIMS,
    ...over,
  };
}

describe('seqRanges — the label numbers as runs', () => {
  it('folds consecutive numbers and keeps singles', () => {
    expect(seqRanges([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe('1–10');
    expect(seqRanges([21, 22, 23, 24, 25, 26, 30])).toBe('21–26, 30');
    expect(seqRanges([5])).toBe('5');
    expect(seqRanges([])).toBe('');
  });

  it('sorts and de-duplicates rather than trust its caller', () => {
    expect(seqRanges([3, 1, 2, 2, 7, 9, 8])).toBe('1–3, 7–9');
  });

  it('two numbers apart are two runs, not a range', () => {
    expect(seqRanges([1, 3])).toBe('1, 3');
    expect(seqRanges([1, 2, 4, 5])).toBe('1–2, 4–5');
  });
});

describe('crateMeasure — the size against the goods, as printed', () => {
  it('flags a crate whose contents exceed its measured volume or weight', () => {
    const dims = { lengthCm: 100, widthCm: 100, heightCm: 100, weightKg: '500' };
    expect(crateMeasure(dims, 40, 4)).toMatchObject({ statedM3: 1, statedKg: 500, over: true });
    expect(crateMeasure(dims, 501, 0.5).over).toBe(true);
    expect(crateMeasure(dims, 499, 0.5).over).toBe(false);
  });

  it('compares the PRINTED values — never a ⚠ between two numbers that read the same', () => {
    const dims = { lengthCm: 100, widthCm: 100, heightCm: 100, weightKg: '500' };
    // 1.004 m³ prints «1.00», 500.4 kg prints «500»: identical on the screen.
    expect(crateMeasure(dims, 500.4, 1.004)).toMatchObject({ m3: 1, kg: 500, over: false });
  });

  it('a missing or non-positive measure is unmeasured', () => {
    expect(crateMeasure(NO_DIMS, 900, 90)).toMatchObject({
      statedM3: null,
      statedKg: null,
      over: false,
    });
    const zero = { lengthCm: 0, widthCm: 100, heightCm: 100, weightKg: '0' };
    expect(crateMeasure(zero, 900, 90)).toMatchObject({
      statedM3: null,
      statedKg: null,
      over: false,
    });
  });
});

describe('groupCrates — which row counts a crate as a place', () => {
  it('a single-lot crate belongs to its lot', () => {
    const { byRow, crates } = groupCrates([part({ crateId: 'c1', lotId: 'L1', n: 10 })]);
    const row = byRow.get(rowKey('L1', 'wh'))!;
    expect(row).toMatchObject({ crated: 10, owned: 1 });
    expect(row.crates[0]).toMatchObject({ owned: true, ownerCode: null, others: [], total: 10 });
    expect(crates).toEqual([{ id: 'c1', code: 'CR-c1', over: false }]);
  });

  it('a mixed crate is owned by the lot with most cartons inside', () => {
    const { byRow } = groupCrates([
      part({ crateId: 'c1', lotId: 'L1', letter: 'A', lotCode: 'GS1-A', n: 2 }),
      part({ crateId: 'c1', lotId: 'L2', letter: 'B', lotCode: 'GS1-B', n: 5 }),
    ]);
    const a = byRow.get(rowKey('L1', 'wh'))!;
    const b = byRow.get(rowKey('L2', 'wh'))!;
    expect(a).toMatchObject({ crated: 2, owned: 0 });
    expect(b).toMatchObject({ crated: 5, owned: 1 });
    expect(a.crates[0]).toMatchObject({ owned: false, ownerCode: 'GS1-B', total: 7, unseen: 0 });
    expect(a.crates[0]!.others).toEqual([{ code: 'GS1-B', n: 5 }]);
    expect(b.crates[0]!.others).toEqual([{ code: 'GS1-A', n: 2 }]);
  });

  it('a tie goes to the lower letter, then to the lot id — the same answer twice', () => {
    const tie = groupCrates([
      part({ crateId: 'c1', lotId: 'L9', letter: 'B', n: 3 }),
      part({ crateId: 'c1', lotId: 'L1', letter: 'A', n: 3 }),
    ]);
    expect(tie.byRow.get(rowKey('L1', 'wh'))!.owned).toBe(1);
    expect(tie.byRow.get(rowKey('L9', 'wh'))!.owned).toBe(0);
    // Same letter (two prixods of one client, both «A»): the lot id decides,
    // whichever order the query happened to return them in.
    const forward = groupCrates([
      part({ crateId: 'c1', lotId: 'L2', letter: 'A', n: 3 }),
      part({ crateId: 'c1', lotId: 'L3', letter: 'A', n: 3 }),
    ]);
    const backward = groupCrates([
      part({ crateId: 'c1', lotId: 'L3', letter: 'A', n: 3 }),
      part({ crateId: 'c1', lotId: 'L2', letter: 'A', n: 3 }),
    ]);
    expect(forward.byRow.get(rowKey('L2', 'wh'))!.owned).toBe(1);
    expect(backward.byRow.get(rowKey('L2', 'wh'))!.owned).toBe(1);
  });

  it('every crate is owned exactly once, so the places add up', () => {
    const parts = [
      part({ crateId: 'c1', lotId: 'L1', letter: 'A', n: 4 }),
      part({ crateId: 'c1', lotId: 'L2', letter: 'B', n: 4 }),
      part({ crateId: 'c2', lotId: 'L2', letter: 'B', n: 6 }),
      part({ crateId: 'c3', lotId: 'L1', letter: 'A', n: 1 }),
    ];
    const { byRow, crates } = groupCrates(parts);
    const owned = [...byRow.values()].reduce((sum, row) => sum + row.owned, 0);
    expect(owned).toBe(crates.length);
    // L1: 5 crated + 3 loose = 8 cartons, owns c1 (tie → A) and c3 → 3 + 2 = 5.
    expect(placesOf(8, byRow.get(rowKey('L1', 'wh')))).toBe(5);
    // L2: 10 crated, no loose, owns c2 → 1.
    expect(placesOf(10, byRow.get(rowKey('L2', 'wh')))).toBe(1);
  });

  it('judges the ⚠ on the WHOLE crate when a search showed only part of it', () => {
    const dims = { lengthCm: 200, widthCm: 100, heightCm: 100, weightKg: null };
    const shown = [part({ crateId: 'c1', lotId: 'L1', n: 1, dims })];
    expect(groupCrates(shown).crates[0]!.over).toBe(false);
    const whole = new Map([['c1', { total: 3, kg: 30, m3: 3 }]]);
    const judged = groupCrates(shown, whole);
    expect(judged.crates[0]!.over).toBe(true);
    expect(judged.byRow.get(rowKey('L1', 'wh'))!.crates[0]).toMatchObject({
      n: 1,
      total: 3,
      unseen: 2,
    });
  });

  it('an overfull crate leads its row, the rest in label order', () => {
    const small = { lengthCm: 10, widthCm: 10, heightCm: 10, weightKg: null };
    const { byRow } = groupCrates([
      part({ crateId: 'c1', code: 'CR-1', lotId: 'L1', n: 2 }),
      part({ crateId: 'c3', code: 'CR-3', lotId: 'L1', n: 2, dims: small }),
      part({ crateId: 'c2', code: 'CR-2', lotId: 'L1', n: 2 }),
    ]);
    expect(byRow.get(rowKey('L1', 'wh'))!.crates.map((crate) => crate.code)).toEqual([
      'CR-3',
      'CR-1',
      'CR-2',
    ]);
  });

  it('keys rows by lot AND warehouse', () => {
    const { byRow } = groupCrates([
      part({ crateId: 'c1', lotId: 'L1', warehouseId: 'yw', n: 2 }),
      part({ crateId: 'c2', lotId: 'L1', warehouseId: 'ka', n: 3 }),
    ]);
    expect(byRow.get(rowKey('L1', 'yw'))!.crated).toBe(2);
    expect(byRow.get(rowKey('L1', 'ka'))!.crated).toBe(3);
  });
});

describe('placesOf', () => {
  it('a row with nothing crated is its carton count', () => {
    expect(placesOf(100, undefined)).toBe(100);
  });

  it('his example: 100 cartons packed ten to a crate are ten places', () => {
    const parts = Array.from({ length: 10 }, (_, i) =>
      part({ crateId: `c${i}`, lotId: 'L1', n: 10 }),
    );
    expect(placesOf(100, groupCrates(parts).byRow.get(rowKey('L1', 'wh')))).toBe(10);
  });

  it('seven crates and thirty loose cartons are thirty-seven places', () => {
    const parts = Array.from({ length: 7 }, (_, i) =>
      part({ crateId: `c${i}`, lotId: 'L1', n: 10 }),
    );
    expect(placesOf(100, groupCrates(parts).byRow.get(rowKey('L1', 'wh')))).toBe(37);
  });
});
