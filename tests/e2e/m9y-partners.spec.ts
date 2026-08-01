import { expect, test } from '@playwright/test';

/**
 * Kontragentlar — the money we owe, in a browser.
 *
 * Runs last in the file order (#154) and RETIRES the counterparty it makes at
 * the end. A partner is not quite data: while it is active it adds a "who
 * settled this" picker to every cost and expense form in the app, which is
 * configuration by the definition that matters here — it changes what other
 * screens render (#183).
 */

const OWNER = '+998900000001';
const WAREHOUSE = '+998900000006';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('a transport firm gets an account, a debt and a payment against it', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/kontragentlar');

  const name = `Transport ${runId}`;
  await page.getByTestId('partner-new').click();
  await page.getByTestId('partner-name').fill(name);
  // By testid, not "the first submit button": the app bar carries a search
  // form above everything on every page.
  await page.getByTestId('partner-save').click();
  await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });

  // Into the account.
  await page.locator('a[href^="/kontragentlar/"]', { hasText: name }).first().click();
  await expect(page).toHaveURL(/\/kontragentlar\/[0-9a-f-]+$/);
  const cardUrl = page.url();
  await expect(page.getByTestId('partner-balance')).toContainText('$0.00');

  // A truck taken on credit: no cash box asked for, because none moved.
  await page.getByTestId('partner-tx-new').click();
  await expect(page.getByTestId('partner-tx-account')).toHaveCount(0);
  await page.getByTestId('partner-tx-amount').fill('3200');
  await page.getByTestId('partner-tx-currency').selectOption('USD');
  await page.getByTestId('partner-tx-save').click();
  await expect(page.getByTestId('partner-balance')).toContainText('$3200.00', { timeout: 15_000 });

  // Paying it asks WHICH cash box — the field appears with the kind that
  // moves money and only with it.
  await page.getByTestId('partner-tx-new').click();
  await page.getByTestId('partner-tx-type').selectOption('payment');
  const account = page.getByTestId('partner-tx-account');
  await expect(account).toBeVisible();
  const options = await account.locator('option').all();
  const values = (await Promise.all(options.map((o) => o.getAttribute('value')))).filter(Boolean);
  expect(values.length).toBeGreaterThan(0);
  await account.selectOption(values[0]!);
  await page.getByTestId('partner-tx-amount').fill('1200');
  await page.getByTestId('partner-tx-currency').selectOption('USD');
  await page.getByTestId('partner-tx-save').click();
  await expect(page.getByTestId('partner-balance')).toContainText('$2000.00', { timeout: 15_000 });

  // The settlement screen refuses to save with no evidence behind it.
  await page.goto('/kontragentlar/hisob');
  await expect(page.getByTestId('settle-save')).toBeDisabled();
  await page.getByTestId('settle-note').fill('Kvitansiya Telegramda');
  await expect(page.getByTestId('settle-save')).toBeEnabled();

  // Retire it so the cost and expense forms go back to how every other spec
  // finds them.
  await page.goto(cardUrl);
  await page.getByTestId('partner-toggle-active').click();
  await page.goto('/kontragentlar');
  await expect(page.getByText(name)).toHaveCount(0);
});

test('the warehouse never sees what the company owes', async ({ page }) => {
  await login(page, WAREHOUSE);
  await expect(page.locator('main a[href="/kontragentlar"]')).toHaveCount(0);
  await page.goto('/kontragentlar');
  await expect(page).toHaveURL('/');
});
