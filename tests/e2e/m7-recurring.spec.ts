import { expect, test, type Page } from '@playwright/test';

/**
 * A recurring expense is paid when the kassa holder actually pays it (owner's
 * Q6, 0106) — in the browser, as the ACCOUNTANT, a non-admin (#792: a door is
 * half-verified until somebody who is not the admin opens it).
 *
 * The rules — the due list, the part payment, the month key, the Balans line
 * — are proven in recurring-pay.integration.test.ts and the form-fed halves
 * in recurring-wire.test.ts (#531). What only a browser can show: a template
 * waits on the list, the fold offers two named buttons for a short amount and
 * one for the rest, and a person who is not a kassa holder never sees any of
 * it. Everything is put back in a final TEST, never an `afterAll` (round 57):
 * an open month is configuration every counter and the Balans read (#183).
 *
 * Sorts after m7-accounting and before m8.
 */

const ACCOUNTANT = '+998900000010';
const VED = '+998900000004';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);
const KIND = `Rec oylik ${runId}`;
const KASSA = `Rec kassa ${runId}`;

test.describe.configure({ mode: 'serial' });

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function openRecurring(page: Page) {
  await page.goto('/accounting/expenses');
  const panel = page.locator('#recurring details').first();
  if (!(await panel.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await page.getByTestId('recurring-panel').click();
  }
}

const dueRow = (page: Page) => page.getByTestId('recurring-due-row').filter({ hasText: KIND });

test('a template waits on the list; a short payment asks, the rest closes the month', async ({ page }) => {
  await login(page, ACCOUNTANT);

  await page.goto('/accounting/categories');
  await page.getByTestId('category-name').first().fill(KIND);
  await page.getByTestId('save-category').click();
  await expect(page.getByText('✅').first()).toBeVisible();

  await page.goto('/accounting/accounts');
  await page.getByTestId('account-name').first().fill(KASSA);
  const accountForm = page.locator('form').filter({ has: page.getByTestId('save-account') });
  await accountForm.locator('select[name="currency"]').selectOption('USD');
  await page.getByTestId('save-account').click();
  await expect(page.getByText(KASSA).first()).toBeVisible();

  // The template: day 1, this month chosen EXPLICITLY — the default follows
  // the typed day and is next month on every day but the 1st (G10).
  await openRecurring(page);
  const form = page.locator('#recurring form').filter({ has: page.getByTestId('save-recurring') });
  await form.locator('select[name="categoryId"]').selectOption({ label: KIND });
  await form.getByTestId('recurring-amount').fill('700');
  await form.locator('select[name="currency"]').selectOption('USD');
  await form.locator('input[name="dayOfMonth"]').fill('1');
  await form.locator('select[name="accountId"]').selectOption({ label: `${KASSA} (USD)` });
  await form.getByTestId('recurring-first-month').selectOption('this');
  await page.getByTestId('save-recurring').click();
  await expect(form.getByText('✅')).toBeVisible();

  // Nothing was written: the month waits on the list, and the banner says so.
  await page.goto('/accounting/expenses');
  const banner = page.getByTestId('recurring-due-banner');
  await expect(banner).toBeVisible();
  expect(((await banner.textContent()) ?? '').match(/⏰/g)).toHaveLength(1);
  await expect(dueRow(page)).toHaveCount(1);

  // A short amount: the fold asks which it is (O3).
  await dueRow(page).getByTestId('recurring-pay').locator('summary').click();
  await expect(dueRow(page).getByTestId('recurring-pay-payer')).toHaveValue(/^till:/);
  await dueRow(page).getByTestId('recurring-pay-amount').fill('650');
  await expect(dueRow(page).getByTestId('recurring-pay-close')).toBeVisible();
  await dueRow(page).getByTestId('recurring-pay-partial').click();
  await expect(dueRow(page).getByTestId('recurring-paid-so-far')).toContainText('650');

  // The rest: the default is the remainder and one button closes the month.
  await dueRow(page).getByTestId('recurring-pay').locator('summary').click();
  await expect(dueRow(page).getByTestId('recurring-pay-amount')).toHaveValue('50');
  await expect(dueRow(page).getByTestId('recurring-pay-partial')).toHaveCount(0);
  await dueRow(page).getByTestId('recurring-pay-save').click();
  await expect(dueRow(page)).toHaveCount(0);

  // Both payments are ordinary expenses of the day, marked with their month.
  const table = page.locator('table').filter({ hasText: KIND });
  await expect(table.getByText('650 USD')).toBeVisible();
  await expect(table.getByText('50 USD', { exact: true })).toBeVisible();
  await expect(table.getByText('🔁').first()).toBeVisible();
});

test('a person who is not a kassa holder never sees the list', async ({ page }) => {
  await login(page, VED);
  await page.goto('/accounting/expenses');
  // Not asserting WHERE they land: the layout forwards the VED on, and the
  // pending Q19 package may change their grants (G5, O6).
  await expect(page).not.toHaveURL(/\/accounting\/expenses/);
  await expect(page.getByTestId('recurring-panel')).toHaveCount(0);
  await expect(page.getByTestId('recurring-due-banner')).toHaveCount(0);
});

test('cleanup: void the payments, skip the month, stop the template, retire the kind and the kassa', async ({ page }) => {
  await login(page, ACCOUNTANT);
  page.on('dialog', (dialog) => void dialog.accept('e2e tozalash'));

  // Voiding a payment re-opens its month (Q6) — twice, and the row returns.
  await page.goto('/accounting/expenses');
  for (let i = 0; i < 2; i += 1) {
    const row = page.locator('tr').filter({ hasText: KIND }).filter({ has: page.getByTestId('void-expense') }).first();
    await row.getByTestId('void-expense').click();
    await expect(page.locator('tr').filter({ hasText: KIND }).filter({ has: page.getByTestId('void-expense') })).toHaveCount(1 - i);
  }
  await openRecurring(page);
  await expect(dueRow(page)).toHaveCount(1);

  // «Bu oy yo'q», in words: the month leaves the list with no money.
  await dueRow(page).getByTestId('recurring-skip').locator('summary').click();
  await dueRow(page).getByTestId('recurring-skip-reason').fill('e2e tozalash');
  await dueRow(page).getByTestId('recurring-skip-save').click();
  await expect(dueRow(page)).toHaveCount(0);

  // Nothing is due any more, so «Faol» may be unticked.
  await openRecurring(page);
  const templateRow = page.locator('#recurring div').filter({ hasText: KIND }).filter({ has: page.getByTestId('recurring-edit') }).last();
  await templateRow.getByTestId('recurring-edit').locator('summary').click();
  await templateRow.getByTestId('recurring-edit-active').uncheck();
  await templateRow.getByTestId('recurring-edit-save').click();
  await expect(templateRow.getByText('✅')).toBeVisible();

  // Retire the kind and the kassa: an active one is on every expense form.
  await page.goto('/accounting/categories');
  const kindForm = page.locator('form').filter({ has: page.locator(`input[name="name"][value="${KIND}"]`) });
  await kindForm.locator('input[name="active"][type="checkbox"]').uncheck();
  await kindForm.getByTestId('update-category').click();
  await page.goto('/accounting/accounts');
  const kassaForm = page.locator('form').filter({ has: page.locator(`input[name="name"][value="${KASSA}"]`) });
  await kassaForm.locator('input[name="active"][type="checkbox"]').uncheck();
  await kassaForm.getByTestId('update-account').click();

  await openRecurring(page);
  await expect(dueRow(page)).toHaveCount(0);
});
