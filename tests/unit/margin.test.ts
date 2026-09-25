import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { marginPct } from '@/modules/wms/accounting/margin';

/**
 * U-K5 (0105): one margin rule. Revenue can be NEGATIVE since a compensation
 * for lost cargo is a price taken back — a client whose compensation exceeds
 * his prices, a month that paid back more than it charged — and every screen's
 * old `revenue ? profit / revenue : 0` printed −$1,300 over −$500 as «+260 %».
 */
describe('marginPct', () => {
  it('a margin over positive revenue, to one decimal', () => {
    expect(marginPct(250, 1000)).toBe(25);
    expect(marginPct(-100, 1000)).toBe(-10);
    expect(marginPct(1, 3)).toBe(33.3);
  });

  it('no margin over revenue that is zero or negative — the screens print «—»', () => {
    expect(marginPct(0, 0)).toBeNull();
    expect(marginPct(-1300, -500)).toBeNull();
    expect(marginPct(10, 0.009)).toBeNull();
  });
});

const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'migrations' ? [] : files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('U-K5 — nothing divides by revenue but marginPct', () => {
  it('no file in src/ restates the margin', () => {
    // A division is formatted ` / ` (prettier); a route like '/x/revenue' is not.
    const offenders = files('src')
      .filter((path) => path !== 'src/modules/wms/accounting/margin.ts')
      .filter((path) => /\s\/\s+\(?[a-zA-Z.]*[Rr]evenue/.test(strip(readFileSync(path, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
