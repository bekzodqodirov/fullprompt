import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The four halves of «which cost type is the seller's share booked under».
 *
 * `upsale_expense_category_id` is a setting, so the generic settings screen
 * renders it as a mono box asking for a uuid — and no screen in this app
 * prints a category's id, so that box is a control nobody can use. The real
 * door is a picker on `/upsale`. It is an ACTION, so no integration test can
 * press it (#531's third outing): the wiring is pinned as source shape and
 * the rule itself is proven against a real database in
 * `tests/integration/upsale.integration.test.ts`.
 */
const read = (p: string) => readFileSync(p, 'utf8');

const FORM = read('src/app/(protected)/upsale/pay-form.tsx');
const ACTIONS = read('src/app/(protected)/upsale/actions.ts');
const PAGE = read('src/app/(protected)/upsale/page.tsx');
const SERVICE = read('src/modules/wms/calc/upsale-service.ts');

describe('the upsale category picker is wired end to end', () => {
  it('the form posts the name the action reads', () => {
    expect(FORM).toContain('name="categoryId"');
    expect(FORM).toContain('setUpsaleCategoryAction');
    expect(ACTIONS).toContain("formData.get('categoryId')");
  });

  it('the action gates on the settings permission, not on the payer’s', () => {
    // `finance.expenses` is the accountant's power to spend; naming the
    // company's cost types is the owner's. Gating this on the payer would let
    // whoever presses «to'lash» re-book every future commission.
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function setUpsaleCategoryAction'));
    expect(fn).toContain("permissions.has('admin.settings.manage')");
    expect(fn).not.toContain("permissions.has('finance.expenses')");
  });

  it('the screen draws the picker for exactly the people the action accepts', () => {
    // A door that shows what it will not let you press is not a door (E1's
    // own finding, one screen over).
    expect(PAGE).toContain("mayChoose={actor.permissions.has('admin.settings.manage')}");
    expect(FORM).toContain('mayChoose ? (');
  });

  it('the service re-checks the id against the table, active only', () => {
    // A picker's bad value is a forged post, and a retired category would be
    // accepted once and then quietly stop being postable.
    const fn = SERVICE.slice(SERVICE.indexOf('export async function setUpsaleCategory'));
    expect(fn).toContain('expenseCategories');
    expect(fn).toContain('eq(expenseCategories.active, true)');
    expect(fn).toContain("throw new CalcError('category_not_found')");
  });

  it('both doors audit the setting under one entity', () => {
    // Two ids would split one setting's history in half.
    expect(SERVICE).toContain('SETTINGS_AUDIT_ID');
    expect(read('src/app/(protected)/admin/settings/actions.ts')).toContain('SETTINGS_AUDIT_ID');
  });
});
