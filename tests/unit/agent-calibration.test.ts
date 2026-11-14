import { describe, expect, it } from 'vitest';
import {
  AUTO_CATEGORIES,
  bandOf,
  calibrationCells,
  categoryVerdicts,
  cleanForAuto,
  wilsonLower,
  type CalibrationDraftRow,
} from '@/modules/wms/agent/calibration';
import { confidenceOf } from '@/modules/wms/agent/run';

/**
 * «80 %» as a number he can trust (#1625). The thresholds below are the
 * literal table the design states (docs/AI-SOTUVCHI.md §18.3), computed
 * outside the code: one-sided 95 % Wilson lower bounds with z = 1.645.
 */

describe('the lower bound', () => {
  it.each([
    [45, 50, true],
    [44, 50, false],
    [87, 100, true],
    [86, 100, false],
    [170, 200, true],
    [169, 200, false],
    // A raw 80 % is NOT «80 % sure»: 40 of 50 is as consistent with 70 %.
    [40, 50, false],
  ])('%i unchanged of %i decided clears 0.80: %s', (k, n, clears) => {
    expect((wilsonLower(k, n) ?? 0) >= 0.8).toBe(clears);
  });

  it('pinned values', () => {
    expect(wilsonLower(45, 50)).toBeCloseTo(0.8085, 4);
    expect(wilsonLower(44, 50)).toBeCloseTo(0.7843, 4);
    expect(wilsonLower(50, 50)).toBeCloseTo(0.9487, 4);
    expect(wilsonLower(0, 10)).toBeCloseTo(0, 6);
    expect(wilsonLower(0, 0)).toBeNull();
    expect(wilsonLower(3, 2)).toBeNull();
  });
});

describe('the model’s confidence as stored (#1625)', () => {
  it.each([
    [0.8, 0.8],
    [0.856, 0.86],
    [0, 0],
    [1, 1],
    // Not a 0-1 number: unknown, never clamped into a confident one.
    [85, null],
    [-0.1, null],
    [Number.NaN, null],
    ['0.9', null],
    [undefined, null],
  ])('%s → %s', (input, stored) => {
    expect(confidenceOf(input)).toBe(stored);
  });

  it('bands: a missing confidence is its own band, the edges belong upward', () => {
    expect(bandOf(null)).toBe('none');
    expect(bandOf(0.49)).toBe('<0.50');
    expect(bandOf(0.5)).toBe('0.50-0.69');
    expect(bandOf(0.79)).toBe('0.70-0.79');
    expect(bandOf(0.8)).toBe('0.80-0.89');
    expect(bandOf(0.9)).toBe('0.90+');
  });
});

const row = (patch: Partial<CalibrationDraftRow> = {}): CalibrationDraftRow => ({
  status: 'approved',
  kind: 'reply',
  edited: false,
  outboxStatus: 'sent',
  category: 'greeting',
  confidence: 0.9,
  blocked: false,
  needsOwner: false,
  warnings: 0,
  notes: 0,
  money: false,
  actions: [],
  autoSent: false,
  ownerTriggered: false,
  ...patch,
});

describe('what a stored draft says about auto-send (§18.3)', () => {
  it('a plain greeting is clean', () => {
    expect(cleanForAuto(row())).toBe(true);
    expect(cleanForAuto(row({ actions: ['set_followup'] }))).toBe(true);
  });

  it.each<[string, Partial<CalibrationDraftRow>]>([
    ['a price reply', { category: 'price' }],
    ['a complaint', { category: 'complaint' }],
    ['other', { category: 'other' }],
    ['no category', { category: null }],
    ['his typed price', { kind: 'price' }],
    ['blocked', { blocked: true }],
    ['a question for him', { needsOwner: true }],
    ['a warning', { warnings: 1 }],
    ['a card note', { notes: 1 }],
    ['money in it', { money: true }],
    ['a calculation sent', { actions: ['calc_submit'] }],
    ['a mute', { actions: ['set_followup', 'mute'] }],
  ])('never clean: %s', (_name, patch) => {
    expect(cleanForAuto(row(patch))).toBe(false);
  });

  it('the allowed categories never include price, complaint or other', () => {
    expect([...AUTO_CATEGORIES].sort()).toEqual(['faq', 'greeting', 'qualification', 'status']);
  });
});

describe('the table and the verdict', () => {
  it('cells count the page’s own way: an edit, a ❌ and his own reply are not «unchanged»; superseded and expired stay out', () => {
    const rows = [
      row(),
      row(),
      row({ edited: true }),
      row({ status: 'rejected', outboxStatus: null }),
      row({ status: 'taken_over', outboxStatus: null }),
      row({ status: 'superseded', outboxStatus: null }),
      row({ status: 'expired', outboxStatus: null }),
    ];
    const [cell] = calibrationCells(rows);
    expect(cell).toMatchObject({ category: 'greeting', band: '0.90+', clean: true, decided: 5, unchanged: 2 });
  });

  it('45 of 50 clean greetings at ≥ 0.80 is proven; 44 of 50 is not, and says how far it is', () => {
    const proven = [...Array.from({ length: 45 }, () => row()), ...Array.from({ length: 5 }, () => row({ edited: true }))];
    expect(categoryVerdicts(proven).find((v) => v.category === 'greeting')).toMatchObject({ decided: 50, unchanged: 45, proven: true });
    const short = [...Array.from({ length: 44 }, () => row()), ...Array.from({ length: 6 }, () => row({ edited: true }))];
    const v = categoryVerdicts(short).find((x) => x.category === 'greeting')!;
    expect(v.proven).toBe(false);
    expect(v.stillNeeded).toBeGreaterThan(0);
  });

  it('a draft below 0.80, or not clean, never counts toward its category', () => {
    const rows = [
      ...Array.from({ length: 50 }, () => row({ confidence: 0.79 })),
      ...Array.from({ length: 50 }, () => row({ warnings: 1 })),
      ...Array.from({ length: 50 }, () => row({ confidence: null })),
    ];
    expect(categoryVerdicts(rows).find((v) => v.category === 'greeting')).toMatchObject({ decided: 0, proven: false });
  });
});
