import { describe, expect, it } from 'vitest';
import { buildTools, isAnalyst, type AssistantActor } from '@/modules/platform/ai/tools';

/**
 * The tool map IS the tier: run_sql (and the two money tools) must not exist
 * for anyone but the super_admin/admin ROLE — an absent tool is a refusal a
 * hallucination cannot argue with. Building the map runs nothing (the wms
 * wrappers are dynamic imports inside run), so this is a unit question.
 */

function actorWith(roles: string[]): AssistantActor {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    fullName: 'Test',
    locale: 'uz',
    roles,
    permissions: new Set<string>(),
    warehouseScoped: false,
    warehouseIds: [],
  };
}

describe('the assistant toolset per actor', () => {
  it('gives every staff actor the three scoped wrappers and nothing more', () => {
    const names = buildTools(actorWith(['sales_manager'])).map((tool) => tool.name);
    expect(names).toEqual(['lookup_code', 'search', 'my_day']);
  });

  it('opens the analyst tools on the ROLE, not on any permission', () => {
    // A permission-rich non-admin still gets no SQL: breadth here is the
    // round-21 shape — super_admin/admin, a stated reversible widening.
    const rich = actorWith(['sales_manager']);
    rich.permissions = new Set(['finance.manage', 'clients.manage', 'admin.settings.manage']);
    expect(buildTools(rich).map((t) => t.name)).not.toContain('run_sql');

    for (const role of ['admin', 'super_admin']) {
      const names = buildTools(actorWith([role])).map((tool) => tool.name);
      expect(names).toContain('run_sql');
      expect(names).toContain('cash_flow');
      expect(names).toContain('company_balance');
    }
  });

  it('isAnalyst answers the same question the map does', () => {
    expect(isAnalyst(actorWith(['admin']))).toBe(true);
    expect(isAnalyst(actorWith(['super_admin', 'viewer']))).toBe(true);
    expect(isAnalyst(actorWith(['accountant', 'logist']))).toBe(false);
  });
});
