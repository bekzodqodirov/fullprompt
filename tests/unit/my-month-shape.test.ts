import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «Bu oy» on /profile is the person's OWN month and nothing else (0117). Two
 * shapes hold that: the loader takes the ACTOR and no id — so no caller can
 * hand it somebody else — and `MyMonth` carries no client, name or balance
 * field for a later edit to fill (#1188's «a type with no slot for it»).
 */
const source = readFileSync('src/modules/wms/staff/my-month.ts', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The top-level keys of `export interface MyMonth { … }`. */
function topKeys(): string[] {
  const start = source.indexOf('export interface MyMonth {');
  expect(start).toBeGreaterThan(-1);
  const keys: string[] = [];
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1) {
      const match = /^\s*(\w+)\??:/.exec(source.slice(i));
      if (match && /[\n{;]/.test(source[i - 1] ?? '\n')) keys.push(match[1]!);
    }
  }
  return [...new Set(keys)];
}

describe('MyMonth', () => {
  it('carries exactly the person’s own lines', () => {
    expect(topKeys().sort()).toEqual(
      ['incomeUsd', 'kpi', 'month', 'salary', 'salaryConverted', 'salaryUsd', 'upsale', 'work'].sort(),
    );
  });

  it('names no client, no balance, no other person', () => {
    const block = source.slice(source.indexOf('export interface MyMonth {'), source.indexOf('const round2'));
    expect(block).not.toMatch(/client|balance|sellerId|userId|name\b/i);
  });

  it('the loader takes the actor and no id', () => {
    expect(source).toMatch(/export async function myMonth\(actor: \{\s*id: string;\s*permissions: \{ has\(code: string\): boolean \};\s*\}\): Promise<MyMonth>/);
    expect(source).toContain('const userId = actor.id;');
  });
});
