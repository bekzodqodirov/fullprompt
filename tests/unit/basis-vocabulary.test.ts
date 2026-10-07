import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BAZA_BASES } from '@/modules/wms/calc/pricing';
import { BASIS_FOR_UNIT, UNIT_FOR_BASIS } from '@/modules/wms/customs/import-baza';

/**
 * ONE baza vocabulary (0125) — and every copy of it held to it.
 *
 * What a baza is PER used to be written out by hand in nine places: the
 * engine's type, the save's list, the dictionary's guard, the action's
 * parameter, the dictionary form's select, the ghost row's select, the
 * zero-import warnings file, the customs file's maps, and the CHECKs. Adding
 * m³ to one of them is a value the next one refuses — on a live system, a
 * select that offers «m³» and a save that answers `bad_basis`, or a CHECK
 * that answers a white page.
 *
 * So the list lives in `pricing.ts` (`BAZA_BASES`) and this fence is DERIVED:
 * TypeScript's own parser reads the restated unions that must stay restated
 * (warnings.ts is zero-import on purpose; import-parse.ts likewise), the
 * schema and the NEWEST migration that re-adds each CHECK are read as text,
 * and a sweep over `src/` refuses any NEW hand-copied basis list — a union or
 * an array holding both 'unit' and 'juft' — outside the allowlist.
 */
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const BASES = sorted(BAZA_BASES);

function sourceOf(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true);
}

/** Every string-literal member of a union type node (null/undefined skipped). */
function unionLiterals(node: ts.UnionTypeNode): string[] | null {
  const out: string[] = [];
  for (const t of node.types) {
    if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) out.push(t.literal.text);
    else if (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) continue;
    else if (t.kind === ts.SyntaxKind.UndefinedKeyword) continue;
    else return null;
  }
  return out;
}

function arrayLiterals(node: ts.ArrayLiteralExpression): string[] | null {
  const out: string[] = [];
  for (const e of node.elements) {
    if (ts.isStringLiteral(e)) out.push(e.text);
    else return null;
  }
  return out;
}

/** A basis list, by its shape: it names dona-as-'unit' AND a pair unit. */
const looksLikeBases = (xs: string[]) => xs.includes('unit') && xs.includes('juft');

function walk(node: ts.Node, visit: (n: ts.Node) => void) {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

/** The IN (…) list of a CHECK, read off SQL text after the constraint's name. */
function inListAfter(text: string, name: string): string[] | null {
  const at = text.lastIndexOf(name);
  if (at === -1) return null;
  const m = /IN\s*\(([^)]*)\)/.exec(text.slice(at));
  if (!m) return null;
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

describe('the baza vocabulary has ONE home', () => {
  it('BAZA_BASES is what it says: the six, m³ beside m², never sm³', () => {
    expect(BASES).toEqual(['juft', 'kg', 'litr', 'm2', 'm3', 'unit']);
    expect(BASES).not.toContain('sm3');
  });

  it('the zero-import warnings file restates it EXACTLY', () => {
    const lists: string[][] = [];
    walk(sourceOf('src/modules/wms/calc/warnings.ts'), (n) => {
      if (ts.isUnionTypeNode(n)) {
        const xs = unionLiterals(n);
        if (xs && looksLikeBases(xs)) lists.push(xs);
      }
    });
    // The item's basis and the dictionary baza's basis.
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const xs of lists) expect(sorted(xs)).toEqual(BASES);
  });

  it('the customs file has one unit per basis, both ways', () => {
    let importUnits: string[] | null = null;
    walk(sourceOf('src/modules/wms/customs/import-parse.ts'), (n) => {
      if (ts.isTypeAliasDeclaration(n) && n.name.text === 'ImportUnit' && ts.isUnionTypeNode(n.type)) {
        importUnits = unionLiterals(n.type);
      }
    });
    expect(importUnits, 'ImportUnit must stay a literal union').not.toBeNull();
    expect(sorted(importUnits!.map((u) => BASIS_FOR_UNIT[u as keyof typeof BASIS_FOR_UNIT]))).toEqual(BASES);
    expect(sorted(Object.keys(UNIT_FOR_BASIS))).toEqual(BASES);
    expect(sorted(Object.values(UNIT_FOR_BASIS))).toEqual(sorted(importUnits!));
  });

  it('the schema mirrors carry it', () => {
    const schema = read('src/modules/platform/db/schema/wms.ts');
    expect(sorted(inListAfter(schema, "'calc_items_baza_basis_check'") ?? [])).toEqual(BASES);
    expect(sorted(inListAfter(schema, "'calc_bazas_basis_check'") ?? [])).toEqual(BASES);
    const units = sorted(Object.values(UNIT_FOR_BASIS));
    expect(sorted(inListAfter(schema, "'customs_import_rows_unit_check'") ?? [])).toEqual(units);
  });

  it('the NEWEST migration that (re-)adds each CHECK carries it — what the database holds', () => {
    const dir = 'src/modules/platform/db/migrations';
    const files = readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const newest = (name: string) => {
      for (const f of [...files].reverse()) {
        const text = read(`${dir}/${f}`);
        const re = new RegExp(`(ADD CONSTRAINT|CONSTRAINT)\\s+"?${name}"?`);
        if (re.test(text)) return { f, list: inListAfter(text, name) };
      }
      return null;
    };
    const units = sorted(Object.values(UNIT_FOR_BASIS));
    for (const [name, want] of [
      ['calc_items_baza_basis_check', BASES],
      ['calc_bazas_basis_check', BASES],
      ['customs_import_rows_unit_check', units],
    ] as const) {
      const hit = newest(name);
      expect(hit, `${name}: no migration adds it`).not.toBeNull();
      expect(sorted(hit!.list ?? []), `${name} in ${hit!.f}`).toEqual(want);
    }
  });

  it('no OTHER hand-copied basis list anywhere in src/ — import BAZA_BASES / BazaBasis', () => {
    // The two that MUST restate (zero-import files) are checked above.
    const allow = new Set([
      'src/modules/wms/calc/pricing.ts',
      'src/modules/wms/calc/warnings.ts',
    ]);
    const offenders: string[] = [];
    const visitDir = (rel: string) => {
      for (const name of readdirSync(path.join(ROOT, rel))) {
        const child = `${rel}/${name}`;
        if (statSync(path.join(ROOT, child)).isDirectory()) visitDir(child);
        else if (/\.(ts|tsx)$/.test(name) && !allow.has(child)) {
          const sf = ts.createSourceFile(child, read(child), ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
          walk(sf, (n) => {
            const xs = ts.isUnionTypeNode(n)
              ? unionLiterals(n)
              : ts.isArrayLiteralExpression(n)
                ? arrayLiterals(n)
                : null;
            if (xs && looksLikeBases(xs)) {
              const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
              offenders.push(`${child}:${line + 1} [${xs.join(', ')}]`);
            }
          });
        }
      }
    };
    visitDir('src');
    expect(offenders).toEqual([]);
  });
});
