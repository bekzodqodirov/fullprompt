import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

describe('an id is a uuid or nothing — a uuid-SHAPED non-uuid is dropped, never sent to postgres', () => {
  // The loose shape /^[0-9a-f]{8}-[0-9a-f-]{27}$/ admitted this, and `::uuid`
  // refused it as 22P02: a 500 on a hand-typed link instead of a dropped filter.
  const FAKE = 'aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const REAL = '01A1151C-2D34-708B-AC6D-837368C4304F';
  it('the board drops it as a source and keeps a real one', () => {
    expect(readBoardFilters({ manba: FAKE }).sourceId).toBeUndefined();
    expect(readBoardFilters({ manba: REAL }).sourceId).toBe(REAL);
  });
});

describe('the loose uuid shape is gone from src', () => {
  // Derived over every source file, so a fifth copy fails here the day it lands
  // (the lead board's `hodim`, the analytics pickers, the source filter, the deal board).
  const LOOSE = '[0-9a-f]{8}-[0-9a-f-]{27}';
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  it('no .ts/.tsx file under src carries it', () => {
    const offenders = files('src').filter((path) => readFileSync(path, 'utf8').includes(LOOSE));
    expect(offenders).toEqual([]);
  });
});

describe('the lead board asks «all» once', () => {
  it('every echo of the scope reads scopeAll, which needs view_all', () => {
    const page = readFileSync('src/app/(protected)/crm/page.tsx', 'utf8');
    expect(page).toContain("const scopeAll = seesAll && params.scope === 'all';");
    // The definition is the only place the raw param is compared.
    expect(page.split("params.scope === 'all'").length - 1).toBe(1);
  });
});

