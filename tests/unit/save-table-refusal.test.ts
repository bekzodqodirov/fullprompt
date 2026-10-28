import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `SaveTableRefusal` is the union of every `CalcError` code `saveTable` and
 * the functions it calls can throw (docs/SAKKIZ-R3.md K15) — derived here,
 * with TypeScript's parser (comments are not code, #725), from the throw
 * sites themselves: walk `saveTable`, follow every call to a function this
 * file declares, collect each `new CalcError('…')`. The add door words every
 * member, so a refusal the union does not name would reach a seller as a
 * bare code; a member no site throws is a sentence nobody can ever read.
 */

const FILE = 'src/modules/wms/calc/workspace.ts';
const source = ts.createSourceFile(FILE, readFileSync(FILE, 'utf8'), ts.ScriptTarget.Latest, true);

/** Top-level functions of the file, by name (declarations and const arrows). */
function declared(): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const st of source.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
          out.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return out;
}

function thrownBy(root: string): { codes: Set<string>; dynamic: string[] } {
  const fns = declared();
  const seen = new Set<string>();
  const codes = new Set<string>();
  const dynamic: string[] = [];
  const walk = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const fn = fns.get(name);
    if (!fn) return;
    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'CalcError') {
        const code = n.arguments?.[0];
        if (code && ts.isStringLiteralLike(code)) codes.add(code.text);
        else dynamic.push(`${name}: ${code?.getText(source) ?? '(none)'}`);
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) walk(n.expression.text);
      ts.forEachChild(n, visit);
    };
    visit(fn);
  };
  walk(root);
  return { codes, dynamic };
}

function unionMembers(name: string): Set<string> {
  for (const st of source.statements) {
    if (!ts.isTypeAliasDeclaration(st) || st.name.text !== name) continue;
    const types = ts.isUnionTypeNode(st.type) ? st.type.types : [st.type];
    return new Set(
      types.flatMap((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? [t.literal.text] : [])),
    );
  }
  return new Set();
}

describe('SaveTableRefusal', () => {
  it('names exactly the codes saveTable and its callees throw', () => {
    const { codes } = thrownBy('saveTable');
    expect(codes.size).toBeGreaterThan(5);
    expect([...unionMembers('SaveTableRefusal')].sort()).toEqual([...codes].sort());
  });

  it('every refusal on the path is a literal code — a computed one could be anything', () => {
    expect(thrownBy('saveTable').dynamic).toEqual([]);
  });

  it('the walk reaches the shared lock and the cargo patch, not only the body', () => {
    // Anchored on codes only a callee throws, so a walker that stopped at
    // saveTable's own body reads red here rather than green above.
    const { codes } = thrownBy('saveTable');
    expect(codes).toContain('already_closed'); // lockRequestInTx
    expect(codes).toContain('measure_positive'); // cargoPatchOf / tableMeasure
    expect(codes).toContain('bad_code'); // tableCode
  });
});
