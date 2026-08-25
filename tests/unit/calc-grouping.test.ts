import { describe, expect, it } from 'vitest';
import {
  AI_BATCH_SIZE,
  groupMeasure,
  groupQuantity,
  mergeProposals,
  planBatches,
  type ProposedGroup,
} from '@/modules/wms/calc/grouping';

const proposed = (over: Partial<ProposedGroup> = {}): ProposedGroup => ({
  tnved_code: '8528520000',
  name_ru: 'Мониторы',
  item_indexes: [0],
  confidence: 'high',
  reasoning: 'экраны',
  duty_rate_pct: 10,
  ...over,
});

describe('planBatches', () => {
  it('slices a thousand goods into calls the model will accept', () => {
    expect(planBatches(1000)).toEqual([
      { offset: 0, count: AI_BATCH_SIZE },
      { offset: 200, count: 200 },
      { offset: 400, count: 200 },
      { offset: 600, count: 200 },
      { offset: 800, count: 200 },
    ]);
    expect(planBatches(250)).toEqual([
      { offset: 0, count: 200 },
      { offset: 200, count: 50 },
    ]);
    expect(planBatches(0)).toEqual([]);
  });
});

describe('mergeProposals', () => {
  const seqs = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);

  it('adds each batch’s offset back — the second batch numbers from zero too', () => {
    // The positional-zip shape with money on the end: without the offset the
    // second call's groups would claim the FIRST batch's goods.
    const groups = mergeProposals(
      [
        { offset: 0, groups: [proposed({ tnved_code: '1111111111', item_indexes: [0, 1] })] },
        { offset: 2, groups: [proposed({ tnved_code: '2222222222', item_indexes: [0, 1] })] },
      ],
      seqs(4),
    );
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.tnvedCode === '1111111111')!.itemSeqs).toEqual([1, 2]);
    expect(groups.find((g) => g.tnvedCode === '2222222222')!.itemSeqs).toEqual([3, 4]);
  });

  it('merges the same code across batches and keeps the WORST confidence', () => {
    const groups = mergeProposals(
      [
        { offset: 0, groups: [proposed({ item_indexes: [0], confidence: 'high' })] },
        { offset: 2, groups: [proposed({ item_indexes: [0], confidence: 'low' })] },
      ],
      seqs(4),
    );
    const merged = groups.find((g) => g.tnvedCode === '8528520000')!;
    expect(merged.itemSeqs).toEqual([1, 3]);
    expect(merged.confidence).toBe('low');
  });

  it('a batch that failed costs its own goods, not the whole file', () => {
    const groups = mergeProposals(
      [
        { offset: 0, groups: [proposed({ item_indexes: [0, 1] })] },
        { offset: 2, groups: null },
      ],
      seqs(4),
    );
    expect(groups.find((g) => g.tnvedCode === '8528520000')!.itemSeqs).toEqual([1, 2]);
    // The failed batch's two goods are still on the screen, unclassified.
    const orphans = groups.filter((g) => g.tnvedCode === null);
    expect(orphans.flatMap((g) => g.itemSeqs)).toEqual([3, 4]);
    expect(orphans.every((g) => g.confidence === 'low')).toBe(true);
  });

  it('an item no group claimed is still cargo', () => {
    const groups = mergeProposals([{ offset: 0, groups: [proposed({ item_indexes: [0] })] }], seqs(3));
    expect(groups.flatMap((g) => g.itemSeqs).sort()).toEqual([1, 2, 3]);
  });

  it('claims an item once, however many groups ask for it', () => {
    const groups = mergeProposals(
      [
        {
          offset: 0,
          groups: [
            proposed({ tnved_code: '1111111111', item_indexes: [0, 1] }),
            proposed({ tnved_code: '2222222222', item_indexes: [1] }),
          ],
        },
      ],
      seqs(2),
    );
    expect(groups.flatMap((g) => g.itemSeqs).sort()).toEqual([1, 2]);
  });

  it('two blanked codes do not become one group because both are empty', () => {
    const groups = mergeProposals(
      [
        {
          offset: 0,
          groups: [
            proposed({ tnved_code: '', name_ru: 'Непонятно A', item_indexes: [0], confidence: 'low' }),
            proposed({ tnved_code: '', name_ru: 'Непонятно B', item_indexes: [1], confidence: 'low' }),
          ],
        },
      ],
      seqs(2),
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.tnvedCode === null)).toBe(true);
  });

  it('records the model’s duty estimate without ever making it a rate', () => {
    const [g] = mergeProposals([{ offset: 0, groups: [proposed({ duty_rate_pct: 15 })] }], [1]);
    expect(g!.aiDutyPct).toBe(15);
    expect(g!.aiProposed).toBe(true);
    // Nothing here carries duty_pct: the group is born with no rate at all.
    expect(Object.keys(g!)).not.toContain('dutyPct');
  });
});

describe('groupQuantity', () => {
  it('mixed units mean no quantity — 3 rolls and 40 pieces is 43 of nothing', () => {
    expect(groupQuantity([
      { quantity: 3, unit: 'rulon' },
      { quantity: 40, unit: 'dona' },
    ])).toEqual({ quantity: null, unit: null });
  });

  it('sums one unit’s worth', () => {
    expect(groupQuantity([
      { quantity: 3, unit: 'dona' },
      { quantity: 40, unit: 'DONA' },
    ])).toEqual({ quantity: 43, unit: 'dona' });
  });

  it('no quantity anywhere is null, never zero', () => {
    expect(groupQuantity([{ quantity: null, unit: 'dona' }]).quantity).toBeNull();
  });
});

describe('groupMeasure', () => {
  it('is null when not one item carries the measure', () => {
    expect(groupMeasure([null, null])).toBeNull();
    expect(groupMeasure([1.5, null, 2.25])).toBe(3.75);
  });
});
