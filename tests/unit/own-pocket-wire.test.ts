import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «O'z pulimdan to'ladim» (owner M1a) and the staff account on /profile
 * (A2a). Every door here is a server action behind a session or `authorize()`,
 * so no integration test can press one (#531) — the wiring is pinned by
 * source shape, comments stripped first (#725) so a sentence explaining a
 * rule can never satisfy the fence for it.
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));
const from = (src: string, marker: string) => {
  const at = src.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  return src.slice(at);
};

const FOLD = read('src/app/(protected)/receive/expense-request-fold.tsx');
const RECEIVE_ACTIONS = read('src/app/(protected)/receive/actions.ts');
const PROFILE_ACTIONS = read('src/app/(protected)/profile/actions.ts');
const PROFILE_PAGE = read('src/app/(protected)/profile/page.tsx');
const EXPENSES_PAGE = read('src/app/(protected)/accounting/expenses/page.tsx');
const EXPENSE_FORM = read('src/app/(protected)/accounting/expenses/expense-form.tsx');
const ACCOUNTING_ACTIONS = read('src/app/(protected)/accounting/actions.ts');
const SERVICE = read('src/modules/wms/accounting/expense-requests.ts');

describe('the fold says «o‘z pulimdan» and the post carries it', () => {
  it('the checkbox is bound to the state the send posts, on both doors', () => {
    expect(FOLD).toMatch(/data-testid="rasxod-self"\s+checked=\{paidBySelf\}/);
    const send = from(FOLD, 'async function send()');
    expect(send).toMatch(/const payload = \{[^}]*\bpaidBySelf,/);
    expect(send).toContain('requestOwnExpenseAction(payload)');
    expect(send).toContain('requestExpenseAction(payload)');
  });

  it('the service writes it onto the row and into the event', () => {
    const request = from(SERVICE, 'export async function requestExpense');
    expect(request).toMatch(/\.values\(\{[^}]*\bpaidBySelf,/);
    expect(request).toMatch(/payload: \{[^}]*\bpaidBySelf,/);
  });

  it('/receive still authorises AT a warehouse and refuses a post without one', () => {
    const action = from(RECEIVE_ACTIONS, 'export async function requestExpenseAction');
    expect(action).toContain("if (!warehouseId) return { error: 'validation' };");
    expect(action).toContain("authorize('receipts.create', { warehouseId })");
  });
});

describe('the /profile door', () => {
  const action = from(PROFILE_ACTIONS, 'export async function requestOwnExpenseAction');

  it('takes the reporter from the SESSION, never from the post', () => {
    expect(action).toContain('const user = await getSessionUser();');
    expect(action).toContain("if (!user) return { error: 'unauthenticated' };");
    expect(action).toContain('requestExpense(parsed.data, { actorId: user.id, ...meta })');
  });

  it('asks for a signed-in person only — no warehouse permission the seller lacks', () => {
    expect(action).not.toContain('authorize(');
    expect(action).not.toContain('receipts.create');
  });

  it('re-checks a named warehouse against the person’s own assignments (#514)', () => {
    expect(action).toContain('reporterWarehouses(user.id)');
    expect(action).toMatch(/if \(!own\.some\(\(wh\) => wh\.id === warehouseId\)\) return \{ error: 'forbidden' \};/);
  });

  it('the page keys the account panel on the session user and offers the fold', () => {
    expect(PROFILE_PAGE).toContain('staffAccountView(user.id)');
    expect(PROFILE_PAGE).toContain('myExpenseRequests(user.id)');
    expect(PROFILE_PAGE).toMatch(/<ExpenseRequestFold\s+door="profile"/);
  });
});

describe('«Kiritish» on an own-pocket report', () => {
  it('pre-selects the REPORTER’s staff account as the payer', () => {
    expect(EXPENSES_PAGE).toContain('staffPartnerOfUser(prefillRow.createdBy)');
    expect(EXPENSES_PAGE).toContain('partnerId: prefillPartnerId,');
    expect(EXPENSE_FORM).toContain("useState(prefill?.partnerId ?? '')");
  });

  it('re-keys the form on the payer, or the minted account never reaches useState', () => {
    expect(EXPENSES_PAGE).toMatch(/key=\{prefillRow \? `\$\{prefillRow\.id\}:\$\{prefillPartnerId \?\? ''\}`/);
  });

  it('the mint is gated finance.expenses and reads the login off the request row', () => {
    const mint = from(ACCOUNTING_ACTIONS, 'export async function openStaffPartnerAction');
    const body = mint.slice(0, mint.indexOf('\nexport async function', 10));
    expect(body).toContain("run('finance.expenses',");
    expect(body).not.toContain('finance.manage');
    expect(body).toContain('expenseRequestReporter(requestId)');
    expect(body).toContain('openStaffPartner(request.createdBy, ctx)');
  });
});
