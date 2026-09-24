import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The reports audit's fixes that live in a DOOR — an action or a page that
 * calls `authorize`/`getActor` and so cannot be pressed by an integration
 * test (#531). Each assertion names the half of the wire a regression would
 * cut; the service halves are proven in money-audit.integration.test.ts.
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('audit 2026-09-24 — the doors', () => {
  it('A2: the ledger door refuses a payment with no cash box, and the form asks for one', () => {
    const action = read('src/app/(protected)/finance/actions.ts');
    expect(action).toMatch(/type === 'payment' && !parsed\.data\.accountId\) return \{ error: 'account_required' \}/);
    const form = read('src/app/(protected)/finance/[clientId]/tx-form.tsx');
    expect(form).toMatch(/name="accountId"[^>]*required/);
    expect(form).toContain('max={latestTxDate()}');
  });

  it("A5: the dashboard's money block asks round 91's question, not finance.view", () => {
    const page = read('src/app/(protected)/dashboard/page.tsx');
    expect(page).toContain('const seesMoney = seesAllMoney(actor);');
    expect(page).not.toMatch(/seesMoney = actor\.permissions\.has\('finance\.view'\)/);
  });

  it('A15: the expense file carries the screen\'s category', () => {
    const page = read('src/app/(protected)/accounting/expenses/page.tsx');
    expect(page).toContain('/api/accounting/expenses?categoryId=${categoryId}');
  });

  it("A29: «Kiritish» opens on the day the warehouse spent the money", () => {
    const page = read('src/app/(protected)/accounting/expenses/page.tsx');
    expect(page).toMatch(/expenseDate: spendDateOf\(new Date\(prefillRow\.createdAt\), prefillRow\.warehouseTimezone\)/);
    const form = read('src/app/(protected)/accounting/expenses/expense-form.tsx');
    expect(form).toContain('defaultValue={prefill?.expenseDate ?? today}');
  });

  it('A1: the rate door asks before a jump, and the form makes the currency a choice', () => {
    const action = read('src/app/(protected)/admin/fx/actions.ts');
    expect(action).toMatch(/formData\.get\('confirmJump'\) !== '1' && isRateJump\(previous, quoted\)/);
    // After authorize: an unauthenticated post must not read the rate book.
    expect(action.indexOf("authorize('costs.fx.manage')")).toBeLessThan(action.indexOf('isRateJump(previous'));
    const form = read('src/app/(protected)/admin/fx/fx-form.tsx');
    expect(form).toMatch(/<option value="">—<\/option>/);
  });

  it('A31: the partner card offers no hand-typed charge', () => {
    const form = read('src/app/(protected)/kontragentlar/[id]/tx-form.tsx');
    expect(form).toContain("const TYPES = ['payment', 'receipt', 'adjust'] as const;");
  });
});
