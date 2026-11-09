import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The halves of the unpriced-cargo ban (0104) that call `authorize()` or live
 * in a component, and so cannot be pressed from an integration test (#531 —
 * a service-level test of a form-fed path proves the service, not the
 * system). Source-shape on purpose; comments are stripped first, or a fence
 * matches the sentence explaining itself (#725).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));
const between = (src: string, from: string, to: string) => {
  const start = src.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end === -1 ? undefined : end);
};

describe('the ban at the counter', () => {
  // REWRITTEN in 0114 (the owner's 2a), recorded rather than silently
  // dropped (#974): this pinned the ACTION's `has('finance.debt_override')`
  // check, which 0114 deletes on purpose — WHO may tick now depends on whose
  // client it is, so the service asks `mayGrantDebt` with the actor and the
  // action holds no second copy of the rule (#531). The same refusal code
  // reaches the screen from the service.
  it('the service asks both ticks, each by its own rule — the action holds no copy', () => {
    const action = between(read('src/app/(protected)/issue/actions.ts'), 'export async function issueBoxesAction', '\n}');
    expect(action).not.toContain("has('finance.debt_override')");
    expect(action).toMatch(/issueBoxes\(parsed\.data, \{ actorId: actor\.id, \.\.\.meta \}, actor\)/);
    const fn = between(read('src/modules/wms/issue/service.ts'), 'export async function issueBoxes', 'async function notifyUnpricedIssued');
    // The price tick answers `mayOverridePrice` (the grant alone, as before
    // 0114), the debt tick `mayGrantDebt` — two rules since the owner's 2a
    // answered a question about debt only (the qarz judge's #12).
    expect(fn).toContain("if (gated.length > 0 && input.priceOk && !mayOverridePrice(releaser)) throw new IssueError('price_override_forbidden');");
    expect(fn).toContain("if (debtBlocks(balance, deferred) && input.debtOk && !mayGrant) throw new IssueError('debt_override_forbidden');");
    // …and the list route draws each tick by the same predicate the service asks.
    const route = read('src/app/api/issue/list/route.ts');
    expect(route).toContain('const canOverridePrice = mayOverridePrice(actor);');
    const screen = read('src/app/(protected)/issue/issue-screen.tsx');
    expect(screen).toContain('{canOverridePrice && selectedGated.length > 0 && (');
  });

  it('the schema carries the tick, the screen posts it, the list route says which boxes are gated', () => {
    expect(read('src/modules/wms/issue/service.ts')).toMatch(/priceOk: z\.boolean\(\)\.default\(false\)/);
    const screen = read('src/app/(protected)/issue/issue-screen.tsx');
    expect(between(screen, 'await issueBoxesAction({', '});')).toMatch(/\bpriceOk,/);
    expect(screen).toContain('data-testid="issue-price-ok"');
    const route = read('src/app/api/issue/list/route.ts');
    expect(route).toMatch(/gated: gatedIds\.has\(row\.boxId\)/);
    expect(route).toMatch(/\n\s+unpriced,\n/);
  });

  it('in issueBoxes: the ban read on the pool BEFORE the transaction, the price check AFTER the replay return', () => {
    const service = read('src/modules/wms/issue/service.ts');
    const fn = between(service, 'export async function issueBoxes', 'async function notifyUnpricedIssued');
    expect(fn.indexOf('unpricedGate()')).toBeGreaterThan(-1);
    expect(fn.indexOf('unpricedGate()')).toBeLessThan(fn.indexOf('db.transaction('));
    expect(fn.indexOf('if (existing) return')).toBeLessThan(fn.indexOf('uncoveredBoxesOn(tx,'));
    expect(fn.indexOf('uncoveredBoxesOn(tx,')).toBeLessThan(fn.indexOf('const needPrice'));
  });

  it('issueBoxes is the ONLY writer of a client handover — the ban cannot be walked round', () => {
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && /kind: 'issued_to_client'/.test(read(path))) writers.push(path);
      }
    };
    walk('src');
    expect(writers).toEqual(['src/modules/wms/issue/service.ts']);
  });

  it('deciding is the override: /approvals’ action authorizes finance.debt_override itself', () => {
    const action = between(
      read('src/app/(protected)/issue/actions.ts'),
      'export async function decideIssueApprovalAction',
      'const meta',
    );
    expect(action).toContain("authorize('finance.debt_override')");
    expect(action).not.toContain("authorize('finance.view')");
  });

  it('finishLoading tells about a priced carton it left behind — AFTER its transaction, with THIS press’s ids', () => {
    const fn = between(read('src/modules/wms/scanning/service.ts'), 'export async function finishLoading', 'async function notifyLoadSummary');
    const then = fn.indexOf('}).then(async (result) => {');
    expect(then).toBeGreaterThan(-1);
    expect(fn.indexOf('notifyPricedCargoLeft(batchId, result.shortLoadedIds, ctx.actorId)')).toBeGreaterThan(then);
    expect(fn).toMatch(/shortLoadedIds: shortLoaded\.map\(\(b\) => b\.id\)/);
  });

  // Rewritten with the price table (docs/NARX-VA-RAQAM.md §3.1.13): the truck
  // branch left addTransaction for the pool half both doors share, so the
  // fence follows it there — sliced to the next declaration, never to the
  // position of addTransaction's neighbour (judge F2).
  it('a truck price names cargo aboard: the shared pool half asks cargoAboard AFTER the internal-leg refusal', () => {
    const service = read('src/modules/wms/finance/service.ts');
    const fn = between(service, 'export async function prepareTruckCharges', '\nexport ');
    const internal = fn.indexOf("throw new FinanceError('internal_batch')");
    const aboard = fn.indexOf("if (!aboard.aboard) throw new FinanceError('client_not_aboard')");
    expect(internal).toBeGreaterThan(-1);
    expect(aboard).toBeGreaterThan(internal);
    // …and both truck doors go through it.
    expect(between(service, 'export async function addTransaction(', '\nexport ')).toContain('await prepareTruckCharges({');
    expect(between(service, 'export async function addTruckPrices(', '\nexport ')).toContain('await prepareTruckCharges({');
  });

  it('«Ko‘chirish» and the price table admit exactly who the charge door admits — the same authorize and nothing else', () => {
    const actions = read('src/app/(protected)/finance/actions.ts');
    const add = between(actions, 'export async function addTransactionAction', 'const voidSchema');
    const move = between(actions, 'export async function moveChargeAction', 'export async function placePaymentAction');
    const table = between(actions, 'export async function addTruckPricesAction', '\nexport ');
    const grant = /authorize\('([a-z.]+)'\)/;
    for (const [name, body] of [
      ['moveChargeAction', move],
      ['addTruckPricesAction', table],
    ] as const) {
      expect(body.match(grant)?.[1], name).toBe(add.match(grant)?.[1]);
      expect(body.match(/authorize\(/g), name).toHaveLength(1);
    }
    // A truck price moves no kassa: none of the ledger door's till branches
    // applies, and the table posts no account at all (judge F7).
    expect(table).not.toContain('mayPickTill');
    expect(table).not.toContain('accountId');
  });

  it('the company-wide reads run without JIT — measured: ~3 s of compile per call on a 60k-carton book', () => {
    expect(read('src/modules/wms/reports/business.ts')).toMatch(/withoutJit\(\(exec\) =>\s*unpricedReceiptsOn\(exec, \{ kind: 'company'/);
    expect(read('src/modules/wms/home/role-flows.ts')).toContain(
      'withoutJit((exec) => unpricedCount(exec, undefined), { timeoutMs: UNBILLED_BUDGET_MS }).catch(',
    );
    const page = read('src/app/(protected)/finance/narxsiz/page.tsx');
    expect(page).toMatch(/withoutJit\(\(exec\) =>\s*unpricedReceiptsOn\(\s*exec,/);
    expect(page).toMatch(/withoutJit\(\(exec\) =>\s*unattachedChargesByClient\(exec,/);
    expect(read('src/modules/platform/db/no-jit.ts')).toContain('SET LOCAL jit = off');
  });

  it('the settings door asks the value’s validator BEFORE anything is stored, and refuses in words', () => {
    const action = between(read('src/app/(protected)/admin/settings/actions.ts'), 'export async function updateSettingAction', '\n}');
    const asked = action.indexOf('if (validator && !validator(raw.trim())) redirect(');
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(action.indexOf('await setSetting('));
    expect(read('src/app/(protected)/admin/settings/page.tsx')).toContain('data-testid="setting-bad"');
  });
});
