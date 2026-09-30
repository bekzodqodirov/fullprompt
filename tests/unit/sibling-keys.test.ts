import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Two elements side by side under one parent may not carry keys that can come
 * out EQUAL (DECISIONS #1247).
 *
 * The workspace strip keyed three of its children to reset them on a
 * navigation — the report-group picker and the ☆ on `placement.href`, the ⚙
 * on `pathname` — and the first two are the same string always, while the ⚙
 * equals the ☆ on every list page. When a key changes, React files a parent's
 * old children in ONE map by key; two equal keys are one entry, so the loser
 * is never deleted and its DOM stays in the row. Each click left the previous
 * strip behind — the owner's screenshot of 2026-09-30 is three «Yuk ▾»
 * pickers and two «Yana ▾» side by side — and production React says nothing
 * (the «same key» warning is the development build's).
 *
 * A fence cannot decide whether two expressions are equal at runtime, so the
 * rule is the idiom that makes it impossible: once two or more of a parent's
 * own positions carry keys, every key opens with literal text of its own
 * (`key={`star:${href}`}`), and no position's opening can be the start of
 * another's. A `.map()` is not a position — React reconciles a nested array
 * as its own list — and the two branches of one `?:` are ONE position
 * (alternatives, never siblings).
 */

type Key = { head: string; exact: boolean; text: string };
type Violation = { file: string; line: number; keys: string[] };

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

function keyOf(element: ts.JsxElement | ts.JsxSelfClosingElement): Key | null {
  const attrs = ts.isJsxElement(element) ? element.openingElement.attributes : element.attributes;
  for (const attr of attrs.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'key' || !attr.initializer) continue;
    const init = attr.initializer;
    const text = init.getText();
    if (ts.isStringLiteral(init)) return { head: init.text, exact: true, text };
    const expr = ts.isJsxExpression(init) && init.expression ? unwrap(init.expression) : null;
    if (!expr) return { head: '', exact: false, text };
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      return { head: expr.text, exact: true, text };
    }
    if (ts.isTemplateExpression(expr)) return { head: expr.head.text, exact: false, text };
    return { head: '', exact: false, text };
  }
  return null;
}

/** The keys one child of a JSX parent can render with — [] when it is not a keyed position. */
function positionKeys(expr: ts.Expression): Key[] {
  const node = unwrap(expr);
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const key = keyOf(node);
    return key ? [key] : [];
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return positionKeys(node.right);
  }
  if (ts.isConditionalExpression(node))
    return [...positionKeys(node.whenTrue), ...positionKeys(node.whenFalse)];
  return [];
}

/** Could a key rendered at one position ever equal one rendered at another? */
function mayCollide(a: Key, b: Key): boolean {
  if (a.exact && b.exact) return a.head === b.head;
  if (a.exact) return a.head.startsWith(b.head);
  if (b.exact) return b.head.startsWith(a.head);
  return a.head.startsWith(b.head) || b.head.startsWith(a.head);
}

export function siblingKeyViolations(
  file: string,
  source: string,
): { violations: Violation[]; keyedLists: number } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];
  let keyedLists = 0;
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const positions: Key[][] = [];
      for (const child of node.children) {
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
          const key = keyOf(child);
          if (key) positions.push([key]);
        } else if (ts.isJsxExpression(child) && child.expression) {
          const keys = positionKeys(child.expression);
          if (keys.length > 0) positions.push(keys);
        }
      }
      if (positions.length >= 2) {
        keyedLists += 1;
        const clash = positions.some((one, i) =>
          positions.some(
            (other, j) => j > i && one.some((a) => other.some((b) => mayCollide(a, b))),
          ),
        );
        if (clash) {
          violations.push({
            file,
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            keys: positions.flat().map((key) => key.text),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { violations, keyedLists };
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('keyed siblings cannot share a key', () => {
  it('the fence sees the shape that broke the strip, and passes the namespaced one', () => {
    // The strip as it shipped on 2026-09-26: picker and ☆ on one expression.
    const broken = `
      const a = (
        <div>
          {groups ? <GroupedTabs key={placement.href} /> : <TabRow />}
          {placement.tab && <StarButton key={placement.href} />}
          {settings.length > 0 && <SettingsMenu key={pathname} />}
        </div>
      );`;
    expect(siblingKeyViolations('broken.tsx', broken).violations).toHaveLength(1);
    // The ☆ and ⚙ alone still collide on a list page, where pathname IS the href.
    const starAndGear = `const a = (<div><TabRow /><Star key={href} /><Gear key={pathname} /></div>);`;
    expect(siblingKeyViolations('gear.tsx', starAndGear).violations).toHaveLength(1);
    // A head that is the start of another's can still meet it.
    const prefixed = 'const a = (<div><A key={`s${x}`} /><B key={`star:${y}`} /></div>);';
    expect(siblingKeyViolations('prefix.tsx', prefixed).violations).toHaveLength(1);
    const fixed = `
      const a = (
        <div>
          {groups ? <GroupedTabs key={\`groups:\${placement.href}\`} /> : <TabRow />}
          {placement.tab && <StarButton key={\`star:\${placement.href}\`} />}
          {settings.length > 0 && <SettingsMenu key={\`settings:\${pathname}\`} />}
        </div>
      );`;
    expect(siblingKeyViolations('fixed.tsx', fixed)).toEqual({ violations: [], keyedLists: 1 });
    // A list is its own namespace; one keyed position has nobody to meet.
    const list = `const a = (<ul>{rows.map((r) => <li key={r.id} />)}<details key={active} /></ul>);`;
    expect(siblingKeyViolations('list.tsx', list)).toEqual({ violations: [], keyedLists: 0 });
  });

  it('holds across src/', () => {
    const files = tsxFiles('src');
    let keyedLists = 0;
    const violations: Violation[] = [];
    for (const file of files) {
      const found = siblingKeyViolations(file, readFileSync(file, 'utf8'));
      keyedLists += found.keyedLists;
      violations.push(...found.violations);
    }
    // The premise: the walk reached the tree, and the strip is a keyed list in it.
    expect(files.length).toBeGreaterThan(300);
    expect(keyedLists).toBeGreaterThanOrEqual(1);
    expect(violations).toEqual([]);
  });
});
