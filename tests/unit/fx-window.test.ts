import { describe, expect, it } from 'vitest';
import { fxWindow } from '@/modules/wms/costing/fx-window';
import { isBusyError } from '@/modules/wms/costing/fx-reprice';

/**
 * U2 (0103, design §5.6.2): the dates a saved rate governs — `rateFor`'s rule
 * turned around, including its fallback (a day before the earliest rate reads
 * the earliest one). And E13's half that needs no database: which refusals
 * the save answers «boshqa o'zgarish ketayotgan edi — qaytadan bosing».
 */
describe('fxWindow', () => {
  const dates = ['1613-01-01', '1613-06-01', '1613-09-25'];

  it('a middle date governs [D, next)', () => {
    expect(fxWindow(dates, '1613-07-10')).toEqual({ from: '1613-07-10', to: '1613-09-25' });
  });

  it('a new earliest date also governs every date before it', () => {
    expect(fxWindow(dates, '1612-12-01')).toEqual({ from: null, to: '1613-01-01' });
  });

  it('the latest date runs to the end', () => {
    expect(fxWindow(dates, '1613-10-01')).toEqual({ from: '1613-10-01', to: null });
  });

  it('a correction of an existing date has the same window as a new row there', () => {
    expect(fxWindow(dates, '1613-06-01')).toEqual({ from: '1613-06-01', to: '1613-09-25' });
    expect(fxWindow(dates.filter((d) => d !== '1613-06-01'), '1613-06-01')).toEqual({
      from: '1613-06-01',
      to: '1613-09-25',
    });
    expect(fxWindow(['1613-01-01'], '1613-01-01')).toEqual({ from: null, to: null });
  });
});

describe('isBusyError', () => {
  it('a deadlock, a serialisation failure and a lock timeout are «busy»; anything else is not', () => {
    for (const code of ['40P01', '40001', '55P03']) expect(isBusyError({ code })).toBe(true);
    for (const value of [{ code: '23505' }, new Error('x'), null, undefined]) expect(isBusyError(value)).toBe(false);
  });
});
