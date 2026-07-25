import { expect, test } from '@playwright/test';

/**
 * Phase 2.4 management accounting: the accountant maintains the books, the
 * owner reads the profit, and a sales manager — who legitimately holds
 * `finance.view` for client balances — must never reach the company's margin.
 */

const ACCOUNTANT = '+998900000010';
const SALES = '+998900000009';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);
const today = new Date().toISOString().slice(0, 10);
const year = today.slice(0, 4);

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('accountant keeps the books and the reports add up', async ({ page }) => {
  await login(page, ACCOUNTANT);

  // A kind of expense the owner maintains himself — nothing is hard-coded.
  await page.goto('/accounting/categories');
  await page.getByTestId('category-name').first().fill(`Test xarajat ${runId}`);
  await page.getByTestId('save-category').click();
  await expect(page.getByText('✅').first()).toBeVisible();

  // A cash box with money already in it before the system started.
  await page.goto('/accounting/accounts');
  await page.getByTestId('account-name').first().fill(`Test kassa ${runId}`);
  await page.locator('form').filter({ has: page.getByTestId('save-account') })
    .locator('input[name="openingBalance"]').fill('500');
  await page.getByTestId('save-account').click();
  await expect(page.getByText(`Test kassa ${runId}`).first()).toBeVisible();
  await expect(page.getByText('500').first()).toBeVisible();

  // One expense, in USD so no FX rate is needed for it.
  await page.goto('/accounting/expenses');
  await page.locator('select[name="categoryId"]').first().selectOption({ label: `Test xarajat ${runId}` });
  await page.getByTestId('expense-amount').fill('123.45');
  await page.locator('select[name="currency"]').first().selectOption('USD');
  await page.getByTestId('save-expense').click();
  await expect(page.getByText('✅').first()).toBeVisible();

  // It shows up in the register for the period that contains today.
  await page.goto(`/accounting/expenses?from=${year}-01-01&to=${today}`);
  await expect(page.getByText('123.45').first()).toBeVisible();

  // …and in the P&L, under the category it was booked to.
  await page.goto(`/accounting/pnl?from=${year}-01-01&to=${today}`);
  await expect(page.getByText(`Test xarajat ${runId}`)).toBeVisible();

  // Every report downloads as a real workbook.
  for (const kind of ['pnl', 'cashflow', 'receivables', 'profit', 'expenses']) {
    const response = await page.request.get(
      `/api/accounting/${kind}?from=${year}-01-01&to=${today}`,
    );
    expect(response.status(), kind).toBe(200);
    expect(response.headers()['content-type'], kind).toContain('spreadsheetml');
    expect((await response.body()).byteLength, kind).toBeGreaterThan(1000);
  }
});

test('a sales manager cannot reach profit, by page or by download', async ({ page }) => {
  await login(page, SALES);
  // The client ledger stays available — it is the margin that is off limits.
  await page.goto('/finance');
  await expect(page).toHaveURL(/\/finance/);

  await page.goto('/accounting/pnl');
  await expect(page).toHaveURL('/');
  const response = await page.request.get('/api/accounting/pnl');
  expect(response.status()).toBe(403);
});
