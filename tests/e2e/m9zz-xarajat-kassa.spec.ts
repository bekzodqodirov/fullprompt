import { expect, test } from '@playwright/test';

/**
 * «Xarajat kassasi» in the browser (0101, owner 3b + M2a).
 *
 * The rules — the kassa's balance, the currency, the M4a merge, the gates —
 * are proven in tests/integration/cost-kassa.integration.test.ts and the
 * door halves in tests/unit/cost-kassa-wire.test.ts. What only a browser can
 * show: a cost typed with no kassa lands on the accountant's queue, the
 * kassa is named there in one press and the row leaves it, and the cost card
 * then SAYS which kassa paid.
 *
 * The cost is voided in a final TEST (the kassa gets its money back), so the
 * truck's money is what it was: a cost on a truck is data every later screen
 * of that truck reads (#154).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const AMOUNT = `7${String(Date.now()).slice(-3)}.25`;

test.describe.configure({ mode: 'serial' });

let batchUrl = '';

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('a cost typed with no kassa waits on the queue, and one press names its kassa', async ({ page }) => {
  await login(page);
  await page.goto('/batches');
  const first = page.locator('a[href^="/batches/"]').filter({ hasText: /-\d{3}/ }).first();
  await first.click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
  batchUrl = new URL(page.url()).pathname;

  await page.getByTestId('add-cost').click();
  await page.getByTestId('cost-amount').fill(AMOUNT);
  await page.locator('select[aria-label="currency"]').selectOption('USD');
  // The owner holds the kassa grant: the payer select offers the kassas, and
  // «our money, kassa said later» is the default.
  await expect(page.getByTestId('cost-partner').locator('optgroup').first()).toBeAttached();
  await page.getByTestId('save-cost').click();
  await expect(page.getByText(`≈ $${AMOUNT}`)).toBeVisible({ timeout: 15_000 });

  await page.goto('/accounting/xarajat-kassa');
  const row = page.getByTestId('queue-row').filter({ hasText: AMOUNT });
  await expect(row).toHaveCount(1);
  const till = row.getByTestId('queue-till');
  const value = await till.locator('option').nth(1).getAttribute('value');
  expect(value).toBeTruthy();
  await till.selectOption(value!);
  // A USD kassa needs nothing more; another currency would ask what left it.
  const usdOption = await till.locator(`option[value="${value}"]`).textContent();
  if (!/\(USD\)/.test(usdOption ?? '')) {
    await row.getByTestId('queue-till-amount').fill('1');
  }
  await row.getByTestId('queue-till-save').click();
  await expect(page.getByTestId('queue-row').filter({ hasText: AMOUNT })).toHaveCount(0, { timeout: 15_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );

  // The card now says a kassa paid it.
  await page.goto(batchUrl);
  const entry = page.locator('div').filter({ hasText: `≈ $${AMOUNT}` }).last();
  await expect(entry.getByTestId('cost-till')).toBeVisible();
});

test('cleanup: the cost is voided and the kassa gets its money back', async ({ page }) => {
  expect(batchUrl).not.toBe('');
  await login(page);
  await page.goto(batchUrl);
  const entry = page.locator('div').filter({ hasText: `≈ $${AMOUNT}` }).last();
  page.once('dialog', (dialog) => void dialog.accept('e2e cleanup'));
  await entry.getByRole('button', { name: /🗑/ }).click();
  await expect(page.getByText(`≈ $${AMOUNT}`)).toHaveCount(0, { timeout: 15_000 });
});
