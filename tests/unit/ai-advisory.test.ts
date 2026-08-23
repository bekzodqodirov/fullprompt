import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The model's opinion may never become a sealed price (docs/VED.md law 1).
 *
 * The rule is enforced three ways and all three are cheap to lose in an
 * ordinary refactor, so all three are pinned here as SOURCE SHAPE — the
 * behaviour is identical with or without them right up until the day
 * somebody's price is wrong and nobody can say why.
 *
 * 1. `pricing.ts` — the arithmetic — cannot name an `ai` anything.
 * 2. The seal writer reads no `ai_*` value into a money column.
 * 3. The database refuses: `rate_source` and `baza_source` allow only
 *    'dictionary' and 'typed', so a prefill has nowhere to land.
 *
 * Comments are stripped before every assertion (#725): a rule that trips on
 * the sentence explaining it is a rule that gets deleted.
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The balanced `(...)` following a marker — a call's arguments, verbatim. */
function block(source: string, marker: string): string {
  const start = source.indexOf(marker) + marker.length;
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    if (source[i] === ')') depth -= 1;
    if (depth === 0) return source.slice(start, i);
  }
  throw new Error(`unbalanced: ${marker}`);
}

/** One function declaration, up to the next top-level `export`. */
function fn(source: string, marker: string): string {
  const start = source.indexOf(marker);
  const next = source.indexOf('\nexport ', start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('the arithmetic cannot reach the model', () => {
  it('pricing.ts mentions no ai identifier at all', () => {
    const source = read('src/modules/wms/calc/pricing.ts');
    expect(source).not.toMatch(/\bai[A-Z]\w*/);
    expect(source).not.toMatch(/ai_\w+/);
  });

  it('the row the seal writes carries only ai COUNTS, never an amount', () => {
    const source = read('src/modules/wms/calc/workspace.ts');
    const values = block(source, 'insert(calcVersions).values(');
    const mentions = new Set(values.match(/ai[A-Z]\w*/g) ?? []);
    // Two counters, both for phase E's «confirmed over a warning» list. A
    // rate, a baza or an amount named `ai…` here would be the model pricing.
    expect(mentions).toEqual(new Set(['aiGroupsSealed']));
  });

  it('a proposal lands nothing in a rate or baza column', () => {
    const source = read('src/modules/wms/calc/workspace.ts');
    const apply = fn(source, 'export async function applyProposal');
    for (const column of ['dutyPct:', 'vatPct:', 'feeUsd:', 'bazaUsd:', 'rateSource:']) {
      expect(apply, `applyProposal must not write ${column}`).not.toContain(column);
    }
    // …and the estimate IS recorded, in the column nothing multiplies.
    expect(apply).toContain('aiDutyPct:');
  });
});

describe('the database refuses too', () => {
  const migration = readFileSync(
    'src/modules/platform/db/migrations/0086_calc_pricing.sql',
    'utf8',
  );

  it("'ai' is not a legal source for a rate or a baza", () => {
    for (const check of ['calc_groups_rate_source_check', 'calc_items_baza_source_check']) {
      const line = migration.slice(migration.indexOf(check));
      const clause = line.slice(0, line.indexOf('\n', line.indexOf('IN (')) + 1);
      expect(clause).toContain("'dictionary'");
      expect(clause).toContain("'typed'");
      expect(clause).not.toContain("'ai'");
    }
  });
});
