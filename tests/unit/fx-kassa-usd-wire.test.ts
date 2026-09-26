import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F1 (0103, the owner's Q13/Q18): a kassa-paid cost carries its payment in
 * dollars BESIDE its native kassa amount — every writer of `accountAmount`
 * must write `accountAmountUsd` and `accountRateUsed` in the same statement,
 * or a door written next month leaves a kassa whose dollars nobody froze
 * (the #896 provenance fence, one column over). And every transfer insert
 * names its to-side dollars. DERIVED from `src/`, comments stripped first
 * (#725), so a new writer is found, not remembered.
 */
const strip = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** The balanced `{ … }` that starts at `open`. */
function objectAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

const SOURCES = files('src').map((path) => ({ path, text: strip(readFileSync(path, 'utf8')) }));

describe('F1 — the kassa dollars travel with the kassa amount', () => {
  it('every .set({…}) / .values({…}) naming accountAmount also names accountAmountUsd and accountRateUsed', () => {
    const writers: string[] = [];
    for (const { path, text } of SOURCES) {
      if (path.includes('/db/schema/')) continue;
      for (const match of text.matchAll(/\.(set|values)\(\s*\{/g)) {
        const body = objectAt(text, match.index! + match[0].length - 1);
        if (!/\baccountAmount\s*:/.test(body)) continue;
        writers.push(path);
        expect(body, `${path}: accountAmount without accountAmountUsd`).toMatch(/\baccountAmountUsd\s*:/);
        expect(body, `${path}: accountAmount without accountRateUsed`).toMatch(/\baccountRateUsed\s*:/);
      }
    }
    // Anchored on the writers it must find (#720): an empty set is a fence
    // that matched nothing.
    for (const expected of ['costing/service.ts', 'accounting/cost-merge.ts']) {
      expect(writers.some((path) => path.endsWith(expected)), expected).toBe(true);
    }
  });

  it('every insert into account_transfers names amountToUsd', () => {
    let found = 0;
    for (const { path, text } of SOURCES) {
      for (const match of text.matchAll(/\.insert\(accountTransfers\)\s*\.values\(\s*\{/g)) {
        found += 1;
        const body = objectAt(text, match.index! + match[0].length - 1);
        expect(body, path).toMatch(/\bamountToUsd\s*:/);
      }
    }
    expect(found).toBeGreaterThan(0);
  });
});
