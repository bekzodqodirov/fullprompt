import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The twin warning's and the add door's WIRING (docs/SARFLAR.md §8.2/§8.5).
 * The three actions call `authorize()`, so no integration test can press them
 * (#531): the order of the checks is pinned by source shape, comments
 * stripped first so a sentence explaining a rule cannot satisfy it (#725).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

function body(source: string, name: string): string {
  const start = source.search(new RegExp(`(export )?async function ${name}(<[^(]*>)?\\(`));
  expect(start, name).toBeGreaterThan(-1);
  const next = source.slice(start + 1).search(/\n(export )?(async )?function /);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

const COSTS = read('src/app/(protected)/costs/actions.ts');
const ACCOUNTING = read('src/app/(protected)/accounting/actions.ts');
const SERVICE = read('src/modules/wms/costing/service.ts');

describe('the cost form', () => {
  const add = body(COSTS, 'addCostEntryAction');

  it('asks the ADD door on a truck, after the grant', () => {
    expect(add).toContain("if (!mayEnterBatchCost(actor, batch)) return { ok: false, error: 'cancelled' };");
    expect(add.indexOf('mayEnterBatchCost(actor, batch)')).toBeGreaterThan(
      add.indexOf("authorize('costs.enter_batch', { warehouseId: batch.originWarehouseId })"),
    );
  });

  it('checks the twins after the payer’s refusal and before the write, and returns without writing', () => {
    const payer = add.indexOf('await payerRefusal(parsed.data, actor.permissions)');
    const twins = add.indexOf('await twinsForCost(readerOf(actor), await costCandidateFrom(parsed.data)');
    const warn = add.indexOf('if (mustWarn(twins, twinAckOf(input))) return { ok: false, twins: twinView(twins!) };');
    const write = add.indexOf('await addCostEntry(parsed.data');
    expect(payer).toBeGreaterThan(-1);
    expect(twins).toBeGreaterThan(payer);
    expect(warn).toBeGreaterThan(twins);
    expect(write).toBeGreaterThan(warn);
    // The acknowledged twins ride into the create audit.
    expect(add).toContain('{ twinAck: twins?.ids.length ? twins.ids : undefined }');
  });
});

describe('the per-prixod grid', () => {
  const grid = body(COSTS, 'saveReceiptCostGridAction');

  it('asks the same ADD door and checks the whole sheet inside the bulk save’s pre-write hook', () => {
    expect(grid).toContain("if (!mayEnterBatchCost(actor, batch)) return { ok: false, error: 'cancelled' };");
    expect(grid).toContain('beforeWrite: async () => {');
    expect(grid).toContain('await twinsForGrid(reader, cells');
    expect(grid).toContain('if (mustWarn(twins, posted)) throw new TwinWarning(twins!);');
    expect(grid).toContain('if (err instanceof TwinWarning) return { ok: false, twins: twinView(err.answer) };');
  });

  it('the bulk save runs the hook after its own refusals and before the first cell', () => {
    const bulk = body(SERVICE, 'addReceiptCostsBulk');
    const hook = bulk.indexOf('const twinAck = opts.beforeWrite ? await opts.beforeWrite() : undefined;');
    expect(hook).toBeGreaterThan(bulk.indexOf("throw new CostError('amount_too_large')"));
    expect(hook).toBeLessThan(bulk.indexOf('for (const cell of input.cells) {\n    try {'));
  });
});

describe('the expense form', () => {
  const add = body(ACCOUNTING, 'addExpenseAction');

  it('checks the twins after the kassa rule and BEFORE the rasxod xabari’s claim (a write)', () => {
    const kassa = add.indexOf('await needsKassaOrPayer(parsed.data.categoryId, parsed.data)');
    const twins = add.indexOf('await twinsForExpense(');
    const warn = add.indexOf('if (mustWarn(twins, posted)) throw new TwinWarning(twins!);');
    const claim = add.indexOf('await claimExpenseRequest(requestId, ctx);');
    expect(kassa).toBeGreaterThan(-1);
    expect(twins).toBeGreaterThan(kassa);
    expect(warn).toBeGreaterThan(twins);
    expect(claim).toBeGreaterThan(warn);
  });

  it('the form posts from onSubmit, never through action= — React resets a form whose action returns (B5)', () => {
    const form = read('src/app/(protected)/accounting/expenses/expense-form.tsx');
    // From `<form` to its className — `[^>]*` would stop at the `=>` inside onSubmit.
    const start = form.indexOf('<form');
    const tag = form.slice(start, form.indexOf('className=', start));
    expect(tag).toContain('onSubmit=');
    expect(tag).not.toMatch(/\baction=/);
    // A landed save still empties the form, explicitly.
    expect(form).toContain('if (state.ok) formRef.current?.reset();');
  });

  it('run() answers a warning as a state, never a thrown page', () => {
    const run = body(ACCOUNTING, 'run');
    expect(run).toContain('if (err instanceof TwinWarning) return { twins: twinView(err.answer) };');
  });
});

describe('the engine never asks about the reader', () => {
  it('addCostEntry and addGridCell reference no twin rule (§8.2’s fence)', () => {
    expect(body(SERVICE, 'addCostEntry')).not.toMatch(/twinsFor/);
    expect(body(SERVICE, 'addGridCell')).not.toMatch(/twinsFor/);
  });

  it('addCostEntry re-asks the cancelled truck under its lock and writes the audit on the transaction', () => {
    const add = body(SERVICE, 'addCostEntry');
    expect(add).toContain('FROM batches WHERE id = ${target.batchId}::uuid FOR SHARE');
    expect(add).toContain("if (batch.status === 'cancelled') throw new CostError('cancelled');");
    expect(add).toMatch(/await writeAudit\(tx, ctx, \{\s*entityType: 'cost_entry'/);
  });
});
