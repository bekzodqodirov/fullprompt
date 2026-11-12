import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * ONE home for the cube of a package's sides (docs/AI-SORAYDI.md §2.3, §3.1
 * T16; review JB-16, CR-4).
 *
 * The AI sotuvchi's `cargo_volume` tool had multiplied a count by three sides
 * and divided by 1 000 000 since 0138 — a second carton arithmetic beside
 * carton-math.ts, with a rounding of its own. A third would be the same
 * defect again: the sides' cube is `sizeCube`'s, the product's rounding the
 * kernel's. So no code in src/modules/wms divides by a million or multiplies
 * by a million or a millionth — the centimetre cube's conversion, either way —
 * outside carton-math.ts and the places `ALLOWED` names with their reason.
 *
 * Read with TypeScript's own parser: an operand of `*` or `/` that IS the
 * literal 1 000 000 (any spelling — `1_000_000`, `1e6`, `1000000`) or one
 * millionth. A comment, a string, an SQL template, a call's argument
 * (`Math.min(x, 1_000_000)`) or a comparison (`> 1e-6`) is no such operand.
 */

const ROOT = join(process.cwd(), 'src/modules/wms');

/**
 * Where a million is no cube of sides — each with its reason, and each must
 * still hold the operation (a stale entry is a hole in the fence).
 */
const ALLOWED: Record<string, string> = {
  // The kernel itself: the one home (its conversion lives in a constant table).
  'calc/carton-math.ts': 'the one carton arithmetic',
  // A cube already computed, turned into cm³ for the AIR tariff's volumetric
  // weight (m³ × 1 000 000 ÷ divisor) — the inverse conversion of a figure,
  // never three sides multiplied (review JB-16 names it).
  'agent/site-estimate.ts': 'the volumetric weight of a stated cube',
  // Money: a call's micro-dollars as dollars at six decimals. No sides.
  'calc/ai-press.ts': 'micro-dollars to dollars',
  // The WAREHOUSE's measured box — the prixod's lot math (spec 4.6) and the
  // crate's stated cube on /stock — each with its own rounding, which every
  // stored lot and its tannarx were computed with. Found by this fence, and
  // not this package's files: whether they move to `sizeCube` is a change to
  // stored figures and is the lead's call (stated, not built — T16's report).
  'receipts/math.ts': 'the warehouse lot’s measured boxes (spec 4.6) — open',
  'inventory/service.ts': 'the crate’s stated cube on /stock — open',
};

const MILLION = 1_000_000;
const MILLIONTH = 1e-6;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Every `x * 1e6`, `x / 1e6`, `x * 1e-6` of a source — its line and its text. */
function conversions(source: string, name: string): { line: number; text: string }[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const out: { line: number; text: string }[] = [];
  const literal = (node: ts.Expression): number | null => {
    const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
    return ts.isNumericLiteral(inner) ? Number(inner.text.replace(/_/gu, '')) : null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const sides = [literal(node.left), literal(node.right)];
      const times = op === ts.SyntaxKind.AsteriskToken || op === ts.SyntaxKind.AsteriskEqualsToken;
      const divide = op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.SlashEqualsToken;
      const hit =
        (divide && literal(node.right) === MILLION) ||
        (times && sides.some((n) => n === MILLION || n === MILLIONTH));
      if (hit) {
        out.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText().slice(0, 80) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

describe('the cube of sides has one home', () => {
  const found = files(ROOT).map((path) => ({
    file: relative(ROOT, path).split('\\').join('/'),
    hits: conversions(readFileSync(path, 'utf8'), path),
  }));

  it('the walk reached the tree and the parser sees the shape it fences', () => {
    expect(found.length).toBeGreaterThan(100);
    // The premise, on a source written here: each spelling is found, and a
    // comment, a string, a call argument and a comparison are not.
    const probe = [
      'const a = (n * l * w * h) / 1_000_000;',
      'const b = l * w * h * 1e-6;',
      'const c = m3 * 1000000;',
      '// (n * l * w * h) / 1_000_000 in a comment',
      "const d = 'x / 1e6';",
      'const e = Math.min(x, 1_000_000);',
      'const f = Math.abs(x) > 1e-6;',
    ].join('\n');
    expect(conversions(probe, 'probe.ts').map((h) => h.line)).toEqual([1, 2, 3]);
  });

  it('no file of src/modules/wms converts a cube by a million but the kernel and the named reasons', () => {
    const offenders = found.filter((f) => f.hits.length > 0 && !(f.file in ALLOWED));
    expect(offenders.map((f) => `${f.file}: ${f.hits.map((h) => `${h.line} ${h.text}`).join(' | ')}`)).toEqual([]);
  });

  it('every allowed entry still holds the operation it is allowed for — or is the kernel', () => {
    for (const [file] of Object.entries(ALLOWED)) {
      const entry = found.find((f) => f.file === file);
      expect(entry, file).toBeDefined();
      if (file !== 'calc/carton-math.ts') expect(entry!.hits.length, file).toBeGreaterThan(0);
    }
  });
});
