import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The first seller named on a client takes the cargo nobody was named on
 * (0117 — his «hamma mijozlarga biriktirib chiqdim»: the book was filled in
 * after the cargo came). That is `stampUnattributedCargo`, and it lives in
 * the WRITERS, not in a trigger — so every function in src/ or scripts/ that
 * updates `clients` and writes `salesManagerId` must call it. DERIVED over the
 * functions, comments stripped (#725): the two writers today are the client
 * form's `updateClientAction` and `import-clients --update`, and a third is
 * red the day it is written.
 *
 * An integration test cannot press the form's action (it `authorize`s), so
 * this is the wire half of #531's pair; the integration file proves the
 * function itself.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Top-level function chunks — a writer and its stamp live in one function. */
const functions = (source: string) => source.split(/\n(?=(?:export\s+)?(?:async\s+)?function\s)/);

const FILES = [...globSync('src/**/*.{ts,tsx}'), ...globSync('scripts/**/*.ts')];

/** The balanced `{…}` starting at `open`. */
function objectAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

/**
 * Does this `update(clients).set(…)` write the seller? An object literal must
 * name the key; a variable (`set(values)`) is a writer when its own literal
 * names it or the function reads `values.salesManagerId` — the form's
 * `toValues(parsed)` names it nowhere else.
 */
function writesSeller(chunk: string, at: number): boolean {
  const tail = chunk.slice(at);
  const literal = /^\.update\(clients\)\s*\.set\(\s*\{/.exec(tail);
  if (literal) return /\bsalesManagerId\b/.test(objectAt(tail, literal[0].length - 1));
  const named = /^\.update\(clients\)\s*\.set\(\s*(\w+)\s*\)/.exec(tail);
  if (!named) return false;
  const id = named[1]!;
  if (new RegExp(`\\b${id}\\.salesManagerId\\b`).test(chunk)) return true;
  const decl = new RegExp(`\\b${id}\\s*=\\s*\\{`).exec(chunk);
  return decl ? /\bsalesManagerId\b/.test(objectAt(chunk, decl.index + decl[0].length - 1)) : false;
}

function managerWriters(): { path: string; chunk: string }[] {
  const out: { path: string; chunk: string }[] = [];
  for (const path of FILES) {
    const source = stripComments(readFileSync(path, 'utf8'));
    if (!source.includes('.update(clients)')) continue;
    for (const chunk of functions(source)) {
      const sites = [...chunk.matchAll(/\.update\(clients\)/g)].map((m) => m.index!);
      if (sites.some((at) => writesSeller(chunk, at))) out.push({ path, chunk });
    }
  }
  return out;
}

describe('naming a client’s first seller stamps his unattributed cargo', () => {
  it('finds both writers it guards', () => {
    const paths = managerWriters().map((w) => w.path);
    expect(paths).toContain('src/app/(protected)/admin/clients/actions.ts');
    expect(paths).toContain('scripts/import-clients.ts');
  });

  it('every function that writes a client’s seller calls stampUnattributedCargo', () => {
    const offenders = managerWriters()
      .filter((w) => !/\bstampUnattributedCargo\(/.test(w.chunk))
      .map((w) => w.path);
    expect(offenders).toEqual([]);
  });

  it('only on NULL → someone: a move from A to B leaves A’s cargo with A (his 2a)', () => {
    for (const w of managerWriters()) {
      expect(w.chunk, w.path).toMatch(/!before\.salesManagerId && values\.salesManagerId/);
    }
  });

  it('import-clients --update writes the audit diff the backfill reads', () => {
    const script = stripComments(readFileSync('scripts/import-clients.ts', 'utf8'));
    const update = script.slice(script.indexOf('} else if (UPDATE)'));
    expect(update).toMatch(/diffFields\(/);
    expect(update).toMatch(/writeAudit\(db, ctx, \{ entityType: 'client'/);
  });
});
