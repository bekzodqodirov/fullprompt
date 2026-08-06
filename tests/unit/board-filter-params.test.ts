import { describe, expect, it } from 'vitest';
import { readBoardFilters } from '@/components/list/board-filter';

/**
 * The URL's filter answers, checked rather than trusted (round 71).
 *
 * These values reach SQL fragments, and a URL param is a forged post (#514):
 * the parser is the fence, so its refusals are the tests that matter.
 */
describe('what the board reads out of its address bar', () => {
  it('parses the honest case', () => {
    const f = readBoardFilters({
      narx_min: '250',
      narx_max: '1 000'.replace(' ', ''),
      kub_min: '1,5',
      dan: '2026-08-01',
      gacha: '2026-08-06',
      lenta: 'paxta',
    });
    expect(f.amountMin).toBe(250);
    expect(f.amountMax).toBe(1000);
    // A decimal comma is how half the office types — it is a value, not a typo.
    expect(f.volMin).toBe(1.5);
    expect(f.createdFrom).toBe('2026-08-01');
    expect(f.createdTo).toBe('2026-08-06');
    expect(f.lenta).toBe('paxta');
  });

  it('refuses what is not a number, a date, or an id', () => {
    const f = readBoardFilters({
      narx_min: 'qimmat',
      kg_max: '-5',
      dan: '01.08.2026',
      manba: 'DROP TABLE',
    });
    expect(f.amountMin).toBeUndefined();
    expect(f.kgMax).toBeUndefined();
    expect(f.createdFrom).toBeUndefined();
    expect(f.sourceId).toBeUndefined();
  });

  it('echoes back only what was actually set', () => {
    const f = readBoardFilters({ narx_min: '100', kub_min: '', scope: 'all' });
    expect(Object.keys(f.raw)).toEqual(['narx_min']);
  });

  it('takes the first value when the URL repeats a key', () => {
    const f = readBoardFilters({ narx_min: ['100', '900'] });
    expect(f.amountMin).toBe(100);
  });
});
