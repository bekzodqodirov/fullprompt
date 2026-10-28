import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * «Has a person been here since the machine?» (his 1.9 a) is ONE column,
 * `calc_requests.handsoff_rev` (0138), and its meaning is the whole of who
 * may write it (docs/SAKKIZ-R3.md §10.3, durability-6, law-money-2): the
 * landing writes 0, and only the machine's own chained saves — and the
 * seller's own additions — move it, inside the transaction that moved the
 * clock. A screen door that stamped «hands off» would let a PERSON's write
 * read as the machine's, and the next addition would be written into the
 * rows over the VED.
 *
 * DERIVED over every file in `src/`, with TypeScript's parser (comments are
 * not code, #725), so a writer another package adds — or the add door's
 * `amend.ts`, which this package's tree does not hold — is seen the day it
 * lands, and a fourth one is named by its file.
 */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

const FILES = walk('src').map((path) => ({
  path,
  // Each file in its own dialect: a `.ts` read as TSX misparses a `<T>`
  // cast or generic arrow, and the tree around it is wrong.
  source: ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  ),
}));

/** The nearest NAMED function around a node — inner arrows (a transaction's
 * body, a callback) belong to the function that wrote them. */
function enclosing(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent)) {
      return n.parent.name.getText();
    }
  }
  return '(module)';
}

function visitAll(fn: (node: ts.Node, file: { path: string; source: ts.SourceFile }) => void): void {
  for (const file of FILES) {
    const visit = (n: ts.Node) => {
      fn(n, file);
      ts.forEachChild(n, visit);
    };
    visit(file.source);
  }
}

/** A template's text, with every `${…}` as one placeholder. */
function templateText(t: ts.TemplateLiteral): string {
  if (ts.isNoSubstitutionTemplateLiteral(t)) return t.text;
  return [t.head.text, ...t.templateSpans.map((s) => `$x${s.literal.text}`)].join('');
}

/** Does this SQL WRITE the column — in an INSERT's columns or a SET clause? */
function sqlWritesStamp(text: string): boolean {
  if (/\bINSERT\s+INTO\b[\s\S]*\bhandsoff_rev\b/i.test(text)) return true;
  for (const m of text.matchAll(/\bSET\b([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|$)/gi)) {
    if (/\bhandsoff_rev\s*=/i.test(m[1]!)) return true;
  }
  return false;
}

type Site = { file: string; fn: string; how: string; text: string };

function stampWriters(): Site[] {
  const out: Site[] = [];
  visitAll((n, file) => {
    // drizzle: `handsoffRev` in an object handed to `.values(…)` / `.set(…)`,
    // or in an upsert's `set: { … }`.
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name.getText() === 'handsoffRev') {
      const obj = n.parent;
      const holder = obj.parent;
      const viaCall =
        ts.isCallExpression(holder) &&
        ts.isPropertyAccessExpression(holder.expression) &&
        ['values', 'set'].includes(holder.expression.name.text);
      const viaSet = ts.isPropertyAssignment(holder) && holder.name.getText() === 'set';
      if (viaCall || viaSet) {
        out.push({ file: file.path, fn: enclosing(n), how: 'drizzle', text: n.getText() });
      }
    }
    // raw SQL, in any template the code builds.
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      if (sqlWritesStamp(templateText(n))) {
        out.push({ file: file.path, fn: enclosing(n), how: 'sql', text: templateText(n).replace(/\s+/g, ' ').trim() });
      }
    }
  });
  return out;
}

describe('the hands-off stamp has exactly two writers', () => {
  const writers = stampWriters();

  it('the landing’s INSERT (0) and `advanceHandsOffInTx` — nothing else in src/ writes the column', () => {
    expect(writers.map((w) => `${w.file} · ${w.fn} · ${w.how}`).sort()).toEqual([
      'src/modules/wms/calc/hands-off.ts · advanceHandsOffInTx · sql',
      'src/modules/wms/calc/service.ts · openCalcRequest · drizzle',
    ]);
  });

  it('the landing writes 0 — rev’s own birth value — and the mover moves it only from the revision it expected', () => {
    const landing = writers.find((w) => w.fn === 'openCalcRequest')!;
    expect(landing.text).toBe('handsoffRev: 0');
    const mover = writers.find((w) => w.fn === 'advanceHandsOffInTx')!;
    // The compare-and-set IS the rule: a person's write in between leaves
    // the stamp behind `rev` for good.
    expect(mover.text).toMatch(/SET handsoff_rev = \$x::int WHERE id = \$x::uuid AND handsoff_rev = \$x::int/);
  });

  it('the stamp sits in openCalcRequest’s INSERT AFTER Uch band’s lead lock and rota pick; recalcFromSealed writes none (p5-p6-19)', () => {
    const service = FILES.find((f) => f.path === 'src/modules/wms/calc/service.ts')!.source;
    let fn: ts.FunctionDeclaration | undefined;
    service.forEachChild((n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'openCalcRequest') fn = n;
    });
    expect(fn, 'openCalcRequest not found').toBeDefined();
    const body = fn!.getText(service);
    const stamp = body.indexOf('handsoffRev: 0');
    const leadLock = body.indexOf('FOR SHARE OF l');
    const rota = body.indexOf('nextVedAssigneeInTx(');
    expect(leadLock).toBeGreaterThan(-1);
    expect(rota).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(leadLock);
    expect(stamp).toBeGreaterThan(rota);
    // A correction reads «started»: its INSERT carries no stamp at all.
    const workspace = FILES.find((f) => f.path === 'src/modules/wms/calc/workspace.ts')!.source;
    let recalc = '';
    workspace.forEachChild((n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'recalcFromSealed') recalc = n.getText(workspace);
    });
    expect(recalc, 'recalcFromSealed not found').not.toBe('');
    expect(recalc).toContain('.insert(calcRequests)');
    expect(recalc).not.toMatch(/handsoffRev|handsoff_rev/);
  });
});

describe('the mover is called only by the save primitives, and only under `handsOff`', () => {
  const calls: { file: string; fn: string; guarded: boolean }[] = [];
  visitAll((n, file) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'advanceHandsOffInTx') {
      let guarded = false;
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isIfStatement(p) && /\bhandsOff\b/.test(p.expression.getText())) guarded = true;
        if (ts.isFunctionDeclaration(p)) break;
      }
      calls.push({ file: file.path, fn: enclosing(n), guarded });
    }
  });

  it('finds the calls at all (#494)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('saveTable, mutateRequest and applyProposal — in workspace.ts, each inside `if (… handsOff …)`', () => {
    const allowed = new Set(['saveTable', 'mutateRequest', 'applyProposal']);
    for (const c of calls) {
      expect(c.file, `${c.fn} calls the mover`).toBe('src/modules/wms/calc/workspace.ts');
      expect(allowed.has(c.fn), `${c.file} · ${c.fn} calls the mover`).toBe(true);
      expect(c.guarded, `${c.fn}'s call is not under a handsOff guard`).toBe(true);
    }
    expect(new Set(calls.map((c) => c.fn))).toEqual(allowed);
  });
});

describe('`handsOff` is passed only by the machine and the seller’s own addition', () => {
  /**
   * The machine's pass (`prefill.ts`, `prefill-steps.ts`), the grouping's
   * chain inside workspace.ts (forwarding the flag it was handed, never
   * minting one), and the add door's writer (`amend.ts`, P4).
   */
  const MACHINE = new Set([
    'src/modules/wms/calc/prefill.ts',
    'src/modules/wms/calc/prefill-steps.ts',
    'src/modules/wms/calc/amend.ts',
  ]);
  const CHAIN = new Set(['proposeGroups', 'priceProposedGroups']);
  const passes: Site[] = [];
  visitAll((n, file) => {
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name.getText() === 'handsOff') {
      passes.push({ file: file.path, fn: enclosing(n), how: 'object', text: n.getText() });
    }
  });

  it('finds the passes at all (#494)', () => {
    expect(passes.some((p) => p.file === 'src/modules/wms/calc/prefill.ts')).toBe(true);
    expect(passes.some((p) => p.file === 'src/modules/wms/calc/prefill-steps.ts')).toBe(true);
  });

  it('every `handsOff:` in src/ is the machine’s, the add door’s, or the chain forwarding its own flag', () => {
    const strangers = passes.filter((p) => {
      if (MACHINE.has(p.file)) return false;
      if (p.file === 'src/modules/wms/calc/workspace.ts' && CHAIN.has(p.fn) && p.text === 'handsOff: opts.handsOff') {
        return false;
      }
      return true;
    });
    expect(strangers.map((p) => `${p.file} · ${p.fn} · ${p.text}`)).toEqual([]);
  });
});
