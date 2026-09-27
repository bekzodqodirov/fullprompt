import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reportBaseIds, reportScope, type ScopeActor } from '@/modules/wms/reports/report-scope';

/**
 * The dashboard and the receipts journal its intake chart links to read ONE
 * scope rule (O10). Before this, the journal read `reports.all_warehouses`
 * alone while the dashboard also honoured the role's scoping column, so the
 * same person saw their own warehouses on one screen and the company on the
 * next. And `?ombor=` is a URL parameter: a forged post until the rule has
 * checked it against the viewer's own list (#514).
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';

const owner: ScopeActor = { permissions: new Set(['reports.all_warehouses']), warehouseScoped: false, warehouseIds: [] };
const manager: ScopeActor = { permissions: new Set(['reports.own_warehouse']), warehouseScoped: true, warehouseIds: [A] };
/** An all-warehouse grant on a warehouse-scoped ROLE — the case the journal used to widen. */
const scopedWithAllGrant: ScopeActor = {
  permissions: new Set(['reports.all_warehouses']),
  warehouseScoped: true,
  warehouseIds: [A],
};
const noWarehouse: ScopeActor = { permissions: new Set(['reports.own_warehouse']), warehouseScoped: true, warehouseIds: [] };

describe('reportScope — the one scope rule behind the dashboard and the journal', () => {
  it('an unscoped viewer reads the whole company until a listed warehouse is picked', () => {
    expect(reportScope(owner, null, [{ id: A }, { id: B }])).toEqual({
      scoped: false,
      baseIds: undefined,
      ids: undefined,
      ombor: null,
    });
    expect(reportScope(owner, B, [{ id: A }, { id: B }])).toMatchObject({ scoped: false, ids: [B], ombor: B });
  });

  it('a uuid that is not among the options is dropped — even for the whole-company viewer', () => {
    // A deactivated or deleted warehouse, or anybody's hand-typed id: the
    // options are the list the viewer was OFFERED, and nothing else is a choice.
    expect(reportScope(owner, FOREIGN, [{ id: A }, { id: B }])).toMatchObject({ ids: undefined, ombor: null });
  });

  it('garbage is dropped before it can reach a uuid column', () => {
    for (const raw of ['', '  ', 'YW', 'not-a-uuid', `${A}x`, "1' OR '1'='1", undefined, null]) {
      expect(reportScope(owner, raw, [{ id: A }]).ombor).toBeNull();
    }
  });

  it('the case of a pasted id does not matter, the answer is the option’s own spelling', () => {
    expect(reportScope(owner, A.toUpperCase(), [{ id: A }]).ombor).toBe(A);
  });

  it('a scoped viewer cannot pick outside their own list, whatever options a caller hands in', () => {
    // Options wider than the scope are a caller's mistake; the rule still refuses.
    expect(reportScope(manager, B, [{ id: A }, { id: B }])).toMatchObject({
      scoped: true,
      baseIds: [A],
      ids: [A],
      ombor: null,
    });
    expect(reportScope(manager, A, [{ id: A }])).toMatchObject({ ids: [A], ombor: A });
  });

  it('an all-warehouse grant on a warehouse-scoped role still reads its own warehouses (the narrowing)', () => {
    expect(reportBaseIds(scopedWithAllGrant)).toEqual([A]);
    expect(reportScope(scopedWithAllGrant, null, [{ id: A }])).toMatchObject({ scoped: true, ids: [A] });
  });

  it('an empty scope stays EMPTY — never undefined, which would read the company', () => {
    const scope = reportScope(noWarehouse, A, [{ id: A }]);
    expect(scope.scoped).toBe(true);
    expect(scope.ombor).toBeNull();
    expect(scope.ids).toEqual([]);
    expect(scope.ids).not.toBeUndefined();
  });

  it('the base list is a copy: a caller cannot mutate the actor through it', () => {
    const base = reportBaseIds(manager)!;
    base.push(B);
    expect(manager.warehouseIds).toEqual([A]);
  });
});

describe('the journal reads the shared rule, in both of its doors', () => {
  it('the page and the XLSX route both ask reportScope, and neither keeps its own allWh scope', () => {
    const page = readFileSync('src/app/(protected)/reports/receipts-journal/page.tsx', 'utf8');
    const route = readFileSync('src/app/api/reports/[kind]/route.ts', 'utf8');
    expect(page).toContain('reportScope(actor, ombor, options)');
    expect(page).toContain('receiptsJournal(period, scope.ids)');
    expect(page).toContain('receiptsJournalTotals(period, scope.ids)');
    expect(page).not.toMatch(/allWh \? undefined : actor\.warehouseIds/);
    // The file is the screen it came from (#490): same rule, same parameter.
    const journalCase = route.slice(route.indexOf("case 'receipts-journal'"), route.indexOf("case 'unclaimed'"));
    expect(journalCase).toContain("reportScope(actor, rawOmbor, options).ids");
    expect(journalCase).not.toMatch(/\bscope,/);
  });

  it('the page carries the chosen warehouse on its presets, its sort links and its XLSX link', () => {
    const page = readFileSync('src/app/(protected)/reports/receipts-journal/page.tsx', 'utf8');
    expect(page).toContain('if (scope.ombor) params.ombor = scope.ombor;');
    expect(page).toContain('href={presetHref(d)}');
    expect(page).toContain('/api/reports/receipts-journal?${query}');
  });
});
