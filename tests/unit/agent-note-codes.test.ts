import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { NOTE_CODES } from '@/modules/wms/agent/types';

/**
 * Stage 1a, K5 (docs/ai-toliq/qurish/STAGE-0-1A.md §4.1, J25): every note a reply's card carries goes in with its
 * CODE, because the auto layer frees one note by what it is (`late`) and stops on every other — and «a writer with no
 * code is a machine stop» must not rest on a grep somebody remembers to run. This reads every file under `agent/` with
 * TypeScript's own parser (comments are no nodes, so a sentence about `notes.push(` is never a site) and finds each
 * place a note carrier is WRITTEN:
 *  - a `push` / `unshift` / `splice` onto `notes`, `cardNotes` or `calcNotes` — the very next statement must push the
 *    same number of codes onto its twin (`noteCodes`, `cardNoteCodes`, `calcNoteCodes`), each a `NoteCode` literal;
 *    a spread of another carrier (`...autoPlan.cardNotes`) is answered by the spread of ITS twin;
 *  - an object literal's `notes:` (or shorthand `notes`) — the same literal names the twin, and an array of codes holds
 *    only `NoteCode` literals, as many as the notes;
 *  - a `notes` property of an interface or a type literal, a `const notes`, a destructured `{ notes }` — the twin
 *    stands beside it (a type, a declaration, a binding that carries notes toward the store carries their codes): a
 *    const in the same block or a parameter of the function (the caller's array, filled here); for a destructuring,
 *    taken from the same object or handed into the very call that returns the notes;
 *  - a parameter called `notes` — never paired: it is listed below with its reason, or the fence fails.
 * Whatever is not paired must be on the counted list below — the places a `notes` that never reaches
 * `DraftPolicyJson.notes` or `AutoPlan.cardNotes` is written (the website estimate's own notes, the card's drawn
 * lines, a refusal's word). The count is exact both ways: a new unpaired site in a listed place is red, and so is a
 * listed one that went away.
 */

const ROOT = 'src/modules/wms/agent';

/** A note carrier and the code carrier that must stand beside it. */
const TWIN: Record<string, string> = { notes: 'noteCodes', cardNotes: 'cardNoteCodes', calcNotes: 'calcNoteCodes' };

const CODES: ReadonlySet<string> = new Set(NOTE_CODES);

type Kind = 'push' | 'property' | 'signature' | 'variable' | 'binding' | 'parameter';

interface Site {
  file: string;
  line: number;
  kind: Kind;
  /** The outermost named declaration around it — a function, a top-level const, an interface (`ownerOf`). */
  owner: string;
  /** Why it is not paired; null when its twin stands beside it. */
  problem: string | null;
  /** The codes a paired site writes as literals. */
  codes: string[];
}

/**
 * The places a `notes` is written that never reaches a draft's stored notes or a plan's card lines — each with the
 * number of unpaired sites it holds today and why. Keyed by file › kind › owner, never by line, so an edit above them
 * does not move the fence.
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  // The website estimate (`SiteEstimate.notes`: «min-m3-applied», «range» …) — a price page's footnotes, never a draft.
  'site-estimate.ts › signature › SiteEstimate': { count: 1, why: 'the website estimate’s own footnote list, never a draft' },
  'site-estimate.ts › variable › truck': { count: 1, why: 'the website estimate’s footnotes, built for the website' },
  'site-estimate.ts › push › truck': { count: 1, why: 'the website estimate’s footnotes, built for the website' },
  'site-estimate.ts › property › truck': { count: 2, why: 'the website estimate’s footnotes, built for the website' },
  'site-estimate.ts › variable › air': { count: 1, why: 'the website estimate’s footnotes, built for the website' },
  'site-estimate.ts › push › air': { count: 2, why: 'the website estimate’s footnotes, built for the website' },
  'site-estimate.ts › property › air': { count: 1, why: 'the website estimate’s footnotes, built for the website' },
  'site-estimate.ts › property › siteEstimate': { count: 2, why: 'the website estimate’s footnotes, built for the website' },
  // The card: lines it DRAWS — read from the stored notes, never written back.
  'card.ts › signature › CardInput': { count: 1, why: 'the lines a card draws (`renderDraftCard`), read from the stored notes' },
  'card-io.ts › property › fitCard': { count: 3, why: 'the card’s own «cut» lines, added while fitting it to Telegram’s length — drawn, never stored' },
  'card-io.ts › property › renderDraftCardFull': {
    count: 1,
    why: 'the card’s input: the stored notes read back beside the calc line, the after-sent lines and a refresh’s extras — drawn, never stored',
  },
  'decide.ts › parameter › refreshDraftCard': { count: 1, why: 'a line drawn on the refreshed card (card-io `refreshAgentCard` extras), never stored' },
  'lessons.ts › parameter › refreshCard': { count: 1, why: 'a line drawn on the refreshed card (card-io `refreshAgentCard` extras), never stored' },
  // Readers and words.
  'calibration.ts › signature › CalibrationDraftRow': { count: 1, why: 'a COUNT of a stored draft’s notes, read for the calibration table' },
  'auto-gate.ts › property › AUTO_REFUSAL_WORDS': { count: 1, why: 'the `notes` refusal’s own word, not a note' },
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.tsx?$/u.test(name) ? [p] : [];
  });
}

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => visit(c, fn));
}

/** The last name of an expression: `notes` for `notes`, `cardNotes` for `autoPlan.cardNotes`. */
function terminal(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function nameText(n: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return null;
}

/**
 * The OUTERMOST function, type or top-level const a site stands in — what the list below names it by (a nested arrow
 * is its function's: `renderDraftCardFull`, never its local `input`).
 */
function ownerOf(node: ts.Node): string {
  let owner = '<module>';
  for (let p = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isClassDeclaration(p)) && p.name) owner = p.name.getText();
    else if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) owner = p.name.text;
    else if (ts.isVariableStatement(p) && ts.isSourceFile(p.parent)) {
      const first = p.declarationList.declarations[0];
      if (first && ts.isIdentifier(first.name)) owner = first.name.text;
    }
  }
  return owner;
}

/** A `const name` among these statements. */
function declaredIn(statements: readonly ts.Statement[], name: string): boolean {
  return statements.some((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name));
}

/** A parameter `name` of the function the node stands in — the caller's array, filled here. */
function parameterOf(node: ts.Node, name: string): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) return p.parameters.some((q) => ts.isIdentifier(q.name) && q.name.text === name);
  }
  return false;
}

function unwrapAwait(e: ts.Expression): ts.Expression {
  return ts.isAwaitExpression(e) ? unwrapAwait(e.expression) : ts.isParenthesizedExpression(e) ? unwrapAwait(e.expression) : e;
}

/** `(x ?? [])` and `(x)` read as `x` — the twin may be spread with a fallback. */
function unwrap(e: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(e)) return unwrap(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return unwrap(e.left);
  return e;
}

/** A push of notes and the push of codes that must follow it. */
function pairPush(call: ts.CallExpression, name: string, method: string): { problem: string | null; codes: string[] } {
  const stmt = call.parent;
  if (!ts.isExpressionStatement(stmt) || !(ts.isBlock(stmt.parent) || ts.isSourceFile(stmt.parent))) {
    return { problem: 'not a statement of its own in a block — its codes cannot stand beside it', codes: [] };
  }
  const siblings = stmt.parent.statements;
  const next = siblings[siblings.indexOf(stmt) + 1];
  const twin = next && ts.isExpressionStatement(next) && ts.isCallExpression(next.expression) ? next.expression : null;
  const callee = twin && ts.isPropertyAccessExpression(twin.expression) ? twin.expression : null;
  if (!twin || !callee || callee.name.text !== method || terminal(callee.expression) !== TWIN[name]) {
    return { problem: `no ${TWIN[name]}.${method}(…) as the very next statement`, codes: [] };
  }
  const args = [...call.arguments];
  const codes = [...twin.arguments];
  if (args.length === 1 && ts.isSpreadElement(args[0]!)) {
    const spread = unwrap(args[0]!.expression);
    const from = ts.isPropertyAccessExpression(spread) ? spread.name.text : null;
    const answer = codes.length === 1 && ts.isSpreadElement(codes[0]!) ? unwrap(codes[0]!.expression) : null;
    if (!from || !(from in TWIN) || !answer || !ts.isPropertyAccessExpression(answer)) {
      return { problem: 'a spread the fence cannot pair with its codes', codes: [] };
    }
    const sameHolder = (spread as ts.PropertyAccessExpression).expression.getText() === answer.expression.getText();
    return sameHolder && answer.name.text === TWIN[from] ? { problem: null, codes: [] } : { problem: `the spread’s codes are not its own ${TWIN[from]}`, codes: [] };
  }
  if (args.some((a) => ts.isSpreadElement(a))) return { problem: 'a spread the fence cannot pair with its codes', codes: [] };
  if (codes.length !== args.length) return { problem: `${args.length} note(s), ${codes.length} code(s)`, codes: [] };
  const bad = codes.filter((c) => !ts.isStringLiteral(c) || !CODES.has(c.text));
  if (bad.length > 0) return { problem: `not a NoteCode literal: ${bad.map((b) => b.getText()).join(', ')}`, codes: [] };
  return { problem: null, codes: codes.map((c) => (c as ts.StringLiteral).text) };
}

/** An object literal's notes and the codes it must name beside them. */
function pairProperty(prop: ts.PropertyAssignment | ts.ShorthandPropertyAssignment, name: string): { problem: string | null; codes: string[] } {
  const lit = prop.parent as ts.ObjectLiteralExpression;
  const twin = lit.properties.find(
    (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && nameText(p.name) === TWIN[name],
  );
  if (!twin) return { problem: `no ${TWIN[name]} beside it`, codes: [] };
  if (!ts.isPropertyAssignment(twin) || !ts.isArrayLiteralExpression(twin.initializer)) return { problem: null, codes: [] };
  const elems = [...twin.initializer.elements];
  const bad = elems.filter((e) => !ts.isSpreadElement(e) && (!ts.isStringLiteral(e) || !CODES.has(e.text)));
  if (bad.length > 0) return { problem: `not a NoteCode literal: ${bad.map((b) => b.getText()).join(', ')}`, codes: [] };
  const notes = ts.isPropertyAssignment(prop) && ts.isArrayLiteralExpression(prop.initializer) ? [...prop.initializer.elements] : null;
  if (notes && !notes.some((e) => ts.isSpreadElement(e)) && !elems.some((e) => ts.isSpreadElement(e)) && notes.length !== elems.length) {
    return { problem: `${notes.length} note(s), ${elems.length} code(s)`, codes: [] };
  }
  return { problem: null, codes: elems.filter(ts.isStringLiteral).map((e) => e.text) };
}

function sitesOf(file: string): Site[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rel = file.slice(ROOT.length + 1);
  const out: Site[] = [];
  const at = (n: ts.Node, kind: Kind, problem: string | null, codes: string[] = []) =>
    out.push({ file: rel, line: source.getLineAndCharacterOfPosition(n.getStart()).line + 1, kind, owner: ownerOf(n), problem, codes });
  visit(source, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['push', 'unshift', 'splice'].includes(n.expression.name.text)) {
      const name = terminal(n.expression.expression);
      if (name && name in TWIN) {
        const r = pairPush(n, name, n.expression.name.text);
        at(n, 'push', r.problem, r.codes);
      }
    } else if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isObjectLiteralExpression(n.parent)) {
      const name = nameText(n.name);
      if (name && name in TWIN) {
        const r = pairProperty(n, name);
        at(n, 'property', r.problem, r.codes);
      }
    } else if (ts.isPropertySignature(n)) {
      const name = nameText(n.name);
      if (name && name in TWIN) {
        const members = ts.isInterfaceDeclaration(n.parent) || ts.isTypeLiteralNode(n.parent) ? n.parent.members : [];
        const twin = members.some((m) => ts.isPropertySignature(m) && nameText(m.name) === TWIN[name]);
        at(n, 'signature', twin ? null : `no ${TWIN[name]} beside it`);
      }
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text in TWIN) {
      const name = n.name.text;
      const stmt = n.parent.parent;
      const block = ts.isVariableStatement(stmt) && (ts.isBlock(stmt.parent) || ts.isSourceFile(stmt.parent)) ? stmt.parent.statements : [];
      const twin = declaredIn(block, TWIN[name]!) || parameterOf(n, TWIN[name]!);
      at(n, 'variable', twin ? null : `no const ${TWIN[name]} (nor a parameter) beside it`);
    } else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent)) {
      const name = nameText(n.propertyName ?? n.name);
      if (name && name in TWIN) {
        // Taken beside it from the same object — or handed INTO the call that returns the notes, to be filled
        // (`validateActions(…, noteCodes)`: the run's one array then carries every later code too).
        const taken = n.parent.elements.some((e) => nameText(e.propertyName ?? e.name) === TWIN[name]);
        const decl = n.parent.parent;
        const init = ts.isVariableDeclaration(decl) && decl.initializer ? unwrapAwait(decl.initializer) : null;
        const handed = init !== null && ts.isCallExpression(init) && init.arguments.some((a) => ts.isIdentifier(a) && a.text === TWIN[name]);
        at(n, 'binding', taken || handed ? null : `no ${TWIN[name]} taken beside it, nor handed into the call`);
      }
    } else if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text in TWIN) {
      at(n, 'parameter', 'a parameter carries notes from its caller — listed or not at all');
    }
  });
  return out;
}

const SITES = filesUnder(ROOT).flatMap(sitesOf);
const keyOf = (s: Site) => `${s.file} › ${s.kind} › ${s.owner}`;

describe('every note a reply’s card carries goes in with its code (stage 1a K5, J25)', () => {
  it('the fence reads the writers it names — not an empty tree', () => {
    const paired = SITES.filter((s) => s.problem === null);
    // validateActions' four, the two runs' rail / tariff / late / VED-price / answer notes, calc-submit's two, the plans'.
    expect(paired.filter((s) => s.kind === 'push').length).toBeGreaterThanOrEqual(15);
    for (const file of ['run.ts', 'calc-submit.ts', 'calc-loop.ts', 'drafts.ts', 'auto-send.ts', 'types.ts']) {
      expect(
        paired.some((s) => s.file === file),
        file,
      ).toBe(true);
    }
  });

  it('every unpaired site is a listed one, counted — a note carrier with no code beside it is named by file and line', () => {
    const unpaired = SITES.filter((s) => s.problem !== null);
    const named = unpaired.filter((s) => !(keyOf(s) in ALLOWED)).map((s) => `${s.file}:${s.line} (${s.kind} in ${s.owner}) — ${s.problem}`);
    expect(named).toEqual([]);
    const counts = new Map<string, number>();
    for (const s of unpaired) counts.set(keyOf(s), (counts.get(keyOf(s)) ?? 0) + 1);
    const drift = Object.entries(ALLOWED)
      .filter(([key, a]) => (counts.get(key) ?? 0) !== a.count)
      .map(([key, a]) => `${key}: listed ${a.count}, found ${counts.get(key) ?? 0}`);
    expect(drift).toEqual([]);
  });

  it('every code has a writer, and every writer’s code is one of them', () => {
    const written = new Set(SITES.flatMap((s) => s.codes));
    expect([...CODES].filter((c) => !written.has(c))).toEqual([]);
    for (const c of written) expect(CODES.has(c), c).toBe(true);
  });
});
