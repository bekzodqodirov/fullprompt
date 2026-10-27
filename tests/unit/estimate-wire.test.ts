import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The 📊 estimate and the guessed zone are WORDS FOR THE CHAT, and nothing
 * else (docs/SAKKIZ-R2.md §1, §3, §6.9).
 *
 * Law 1 says the model never reaches a number, and the estimate is the
 * closest the system has come: a price computed from declarations that no
 * person chose, printed as «Taxminiy». So it is fenced three ways, by source
 * shape, because no behaviour can show that a reader DOESN'T exist:
 *
 *  - the three estimate files cannot write — no insert, no update, no door
 *    that stores a baza or closes a job — and name no model;
 *  - the median read stands on `percentile_disc` and on the transaction it
 *    is handed (the pool is every page's, #714), strictly one statement
 *    after another;
 *  - and the IMPORT DIRECTION: nothing outside the bot's reply may import
 *    the estimate or name its figures — no «Готово» default, no hint on
 *    narxlar, no seal, no price-channel post (§3's «never read»).
 *
 * Comments are stripped before any text is read (#725): the files explain
 * these very rules in prose.
 */
const ROOT = process.cwd();
const ESTIMATE = 'src/modules/wms/calc/estimate.ts';
const READ = 'src/modules/wms/calc/estimate-read.ts';
const MEDIAN = 'src/modules/wms/customs/import-median.ts';
const PREFILL = 'src/modules/wms/calc/prefill.ts';
const REPLY = 'src/modules/wms/calc/ai-reply.ts';

const parsed = new Map<string, ts.SourceFile>();
const parse = (path: string): ts.SourceFile => {
  const known = parsed.get(path);
  if (known) return known;
  const file = ts.createSourceFile(path, readFileSync(join(ROOT, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  parsed.set(path, file);
  return file;
};
/** The file's code with every comment removed — TypeScript's own printer. */
const code = (path: string) => ts.createPrinter({ removeComments: true }).printFile(parse(path));

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

describe('the estimate cannot write, and names no model (law 1)', () => {
  for (const file of [ESTIMATE, READ, MEDIAN]) {
    it(`${file} has no writer`, () => {
      const text = code(file);
      for (const banned of ['.insert(', '.update(', 'saveTable', 'setItemBaza', 'mutateRequest', 'recordOffer', 'finishCalcRequest', 'bazaSource']) {
        expect(text, `${file} must not mention ${banned}`).not.toContain(banned);
      }
      expect(text, `${file} names the model`).not.toMatch(/\bai[A-Z]\w*/);
      expect(text, `${file} names the model`).not.toMatch(/\bai_\w+/);
    });
  }

  it('the median is a DECLARED price, read on the transaction it is handed', () => {
    const text = code(MEDIAN);
    expect(text).toContain('percentile_disc');
    for (const banned of ['_cont', 'avg(', 'sum(']) expect(text).not.toContain(banned);
    // Inside `underCeiling` (tx-pool.test.ts does not scan those bodies): a
    // pool read here waits for an eleventh connection while holding one.
    expect(text).not.toMatch(/\bdb\./);
    expect(text).not.toContain('getSetting');
  });

  it('the medians are read strictly one after another — each statement holds one of ten connections', () => {
    const text = code(READ);
    expect(text).not.toContain('Promise.all');
    expect(text).not.toContain('Promise.allSettled');
    // …and through the ceiling, never on the open pool.
    expect(text).toContain('underCeiling(');
  });
});

describe('the pass never stores what it estimated or guessed', () => {
  /** The argument text of every call to `name(` in a file. */
  const argsOf = (path: string, name: string): string[] => {
    const out: string[] = [];
    walk(parse(path), (n) => {
      if (ts.isCallExpression(n) && n.expression.getText() === name) out.push(n.arguments.map((a) => a.getText()).join(', '));
    });
    return out;
  };

  it('no estimate reaches a save: `saveTable(` and `pickBazas(` take none of it', () => {
    const calls = [...argsOf(PREFILL, 'saveTable'), ...argsOf(PREFILL, 'pickBazas')];
    // The premise: the pass still saves (the sweep) and still picks.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) {
      expect(args, `a save carries the estimate: ${args}`).not.toMatch(/\b(estimate|medians|taxminiy\w*)\b/);
    }
  });

  /**
   * The argument fence above reads names, and a median laundered through a
   * local (`const posted = …medians…; saveTable(…, { items: posted })`) has
   * none — measured: that edit stored 2.4 on the row and left the argument
   * fence green. ORDER closes it: every write of the pass sits before the
   * medians are read, so nothing computed from them has a save left to reach.
   */
  it('every write of the pass comes BEFORE the medians are read', () => {
    const WRITES = new Set([
      'saveTable',
      'pickBazas',
      'applyMemory',
      'propose',
      'proposeGroups',
      'setItemBaza',
      'mutateRequest',
      'setFreightZone',
      'applyTableEdits',
      'recordOffer',
      'finishCalcRequest',
      'sealCalc',
      '.insert',
      '.update',
      '.delete',
    ]);
    const calls: { name: string; pos: number }[] = [];
    walk(parse(PREFILL), (n) => {
      if (!ts.isCallExpression(n)) return;
      const callee = n.expression;
      calls.push({ name: ts.isPropertyAccessExpression(callee) ? `.${callee.name.text}` : callee.getText(), pos: n.getStart() });
    });
    const read = calls.find((c) => c.name === 'rowMediansFor');
    expect(read, 'the pass no longer reads the medians — re-anchor').toBeDefined();
    const writes = calls.filter((c) => WRITES.has(c.name));
    // The premise: the pass still writes — memory, model, sweep, pick.
    expect(writes.filter((c) => c.pos < read!.pos).map((c) => c.name)).toEqual(
      expect.arrayContaining(['applyMemory', 'propose', 'saveTable', 'pickBazas']),
    );
    expect(writes.filter((c) => c.pos > read!.pos).map((c) => c.name), 'a write after the medians are read').toEqual([]);
  });

  it('`PrefillOutcome.customsUsd` is the workspace’s exact total — never the estimate', () => {
    let declared: string | null = null;
    walk(parse(PREFILL), (n) => {
      if (ts.isVariableDeclaration(n) && n.name.getText() === 'customsUsd' && n.initializer) declared = n.initializer.getText();
    });
    expect(declared, 'customsUsd is no longer declared in the pass — re-anchor').not.toBeNull();
    expect(declared).toContain('ws.customsUsd');
    expect(declared).not.toMatch(/estimate|taxminiy|median/);
  });

  it('the guessed zone is never stored (#770(b)) — no zone writer, no update, the stored zone only READ', () => {
    for (const file of [PREFILL, 'src/modules/wms/calc/freight-answer.ts', 'src/modules/wms/calc/zone-guess.ts']) {
      const text = code(file);
      expect(text, file).not.toContain('setFreightZone(');
      expect(text, file).not.toContain('.update(');
      // An object-literal `freightZone:` key is how a zone travels to a
      // writer. The only one the pass may build hands the freight answer the
      // STORED zone it read — never the guess.
      walk(parse(file), (n) => {
        if (ts.isPropertyAssignment(n) && n.name.getText() === 'freightZone') {
          expect(n.initializer.getText(), `${file}: a freightZone key that is not the stored zone`).toBe('ws.freightZone');
        }
        if (ts.isShorthandPropertyAssignment(n) && n.name.getText() === 'freightZone') {
          throw new Error(`${file}: a shorthand freightZone key carries a computed zone`);
        }
      });
    }
  });
});

describe('the import direction: nothing but the bot’s reply reads the estimate (§3, law-money-5)', () => {
  const files: string[] = [];
  const collect = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = posix.join(dir, entry);
      if (statSync(join(ROOT, rel)).isDirectory()) collect(rel);
      else if (/\.tsx?$/.test(entry)) files.push(rel);
    }
  };
  collect('src');

  /** Where a module specifier in `from` points, without its extension. */
  const target = (from: string, spec: string): string | null => {
    if (spec.startsWith('@/')) return posix.join('src', spec.slice(2)).replace(/\.tsx?$/, '');
    if (spec.startsWith('.')) return posix.join(dirname(from), spec).replace(/\.tsx?$/, '');
    return null;
  };

  /** Every module a file imports, statically or by `import(…)` — parsed once a file. */
  const seen = new Map<string, string[]>();
  const importsOf = (path: string): string[] => {
    const known = seen.get(path);
    if (known) return known;
    const out: string[] = [];
    seen.set(path, out);
    walk(parse(path), (n) => {
      const spec =
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)
          ? n.moduleSpecifier.text
          : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])
            ? n.arguments[0].text
            : null;
      if (spec) {
        const t = target(path, spec);
        if (t) out.push(t);
      }
    });
    return out;
  };

  const importers = (module: string) => files.filter((f) => importsOf(f).includes(module));

  it('finds the source tree at all', () => {
    // A walk that saw nothing passes every assertion below it (#494).
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(PREFILL);
  });

  it('calc/estimate.ts is read by the read, the pass and the reply only', () => {
    // import-median.ts takes the TYPE of its own answer (`CodeMedianUnit`).
    const allowed = [READ, PREFILL, REPLY, MEDIAN];
    expect(importers('src/modules/wms/calc/estimate').filter((f) => !allowed.includes(f))).toEqual([]);
  });

  it('calc/estimate-read.ts is read by the pass only; customs/import-median.ts by the read only', () => {
    expect(importers('src/modules/wms/calc/estimate-read')).toEqual([PREFILL]);
    expect(importers('src/modules/wms/customs/import-median')).toEqual([READ]);
  });

  it('the estimate’s names appear in no file outside the five — no «Готово» default, no hint, no seal, no post', () => {
    const five = new Set([ESTIMATE, READ, MEDIAN, PREFILL, REPLY]);
    const names = new Set(['estimateCustoms', 'rowMediansFor', 'readCodeMedians', 'taxminiyUsd', 'taxminiyFee', 'taxminiy', 'taxminiyPartial']);
    const strays: string[] = [];
    for (const f of files) {
      if (five.has(f)) continue;
      walk(parse(f), (n) => {
        if (ts.isIdentifier(n) && names.has(n.text)) strays.push(`${f}: ${n.text}`);
      });
    }
    expect(strays).toEqual([]);
  });
});
