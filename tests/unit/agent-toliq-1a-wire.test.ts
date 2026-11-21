import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Stage 1a, P1 «To'siq» — the wire (docs/ai-toliq/qurish/STAGE-0-1A.md §7, J3, J10, J26). Source shapes read with
 * TypeScript's own parser, so a sentence in a comment is never a site (#725):
 *  - what 1a removes is DELETED, not hidden: no declaration, no call, no import of the confidence floor's writer, its
 *    action and its bounds, the streak's reader, the «botmisiz?» step-down — a control off the screen whose action
 *    still answers is hidden, not removed;
 *  - ONE warning predicate: the gate defines it, the ✅'s machine press imports it, and neither keeps a list of its own;
 *  - ONE place a reply is written and pressed at once (J10): `writeDraft` is called by `writeReply` alone, `pressNow`
 *    sits in its own try/catch right after it, and both run paths write through it;
 *  - the run's tool calls reach its ledger row before the draft is written (J3), on both run paths;
 *  - `pressNow`'s catch settles its row from the draft, as the sweep's does (J10).
 */

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Every identifier the file holds as CODE (declarations, calls, imports, properties) — comments are no nodes. */
function identifiers(source: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) out.add(node.text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out;
}

/** The named function (a declaration) in a file. */
function functionNamed(source: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  let found: ts.FunctionDeclaration | null = null;
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (!found) ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

/** Every call of `callee` (a bare identifier) under `node`, in source order. */
function callsOf(node: ts.Node, callee: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === callee) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return out;
}

/** The function declaration a node stands in. */
function enclosingFunction(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
  }
  return null;
}

/** Does the node stand inside the TRY block of a try statement (never its catch or finally)? */
function insideTryBlock(node: ts.Node): boolean {
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    if (ts.isTryStatement(n.parent) && n.parent.tryBlock === n) return true;
  }
  return false;
}

const SRC = filesUnder('src');

/** Every file's identifiers, read once for the whole file of tests. */
let srcIds: Map<string, Set<string>> | null = null;
function idsOfSrc(): Map<string, Set<string>> {
  srcIds ??= new Map(SRC.map((file) => [file, identifiers(parse(file))]));
  return srcIds;
}

describe('what stage 1a removes is deleted, not hidden', () => {
  /** Each name and why it went — none may stand anywhere in `src` as code. */
  const GONE: Record<string, string> = {
    setAutoMinConfidence: 'the confidence floor’s writer — the gate reads no rating (§6.2)',
    agentAutoMinConfidenceAction: 'its web action — a control off the screen whose action still answers is hidden, not removed',
    AUTO_CONFIDENCE_PCT: 'its bounds (J26)',
    AutoConfidenceForm: 'its box (the kernel took it off the page)',
    autoStreak: 'the two-in-a-row reader — the loop detector (P2) takes the slot',
    AUTO_STREAK_MAX: 'the streak’s number',
    autoStepDownOnBotQuestion: 'the «botmisiz?» step-down — his 1 b: the AI answers it itself',
    botQuestionChatsToDisarm: 'that step-down’s number',
  };

  it.each(Object.entries(GONE))('%s — %s', (name) => {
    const holders = [...idsOfSrc()].filter(([, ids]) => ids.has(name)).map(([file]) => file);
    expect(holders, `${name} is still code in`).toEqual([]);
  });

  it('…while the words of every stored reason stay (a verdict or a disarm written before the deploy still prints)', () => {
    const gate = identifiers(parse('src/modules/wms/agent/auto-gate.ts'));
    expect(gate.has('RETIRED_REFUSAL_WORDS')).toBe(true);
    const card = readFileSync('src/modules/wms/agent/auto-card.ts', 'utf8');
    expect(card).toMatch(/bot_question: '7 kun ichida/u);
  });
});

describe('ONE warning predicate — the gate and the ✅’s machine press ask the same', () => {
  it('the gate defines `stopsMachine` and asks it for its warnings AND its notes', () => {
    const gate = parse('src/modules/wms/agent/auto-gate.ts');
    expect(functionNamed(gate, 'stopsMachine'), 're-anchor: stopsMachine').not.toBeNull();
    const verdict = functionNamed(gate, 'autoVerdict')!;
    const kinds = callsOf(verdict, 'stopsMachine').map((c) => (c.arguments[0] as ts.StringLiteral).text);
    expect(kinds.sort()).toEqual(['note', 'warning']);
  });

  it('decide imports it from the gate and asks it on the policy it runs again — and holds no list of its own', () => {
    const decide = parse('src/modules/wms/agent/decide.ts');
    const imported = decide.statements
      .filter(ts.isImportDeclaration)
      .filter((d) => (d.moduleSpecifier as ts.StringLiteral).text === './auto-gate')
      .flatMap((d) => {
        const named = d.importClause?.namedBindings;
        return named && ts.isNamedImports(named) ? named.elements.map((e) => e.name.text) : [];
      });
    expect(imported).toContain('stopsMachine');
    const calls = callsOf(decide, 'stopsMachine');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect((c.arguments[0] as ts.StringLiteral).text).toBe('warning');
    // No eye-only list beside it: neither the gate's list's name nor its member as a literal.
    const strings: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) strings.push(n.text);
      ts.forEachChild(n, walk);
    };
    walk(decide);
    expect(strings).not.toContain('questions');
    expect(identifiers(decide).has('EYE_ONLY_WARNINGS')).toBe(false);
  });
});

describe('ONE write-and-press site in the run (J3, J10)', () => {
  const run = parse('src/modules/wms/agent/run.ts');

  it('`writeDraft` is called by `writeReply` alone, and `pressNow` sits in its own try right after it', () => {
    const writes = callsOf(run, 'writeDraft');
    expect(writes.map(enclosingFunction)).toEqual(['writeReply']);
    const presses = callsOf(run, 'pressNow');
    expect(presses.map(enclosingFunction)).toEqual(['writeReply']);
    expect(insideTryBlock(presses[0]!)).toBe(true);
    expect(presses[0]!.getStart()).toBeGreaterThan(writes[0]!.getStart());
    // The run's own tool calls go into the press (J3).
    expect(presses[0]!.arguments.map((a) => a.getText())).toEqual(['written.draftId', 'now()', 'tools']);
  });

  it('both run paths write through it, and write the run’s tool calls onto its row before they do (J3)', () => {
    for (const path of ['handleInbound', 'runOwnerTriggered']) {
      const fn = functionNamed(run, path)!;
      expect(fn, `re-anchor: ${path}`).not.toBeNull();
      const writes = callsOf(fn, 'writeReply');
      expect(writes, path).toHaveLength(1);
      expect(writes[0]!.arguments[1]!.getText(), path).toBe('loop.tools');
      const loop = callsOf(fn, 'runLoop');
      const early = callsOf(fn, 'settleToolCalls');
      expect(early, path).toHaveLength(1);
      expect(early[0]!.getStart(), path).toBeGreaterThan(loop[0]!.getStart());
      expect(early[0]!.getStart(), path).toBeLessThan(writes[0]!.getStart());
    }
  });
});

describe('the press at once (J3, J10)', () => {
  const send = parse('src/modules/wms/agent/auto-send.ts');

  it('`pressNow` hands the run’s tools to the press, and its catch settles the row from the draft as the sweep does', () => {
    const fn = functionNamed(send, 'pressNow')!;
    expect(fn, 're-anchor: pressNow').not.toBeNull();
    const press = callsOf(fn, 'pressAndRing');
    expect(press).toHaveLength(1);
    expect(press[0]!.arguments.map((a) => a.getText())).toEqual(['row', 'now', 'tools']);
    expect(insideTryBlock(press[0]!)).toBe(true);
    let settled = false;
    const walk = (n: ts.Node): void => {
      if (ts.isCatchClause(n) && callsOf(n.block, 'settleFromDraft').length > 0) settled = true;
      ts.forEachChild(n, walk);
    };
    walk(fn);
    expect(settled).toBe(true);
  });

  it('the sweep presses through the same ring as the run (a refused hold-0 card rings either way)', () => {
    const sweep = functionNamed(send, 'pressDueAutos')!;
    expect(callsOf(sweep, 'pressAndRing')).toHaveLength(1);
    expect(callsOf(sweep, 'pressOne')).toHaveLength(0);
    // …and the night's held replies are judged again before its claim (J31).
    const rejudge = callsOf(sweep, 'rejudgeNightHeld');
    expect(rejudge).toHaveLength(1);
  });
});

describe('his boxes, by the names he was promised (J34)', () => {
  it('«Oddiy javob kutishi (soniya)» — the talk hold — and the words the bot and the page say of it', () => {
    const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8')) as { agentAi: Record<string, unknown> };
    expect(uz.agentAi.autoTalkHoldLabel).toBe('Oddiy javob kutishi (soniya)');
    expect(String(uz.agentAi.autoTalkHoldHint)).toContain('{max}');
    // The page draws the three boxes in its auto panel, each with its own action (never a shared block, §8).
    const page = readFileSync('src/app/(protected)/suhbatlar/ai/page.tsx', 'utf8');
    for (const box of ['AutoTalkHoldForm', 'AutoPriceHoldForm', 'AutoNightForm']) expect(page, box).toContain(`<${box}`);
    const ui = readFileSync('src/app/(protected)/suhbatlar/ai/agent-ui.tsx', 'utf8');
    for (const action of ['agentAutoTalkHoldAction', 'agentAutoPriceHoldAction', 'agentAutoNightAction']) expect(ui, action).toContain(action);
  });
});

describe('the page’s 👎 follows the service’s door (review nit 3)', () => {
  const page = parse('src/app/(protected)/suhbatlar/ai/page.tsx');

  /** The JSX attribute `name` on every `<tag … />` of the page, as written. */
  function attrOf(tag: string, name: string): string[] {
    const out: string[] = [];
    const walk = (n: ts.Node): void => {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText() === tag) {
        for (const a of n.attributes.properties) {
          if (ts.isJsxAttribute(a) && a.name.getText() === name && a.initializer && ts.isJsxExpression(a.initializer)) out.push(a.initializer.expression!.getText());
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(page);
    return out;
  }

  it('drawn for the row’s own account OR a super_admin while the holder is the AI seat — `autoFeedback` asks `mayArmAuto`', () => {
    // The condition guarding <AutoBadButton …/>: the left side of its `&&`.
    const guards: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'AutoBadButton') {
        let p: ts.Node = n.parent;
        while (ts.isParenthesizedExpression(p)) p = p.parent;
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) guards.push(p.left.getText());
      }
      ts.forEachChild(n, walk);
    };
    walk(page);
    expect(guards).toEqual(['(row.managerUserId === viewerId || markAnyBad)']);
    // …the seat half is the arm button's own (`mayArmAuto`: a super_admin while the holder IS the seat).
    expect(attrOf('AutoSection', 'markAnyBad')).toEqual(["superAdmin && seat.state === 'holds'"]);
    expect(attrOf('AutoSection', 'mayArm')).toEqual(["holder || (superAdmin && seat.state === 'holds')"]);
    const send = parse('src/modules/wms/agent/auto-send.ts');
    expect(callsOf(functionNamed(send, 'autoFeedback')!, 'mayArmAuto')).toHaveLength(1);
  });
});
