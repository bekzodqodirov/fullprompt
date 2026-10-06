import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * «🧮 Bitim hisobi»'s door (0119, 26a). The sheet's readers are exactly the
 * calculation registry's audience — `mayReadCalcRegistry`, minted into a
 * `CalcRegistrySight` by `calcRegistrySight(actor)` and REQUIRED by both
 * loaders and both components, so a caller without one is a compile error.
 * A cast can forge a brand, which is what this fence is for: every file that
 * imports the sheet's values must mint the sight itself. DERIVED — a new
 * importer is found by walking `src/`, not by a list somebody must remember.
 * Comments are stripped first (#725).
 */
const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');
const TARGETS = [join(SRC, 'modules/wms/calc/sheet'), join(SRC, 'components/calc-sheet')];

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

function resolveSpec(file: string, spec: string): string | null {
  if (spec.startsWith('@/')) return join(SRC, spec.slice(2));
  if (spec.startsWith('.')) return resolve(dirname(file), spec);
  return null;
}

/** Files importing a VALUE (not only types) from the sheet or its component. */
function valueImporters(): string[] {
  const found: string[] = [];
  for (const file of walk(SRC)) {
    const self = file.replace(/\.(ts|tsx)$/, '');
    if (TARGETS.includes(self)) continue;
    const source = strip(readFileSync(file, 'utf8'));
    for (const m of source.matchAll(/import\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
      const target = resolveSpec(file, m[3]!);
      if (!target || !TARGETS.includes(target)) continue;
      const typeOnly = Boolean(m[1]) || /^\{\s*(type\s+\w+(\s+as\s+\w+)?\s*,?\s*)+\}$/.test(m[2]!.trim());
      if (!typeOnly) found.push(relative(ROOT, file));
    }
  }
  return [...new Set(found)].sort();
}

describe('the calculation sheet is read only behind calcRegistrySight', () => {
  const importers = valueImporters();

  it('finds the readers the design names (a fence that finds nothing proves nothing)', () => {
    expect(importers).toEqual(
      expect.arrayContaining([
        'src/app/(protected)/batches/[id]/pricing/page.tsx',
        'src/app/(protected)/hisoblash/[id]/page.tsx',
        // The history row's goods fold (docs/VED-TARIX.md §3) — a ROUTE, so
        // the door is the route's own, minted per request (review
        // tests-completeness: the goods route named in this fence).
        'src/app/api/calc/registry/[requestId]/goods/route.ts',
      ]),
    );
  });

  it('the goods loader REQUIRES the sight too', () => {
    const sheet = strip(readFileSync(join(SRC, 'modules/wms/calc/sheet.ts'), 'utf8'));
    expect(sheet).toMatch(/export async function requestGoodsSheet\([^)]*_sight: CalcRegistrySight,?\s*\)/);
  });

  it('every file importing its values mints the sight itself', () => {
    for (const file of importers) {
      const source = strip(readFileSync(join(ROOT, file), 'utf8'));
      expect(source, file).toMatch(/calcRegistrySight\(\s*actor\s*\)/);
    }
  });

  it('both loaders and both components REQUIRE the sight — an optional one fails open (#790)', () => {
    const sheet = strip(readFileSync(join(SRC, 'modules/wms/calc/sheet.ts'), 'utf8'));
    expect(sheet).toMatch(/export async function dealCalcSheets\([^)]*_sight: CalcRegistrySight,?\s*\)/);
    expect(sheet).toMatch(/export async function calcSheetsForRequest\([^)]*_sight: CalcRegistrySight,?\s*\)/);
    const component = strip(readFileSync(join(SRC, 'components/calc-sheet.tsx'), 'utf8'));
    const sights = [...component.matchAll(/export async function (CalcSheet|CalcAnswers)\([^)]*\bsight:\s*CalcRegistrySight\s*\}\)/g)];
    expect(sights.length, 'CalcSheet and CalcAnswers each take a required sight').toBeGreaterThanOrEqual(2);
    expect(component).not.toMatch(/sight\?:/);
  });

  it('the sight is minted from the registry\'s own door and nothing else', () => {
    const scope = strip(readFileSync(join(SRC, 'modules/wms/calc/control-scope.ts'), 'utf8'));
    const fn = /export function calcRegistrySight\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(scope);
    expect(fn, 'calcRegistrySight not found').not.toBeNull();
    expect(fn![1]).toMatch(/mayReadCalcRegistry\(/);
  });
});
