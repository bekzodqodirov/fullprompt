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
    // COUNTS, all three of them. A rate, a baza or an amount named `ai…`
    // here would be the model pricing, and that is what this asserts —
    // widened deliberately in phase E1, which added `aiBlindGroups` (how many
    // groups were confirmed with the model's low-confidence guess untouched)
    // and `aiRateTakenGroups` (how many carried the model's own duty rate to
    // the seal). Both are integers derived from `calc_groups`; neither is
    // multiplied by anything.
    //
    // If this ever needs widening again, widen the SET. Do not loosen the
    // regex and do not rename a column to dodge it: this and the two
    // assertions around it are law 1's only enforcement in code, and the
    // tempting fix when they all go red at once is to delete the fence.
    expect(mentions).toEqual(
      new Set(['aiGroupsSealed', 'aiBlindGroups', 'aiRateTakenGroups']),
    );
  });

  it('a proposal lands nothing in a rate or baza column', () => {
    const source = read('src/modules/wms/calc/workspace.ts');
    const apply = fn(source, 'export async function applyProposal');
    for (const column of ['dutyPct:', 'vatPct:', 'feeUsd:', 'bazaUsd:', 'rateSource:']) {
      expect(apply, `applyProposal must not write ${column}`).not.toContain(column);
    }
    // …and the estimate IS recorded, in the column nothing multiplies.
    expect(apply).toContain('aiDutyPct:');
    // Phase E1 added `ai_proposal`, which keeps the model's own words whole.
    // Its duty key is spelled `aiDutyPct` for exactly the reason the loop
    // above exists: a payload key spelled `dutyPct` would read as the model
    // writing a rate, and this assertion is what stops it being spelled that
    // way by accident.
    expect(apply).toContain('aiProposal:');
  });
});

describe('the AI VED hodimi picks a row, never a price', () => {
  // Sub-round B lets the model work a whole job unattended, which puts law 1
  // at its narrowest: the ONE place a model's output travels toward a money
  // column. The rule is that it answers with an INDEX into real declarations
  // somebody filed, and the number is re-read from the file by `saveTable`.

  it('the answer the model may give carries no amount at all', () => {
    const source = read('src/modules/wms/calc/prefill-ai.ts');
    // Both schemas — the one the model is TOLD and the one its answer is
    // PARSED by — name the same three keys. Each slice asserts it found
    // something first: a marker that has been renamed must fail loudly, not
    // pass over an empty string.
    const zodAt = source.indexOf('const picksSchema');
    expect(zodAt, 'picksSchema has been renamed — re-anchor this fence').toBeGreaterThan(-1);
    const wireAt = source.indexOf('type: \'json_schema\'');
    expect(wireAt, 'the output schema has moved — re-anchor this fence').toBeGreaterThan(-1);
    const shapes = [
      source.slice(zodAt, source.indexOf('export interface PickRequest')),
      source.slice(wireAt, source.indexOf('messages: [', wireAt)),
    ];
    for (const shape of shapes) {
      expect(shape).toContain('candidate');
      expect(shape).toContain('reason');
      // A fourth key called anything price-shaped would be the model quoting.
      for (const money of ['price', 'usd', 'amount', 'baza', 'summa']) {
        expect(shape.toLowerCase(), `the pick schema must not offer ${money}`).not.toContain(money);
      }
    }
    // …and what is handed back to the caller is the same three keys. The
    // candidates ARE read for the listing shown to the model — showing a
    // filed declaration is not the model producing a number — so the
    // assertion is about the RETURN, not about the file mentioning a price.
    for (const push of source.match(/out\.push\(\{[^}]*\}\)/g) ?? []) {
      expect(push).toMatch(/^out\.push\(\{\s*seq:[^}]*candidate:[^}]*reason:[^}]*\}\)$/s);
    }
  });

  it('the prefill writes no provenance of its own', () => {
    const source = read('src/modules/wms/calc/prefill.ts');
    // `baza_source` is `saveTable`'s to decide, and it decides 'import'
    // BECAUSE an `importRowId` was posted. A prefill that named the source
    // itself would be a second writer, and the only value it could invent
    // is the one 0094 refuses.
    expect(source).not.toContain('bazaSource');
    expect(source).not.toContain('rateSource');
    // The row id is what makes the price the FILE's. Without it the number
    // posted here is stored as somebody's typing — measured, red-proven.
    // Anchored INSIDE the pick: 0096 added a second push in the memory pass,
    // which posts a code and no price at all, and a file-wide `indexOf` would
    // have silently started asserting about that one instead.
    const picker = source.slice(source.indexOf('async function pickBazas'));
    expect(picker.length, 'pickBazas has been renamed — re-anchor this fence').toBeGreaterThan(0);
    const edit = block(picker, 'edits.push(');
    expect(edit).toContain('importRowId: chosen.id');
    expect(edit).toContain('bazaUsd: chosen.pricePerUnitUsd');
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

  // 0094 REPLACES the baza check to admit 'import' — the quarterly customs
  // dump. That is a declaration somebody filed, not the model's opinion, and
  // the fence has to follow the constraint that is actually in force or it
  // goes on guarding a rule 0094 has already rewritten. The list is asserted
  // WHOLE, so a fourth value cannot slip in beside it.
  it("0094 widens the baza source to the import and still refuses 'ai'", () => {
    const later = readFileSync(
      'src/modules/platform/db/migrations/0094_customs_import.sql',
      'utf8',
    );
    const at = later.lastIndexOf('calc_items_baza_source_check');
    expect(at).toBeGreaterThan(-1);
    const clause = later.slice(at, later.indexOf(';', at));
    expect(clause).toContain("'dictionary'");
    expect(clause).toContain("'typed'");
    expect(clause).toContain("'import'");
    expect(clause).not.toContain("'ai'");
    expect(clause.match(/'[a-z_]+'/g)).toEqual(["'dictionary'", "'typed'", "'import'"]);
  });

  // 0096 replaces it once more, for 'memory' — a price a VED person
  // CONFIRMED and SEALED on an earlier job of ours. That is the strongest of
  // the machine's three sources and still not the model's opinion; the list
  // is asserted WHOLE for the same reason, and the fence must follow the
  // constraint actually in force.
  it("0096 widens the baza source to the sealed memory and still refuses 'ai'", () => {
    const latest = readFileSync(
      'src/modules/platform/db/migrations/0096_ai_ved_memory.sql',
      'utf8',
    );
    const at = latest.lastIndexOf('calc_items_baza_source_check');
    expect(at).toBeGreaterThan(-1);
    const clause = latest.slice(at, latest.indexOf(';', at));
    expect(clause).not.toContain("'ai'");
    expect(clause.match(/'[a-z_]+'/g)).toEqual([
      "'dictionary'",
      "'typed'",
      "'import'",
      "'memory'",
    ]);
  });

  // The memory reads the sealed record and writes a code and a baza. It is
  // the newest path a number can travel and law 1 applies to it unchanged:
  // it may not name the model anywhere.
  it('the sealed memory mentions no ai identifier', () => {
    const source = read('src/modules/wms/calc/memory.ts');
    expect(source).not.toMatch(/\bai[A-Z]\w*/);
    expect(source).not.toMatch(/ai_\w+/);
  });

  // And the ROW the import writes is a price out of the file — never a
  // number the model produced. `import-baza.ts` is the only new writer of a
  // baza in 0094's round, and it may not name the model at all.
  it('the import suggestion mentions no ai identifier', () => {
    const source = read('src/modules/wms/customs/import-baza.ts');
    expect(source).not.toMatch(/\bai[A-Z]\w*/);
    expect(source).not.toMatch(/ai_\w+/);
  });
});
