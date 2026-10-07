import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The deal card's two halves (the owner's 17a, 2026-10-07), as WIRING — the
 * halves no integration test can press, because every door below runs
 * `getActor()` (#531's third outing). The rules themselves are behavioural in
 * `deal-door.test.ts` and `deal-ved.integration.test.ts`.
 *
 * DERIVED where it can be: every exported action in `bitimlar/actions.ts` is
 * classified, so a new action arrives unanswered and names itself; and the
 * deal page is PARSED, not grepped, so «the positions and the prixod link
 * never sit under the `terms` gate» survives a fragment wrap that a text
 * search would read past (the review's own red-proof form).
 */
const read = (p: string) => readFileSync(p, 'utf8');
/** Comments out first — a fence must not match the sentence explaining it (#725). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const ACTIONS = code(read('src/app/(protected)/bitimlar/actions.ts'));
const CALC_ACTIONS = code(read('src/app/(protected)/hisoblash/actions.ts'));
const PAGE_PATH = 'src/app/(protected)/bitimlar/[id]/page.tsx';

/** The body of `function name(` up to the next top-level closing brace. */
function bodyOf(src: string, name: string): string {
  const at = src.search(new RegExp(`function ${name}\\b`));
  expect(at, `${name} is not in the file`).toBeGreaterThan(-1);
  const rest = src.slice(at);
  return rest.slice(0, rest.indexOf('\n}') + 2);
}

const TERMS = [
  'createDealAction',
  'updateDealAction',
  'moveDealAction',
  'bulkMoveDealsAction',
  'setDiscountAction',
];
const WORK = ['saveLinesAction', 'linkReceiptAction', 'deferPaymentAction'];
const FUNNEL = ['saveDealStageAction', 'reorderDealStagesAction', 'deleteDealStageAction'];

describe('every deal action names the half it touches', () => {
  const exported = [...ACTIONS.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);

  it('classifies every exported action — a new one cannot inherit a gate by silence', () => {
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      const classes = [TERMS, WORK, FUNNEL].filter((list) => list.includes(name)).length;
      expect(classes, `${name} is in no class (terms / work / funnel) — decide its gate`).toBe(1);
    }
    for (const name of [...TERMS, ...WORK, ...FUNNEL]) expect(exported).toContain(name);
  });

  it('the terms are the seller’s: run(\'terms\', …)', () => {
    for (const name of TERMS) expect(bodyOf(ACTIONS, name), name).toContain("run('terms'");
  });

  it('positions and prixods are both sides’: run(\'work\', …)', () => {
    for (const name of WORK) expect(bodyOf(ACTIONS, name), name).toContain("run('work'");
  });

  it('reshaping the funnel stays crm.manage and never runs through run()', () => {
    for (const name of FUNNEL) {
      const body = bodyOf(ACTIONS, name);
      expect(body, name).toContain("has('crm.manage')");
      expect(body, name).not.toContain('run(');
    }
  });

  it('the gate is REQUIRED — no default — and asks the terms predicate', () => {
    expect(ACTIONS).toMatch(/async function run\(\s*gate: DealGate,/);
    expect(ACTIONS).not.toMatch(/gate\s*:\s*DealGate\s*=/);
    expect(ACTIONS).not.toMatch(/gate\s*=\s*'/);
    const run = bodyOf(ACTIONS, 'run');
    expect(run).toContain('canWriteDeal(actor.permissions)');
    expect(run).toContain("gate === 'terms' && !mayEditDealTerms(actor.permissions)");
  });
});

describe('the calc doors on a deal are the seller’s (G4 a)', () => {
  it('submitCalcAction refuses a deal to whoever lacks the terms', () => {
    expect(bodyOf(CALC_ACTIONS, 'submitCalcAction')).toContain(
      "input.entityType === 'deal' && !mayEditDealTerms(actor.permissions)",
    );
  });

  it('threadCalcGate keeps the card door AND closes both non-lead kinds', () => {
    const gate = bodyOf(CALC_ACTIONS, 'threadCalcGate');
    expect(gate).toContain('canWriteDeal(actor.permissions)');
    expect(gate).toContain("entity.kind !== 'lead' && !mayEditDealTerms(actor.permissions)");
  });
});

describe('the creation doors (G4 a) and the one home of the seller pair', () => {
  it('the new-deal page bounces whoever cannot work terms', () => {
    expect(code(read('src/app/(protected)/bitimlar/new/page.tsx'))).toContain(
      'mayEditDealTerms(actor.permissions)',
    );
  });

  it('«+ Yangi → Bitim» asks the terms predicate, not the card door', () => {
    const layout = code(read('src/app/(protected)/layout.tsx'));
    const line = layout.split('\n').find((l) => l.includes("key: 'deal'"));
    expect(line).toBeDefined();
    expect(line).toContain('mayEditDealTerms(');
    expect(line).not.toContain('canWriteDeal');
  });

  it('upsale-scope asks the same predicate and never restates the pair', () => {
    const scope = code(read('src/modules/wms/calc/upsale-scope.ts'));
    expect(scope).toContain('mayEditDealTerms(');
    expect(scope).not.toContain("has('crm.leads')");
  });

  it('the calc card door’s deal arm is the board’s own fragment', () => {
    const door = code(read('src/modules/wms/calc/card-door.ts'));
    expect(door).toContain('dealCarriesCalcSql');
    const fn = door.slice(door.indexOf('export async function calcCardExists'));
    // From the deal branch to the lead arm's own statement (comments are
    // stripped, so the end marker is code, not the sentence above it).
    const start = fn.indexOf("if (entity.entityType === 'deal')");
    const end = fn.indexOf('const rows = await db.execute');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const dealArm = fn.slice(start, end);
    expect(dealArm).toContain('dealCarriesCalcSql(');
    expect(dealArm).not.toContain('r.entity_type = ${entity.entityType}');
  });

  it('⌘K scopes deals by the board’s shape', () => {
    const body = bodyOf(code(read('src/modules/wms/search/service.ts')), 'searchDeals');
    expect(body).toContain('dealBoardShape(actor.permissions)');
    expect(body).toContain('vedWorkSql(');
  });
});

describe('the read-only board', () => {
  it('the deal board passes no onMove and no bulk bar when read-only', () => {
    const board = code(read('src/app/(protected)/bitimlar/board.tsx'));
    expect(board).toMatch(/onMove=\{\s*readOnly\s*\?\s*undefined\s*:/);
    expect(board).toMatch(/\{!readOnly && \(?\s*<BulkBar/);
  });

  it('the kanban takes onMove as optional and draws no ticks without it', () => {
    const kanban = code(read('src/components/kanban.tsx'));
    expect(kanban).toMatch(/onMove\?: \(/);
    expect(kanban).toContain('const ticks = onMove ? selection : undefined');
  });
});

// ---------------------------------------------------------------------------
// The deal page, PARSED with TypeScript (the sibling-keys precedent).

const page = ts.createSourceFile(PAGE_PATH, read(PAGE_PATH), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function tagName(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return null;
}

function attrsOf(node: ts.Node): ts.JsxAttributes | null {
  if (ts.isJsxElement(node)) return node.openingElement.attributes;
  if (ts.isJsxSelfClosingElement(node)) return node.attributes;
  return null;
}

function attr(node: ts.Node, name: string): ts.JsxAttribute | undefined {
  const attrs = attrsOf(node);
  return attrs?.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

function elements(name: string): ts.Node[] {
  const found: ts.Node[] = [];
  const walk = (node: ts.Node) => {
    if (tagName(node) === name) found.push(node);
    ts.forEachChild(node, walk);
  };
  walk(page);
  return found;
}

/** Does this expression mention the identifier `terms` anywhere (any polarity)? */
function mentionsTerms(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === 'terms') return true;
  return ts.forEachChild(node, (child) => (mentionsTerms(child) ? true : undefined)) ?? false;
}

/** Every `&&` / `?:` above this element whose condition mentions `terms`. */
function gatesOf(node: ts.Node): ts.Node[] {
  const gates: ts.Node[] = [];
  for (let at = node.parent; at && !ts.isSourceFile(at); at = at.parent) {
    if (
      ts.isBinaryExpression(at) &&
      at.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      mentionsTerms(at.left)
    ) {
      gates.push(at);
    }
    if (ts.isConditionalExpression(at) && mentionsTerms(at.condition)) gates.push(at);
  }
  return gates;
}

/** Is there an ancestor `&&` whose LEFT operand is exactly the identifier `terms`? */
function gatedByTerms(node: ts.Node): boolean {
  return gatesOf(node).some(
    (g) => ts.isBinaryExpression(g) && ts.isIdentifier(g.left) && g.left.text === 'terms',
  );
}

function panelWithTestId(testId: string): ts.Node {
  const panel = elements('Panel').find((p) => {
    const a = attr(p, 'testId');
    return a?.initializer !== undefined && ts.isStringLiteral(a.initializer) && a.initializer.text === testId;
  });
  expect(panel, `no <Panel testId="${testId}">`).toBeDefined();
  return panel!;
}

describe('the deal page draws the terms for the seller only (parsed)', () => {
  it('the ✏️ and 🏷 panels sit behind `terms &&`', () => {
    expect(gatedByTerms(panelWithTestId('deal-edit-panel')), 'deal-edit-panel').toBe(true);
    expect(gatedByTerms(panelWithTestId('deal-discount-panel')), 'deal-discount-panel').toBe(true);
  });

  it('the positions and the prixod link are NEVER under a gate that mentions terms', () => {
    for (const name of ['LinesForm', 'ImportLines', 'LinkReceipt']) {
      const found = elements(name);
      // A renamed component must not make the assertion vacuous.
      expect(found.length, `<${name}> not found on the deal page`).toBeGreaterThanOrEqual(1);
      for (const node of found) expect(gatesOf(node).length, `<${name}> is gated on terms`).toBe(0);
    }
  });

  it('the 🧮 panel and the thread are read-only for whoever lacks the terms', () => {
    for (const name of ['CalcPanel', 'TelegramThread']) {
      const found = elements(name);
      expect(found.length, `<${name}> not found`).toBeGreaterThanOrEqual(1);
      for (const node of found) {
        const readOnly = attr(node, 'readOnly');
        expect(readOnly?.initializer?.getText(), `<${name}> readOnly`).toBe('{!terms}');
      }
    }
  });
});
