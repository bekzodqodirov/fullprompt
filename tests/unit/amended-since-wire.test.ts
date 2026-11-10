import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { bodyOf, read, srcFiles } from '../fixtures/source-shape';

/**
 * P6 «Ko‘rdim», wired end to end (docs/SAKKIZ-R3.md §10A). The behaviour is
 * proven in `amended-since.integration.test.ts`; this fence holds what that
 * file cannot see — that every button the VED presses carries the revision
 * its screen was drawn at, that no door takes it optionally, and that the
 * three locked doors ask under their lock and before any write.
 *
 * Source shape on purpose: the buttons are client components that call
 * server actions, and an action calls `authorize`, so no integration test can
 * press one (#531 — a service-level proof of a form-fed path proves the
 * service, not the system). TypeScript's own parser reads the signatures and
 * the calls; comments are stripped before any text is searched (#725).
 */
const WORKSPACE = 'src/modules/wms/calc/workspace.ts';
const SERVICE = 'src/modules/wms/calc/service.ts';
const ACTIONS = 'src/app/(protected)/hisoblash/actions.ts';
const PAGE_DIR = 'src/app/(protected)/hisoblash/[id]';

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function fn(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
  if (!found) throw new Error(`${name} not found in ${sf.fileName}`);
  return found;
}

/** `sawRev` is declared exactly `sawRev: number` — no `?`, no default. */
function requiredNumber(node: ts.ParameterDeclaration | ts.PropertySignature | undefined, sf: ts.SourceFile) {
  expect(node, 'a sawRev is declared').toBeDefined();
  expect(node!.questionToken, 'never optional (#790: an optional one fails open)').toBeUndefined();
  if (ts.isParameter(node!)) expect(node!.initializer, 'never defaulted').toBeUndefined();
  expect(node!.type?.getText(sf)).toBe('number');
}

const param = (f: ts.FunctionDeclaration, name: string) =>
  f.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);

/** Every call of `name` in a file, with its arguments' text. */
function callsOf(sf: ts.SourceFile, name: string): string[][] {
  const out: string[][] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      out.push(node.arguments.map((a) => a.getText(sf)));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The value of a JSX attribute on every element named `tag` in a file. */
function jsxAttr(sf: ts.SourceFile, tag: string, attr: string): (string | null)[] {
  const out: (string | null)[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(sf) === tag) {
      const a = node.attributes.properties.find(
        (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === attr,
      );
      const init = a?.initializer;
      out.push(init && ts.isJsxExpression(init) && init.expression ? init.expression.getText(sf) : null);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Positions of `needles` in `body`, each required present. */
function at(body: string, ...needles: string[]): number[] {
  return needles.map((n) => {
    const i = body.indexOf(n);
    expect(i, `«${n}» is in the body`).toBeGreaterThanOrEqual(0);
    return i;
  });
}

describe('sawRev is REQUIRED on every door (§10A.2 rule 3)', () => {
  it('the three workspace doors and «Готово»', () => {
    const ws = parse(WORKSPACE);
    requiredNumber(param(fn(ws, 'confirmGroup'), 'sawRev'), ws);
    requiredNumber(param(fn(ws, 'confirmAllGroups'), 'sawRev'), ws);
    const seal = ws.statements.find(
      (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'SealInput',
    )!;
    const sealRev = seal.members.find(
      (m): m is ts.PropertySignature => ts.isPropertySignature(m) && m.name.getText(ws) === 'sawRev',
    );
    requiredNumber(sealRev, ws);
    const service = parse(SERVICE);
    requiredNumber(param(fn(service, 'finishCalcRequest'), 'sawRev'), service);
  });

  it('the four server actions', () => {
    const actions = parse(ACTIONS);
    requiredNumber(param(fn(actions, 'confirmGroupAction'), 'sawRev'), actions);
    requiredNumber(param(fn(actions, 'confirmAllAction'), 'sawRev'), actions);
    requiredNumber(param(fn(actions, 'finishCalcAction'), 'sawRev'), actions);
    const input = param(fn(actions, 'sealAction'), 'input')!.type as ts.TypeLiteralNode;
    requiredNumber(
      input.members.find(
        (m): m is ts.PropertySignature => ts.isPropertySignature(m) && m.name.getText(actions) === 'sawRev',
      ),
      actions,
    );
    // …and each hands it on to its service door, never drops it.
    const body = read(ACTIONS);
    expect(bodyOf(body, 'export async function confirmGroupAction(')).toContain('confirmGroup(groupId, ctx, via, sawRev)');
    expect(bodyOf(body, 'export async function confirmAllAction(')).toContain('confirmAllGroups(id, ctx, sawRev)');
    expect(bodyOf(body, 'export async function finishCalcAction(')).toMatch(/ctx,\s*sawRev,\s*\)/);
    expect(bodyOf(body, 'export async function sealAction(')).toContain('sawRev: input.sawRev');
  });
});

describe('the locked doors ask under their lock, before any write (§10A.2 rule 1)', () => {
  const ws = read(WORKSPACE);

  it('a group’s ✅', () => {
    const body = bodyOf(ws, 'export async function confirmGroup(');
    const [lock, ask, clock, write] = at(
      body,
      'mutateRequest(group.requestId',
      'await refuseIfAmendedSinceInTx(tx, group.requestId, sawRev)',
      'locked.rev !== warnings.rev',
      '.update(calcGroups)',
    );
    expect(lock).toBeLessThan(ask!);
    expect(ask).toBeLessThan(clock!);
    expect(ask).toBeLessThan(write!);
  });

  it('«✅ Hammasini»', () => {
    const body = bodyOf(ws, 'export async function confirmAllGroups(');
    const [lock, ask, clock, write] = at(
      body,
      'mutateRequest(requestId',
      'await refuseIfAmendedSinceInTx(tx, requestId, sawRev)',
      'locked.rev !== warnings.rev',
      '.update(calcGroups)',
    );
    expect(lock).toBeLessThan(ask!);
    expect(ask).toBeLessThan(clock!);
    expect(ask).toBeLessThan(write!);
  });

  it('the seal — right after lockRequestInTx, before its own CAS and the closing UPDATE', () => {
    const body = bodyOf(ws, 'export async function sealCalc(');
    const [lock, ask, clock, write] = at(
      body,
      'await lockRequestInTx(tx, requestId)',
      'await refuseIfAmendedSinceInTx(tx, requestId, input.sawRev)',
      'locked.rev !== workspace.rev',
      '.update(calcRequests)',
    );
    expect(lock).toBeLessThan(ask!);
    expect(ask).toBeLessThan(clock!);
    expect(ask).toBeLessThan(write!);
  });
});

describe('«Готово» carries it into its own close (§10A.2 rule 1)', () => {
  const service = read(SERVICE);

  it('finishCalcRequest passes notAmendedSince to endRequest, and names the refusal', () => {
    const body = bodyOf(service, 'export async function finishCalcRequest(');
    const call = body.slice(body.indexOf('await endRequest('));
    expect(call.slice(0, call.indexOf('});'))).toContain('notAmendedSince: sawRev');
    // Literal, never through a variable: calc-error-words.test.ts derives its
    // list from exactly this shape (§12).
    expect(body).toContain("new CalcError('amended_since')");
  });

  it('endRequest locks the row FIRST, then ANDs the predicate into the UPDATE', () => {
    // A READ COMMITTED UPDATE that waited for the add door's row lock
    // re-checks the ROW, not its sub-select: without the lock first, an
    // addition committed meanwhile is invisible to the NOT EXISTS (measured,
    // §10A deviation — the integration file's race case is the behaviour).
    const body = bodyOf(service, 'async function endRequest(');
    const [built, lock, where] = at(
      body,
      'amendedSinceSql(id, patch.notAmendedSince)',
      'FOR UPDATE',
      'openRequests, unamended)',
    );
    expect(built).toBeLessThan(lock!);
    expect(lock).toBeLessThan(where!);
    expect(body).toMatch(/const unamended = sql`NOT \$\{amendedSinceSql\(/);
  });

  it('only «Готово» passes it: the hand-back and the task/lines closes write no price', () => {
    const passing = [...service.matchAll(/notAmendedSince:/g)];
    expect(passing).toHaveLength(1);
  });
});

describe('every button presses with its screen’s revision (§10A.1, five call sites)', () => {
  it('«✅ Hammasini» and the group ✅ on the desktop grid', () => {
    const sf = parse(`${PAGE_DIR}/items-table.tsx`);
    expect(callsOf(sf, 'confirmAllAction')).toEqual([['id', 'workspace.rev']]);
    expect(callsOf(sf, 'confirmGroupAction')).toEqual([['id', 'group.id', "'single'", 'sawRev']]);
    // The footer's `sawRev` is the screen's own, handed down unchanged.
    expect(jsxAttr(sf, 'ItemRowBlock', 'sawRev')).toEqual(['workspace.rev']);
    expect(jsxAttr(sf, 'BlockFooter', 'sawRev')).toEqual(['sawRev']);
  });

  it('the phone’s ✅', () => {
    const sf = parse(`${PAGE_DIR}/phone-blocks.tsx`);
    expect(callsOf(sf, 'confirmGroupAction')).toEqual([['id', 'group.id', "'phone'", 'workspace.rev']]);
  });

  it('«Muhrlash» (one SealPanel for phone and desktop)', () => {
    const sf = parse(`${PAGE_DIR}/calc-workspace.tsx`);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'sealAction') {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.arguments[1]!;
    expect(ts.isObjectLiteralExpression(input)).toBe(true);
    const rev = (input as ts.ObjectLiteralExpression).properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'sawRev',
    );
    expect(rev?.initializer.getText(sf)).toBe('workspace.rev');
  });

  it('the «Готово» fold presses with the revision it was OPENED over (review adv-1)', () => {
    const fold = parse(`${PAGE_DIR}/calc-actions.tsx`);
    const calls = callsOf(fold, 'finishCalcAction');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(4);
    // The prop moves on every refresh while the typed amount survives it in
    // state: pressing with the prop would carry a newer revision than the
    // money was typed for.
    expect(calls[0]![3]).toBe('foldRev ?? sawRev');
    // The snapshot is written in exactly two places, in source order: the
    // success's clear, and the opening (the screen as it stands then). No
    // effect copies the prop into it — that would be the defect again.
    expect(callsOf(fold, 'setFoldRev')).toEqual([['null'], ["mode === 'finish' ? null : sawRev"]]);
  });

  it('the page hands the fold the OLDER of the two clocks it was drawn from (review adv-2)', () => {
    const page = parse(`${PAGE_DIR}/page.tsx`);
    expect(jsxAttr(page, 'CalcActions', 'sawRev')).toEqual(['drawnRev']);
    // `row` (the header, the checklist, the read-only goods) is read before
    // `loadWorkspace`: the newer clock would fail OPEN for an addition that
    // landed between the two reads. A server-behind page has no workspace.
    const inits: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'drawnRev') {
        inits.push(node.initializer!.getText(page));
      }
      ts.forEachChild(node, visit);
    };
    visit(page);
    expect(inits).toEqual(['workspace ? Math.min(row.rev, workspace.rev) : row.rev']);
  });

  it('no door without a screen presses the four (each has one caller, the action)', () => {
    const doors = ['finishCalcRequest', 'confirmGroup', 'confirmAllGroups', 'sealCalc'];
    for (const door of doors) {
      const callers = srcFiles()
        .filter(({ text }) => new RegExp(`(?<![\\w.])${door}\\(`).test(text.replace(/export async function \w+\(/g, '')))
        .map(({ path }) => path);
      expect(callers, door).toEqual([ACTIONS]);
    }
  });
});
