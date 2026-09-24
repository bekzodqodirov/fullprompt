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

  it('R1: a saved rate converts only the costs waiting for it — never a converted one', () => {
    const action = read('src/app/(protected)/admin/fx/actions.ts');
    expect(action).toContain('enqueue(JOB_RECOMPUTE_COSTS, { currency: parsed.data.currency, unconverted: true })');
    const engine = read('src/modules/wms/costing/service.ts');
    expect(engine).toContain('const frozen = entry.amountUsd !== null && entry.fxRateUsed !== null;');
    // The derived debt is frozen at birth with its cost (audit A0).
    const link = read('src/modules/wms/partners/link.ts');
    expect(link).toContain('if (existing) return;');
    expect(link).not.toContain('cost_entry_reprice');
  });

  it('A1: the rate door asks before a jump, and the form makes the currency a choice', () => {
    const action = read('src/app/(protected)/admin/fx/actions.ts');
    expect(action).toMatch(/formData\.get\('confirmJump'\) !== '1' && isRateJump\(previous, quoted\)/);
    // After authorize: an unauthenticated post must not read the rate book.
    expect(action.indexOf("authorize('costs.fx.manage')")).toBeLessThan(action.indexOf('isRateJump(previous'));
    const form = read('src/app/(protected)/admin/fx/fx-form.tsx');
    expect(form).toMatch(/<option value="">—<\/option>/);
  });

  it('A32/A36: a template row can be stopped, and the template form carries the payer', () => {
    const form = read('src/app/(protected)/accounting/expenses/recurring-form.tsx');
    // The unticked box posts nothing, so the hidden 'off' comes FIRST (#171).
    expect(form.indexOf('<input type="hidden" name="active" value="off" />')).toBeGreaterThan(-1);
    expect(form.indexOf('<input type="hidden" name="active" value="off" />')).toBeLessThan(
      form.indexOf('name="active" defaultChecked'),
    );
    expect(form).toContain('name="partnerId"');
    const action = read('src/app/(protected)/accounting/actions.ts');
    expect(action).toContain("partnerId: String(formData.get('partnerId') ?? '')");
    expect(action).toContain("active: checkbox(formData, 'active', false)");
  });

  it("/receive's draft survives a server refresh: the restore is keyed on strings, not on props' identity", () => {
    // Found by the pickup design's judge: the rasxod fold's router.refresh()
    // rebuilt `prefill`, the effect re-ran, and a promise's half-received
    // draft — photos and recounts — was replaced by an empty one.
    const wizard = read('src/app/(protected)/receive/receive-wizard.tsx');
    expect(wizard).toContain('}, [prefillKey, warehouseKey]);');
    expect(wizard).not.toContain('}, [warehouses, prefill]);');
    // The saved draft is recognised by the prefill's own KEY since the factory
    // truck became a second prefill (0100); the promise id stays as the
    // fallback for a draft saved before the key existed.
    expect(wizard).toMatch(/saved\?\.prefillKey === prefill\?\.key/);
    expect(wizard).toMatch(/saved\?\.expectedArrivalId === prefill\?\.arrivalId/);
  });

  it('A31: the partner card offers no hand-typed charge', () => {
    const form = read('src/app/(protected)/kontragentlar/[id]/tx-form.tsx');
    expect(form).toContain("const TYPES = ['payment', 'receipt', 'adjust'] as const;");
  });
});
