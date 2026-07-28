import { expect, test } from '@playwright/test';

/**
 * Item 9 of the owner's feedback: the promise carries kub/kilo, and «Qabul
 * qilish» on it opens receiving PRE-FILLED — the operator types nothing that
 * was already known. The closing-and-notifying half lives in the integration
 * test; this spec proves the path a finger actually takes.
 */

const YW_MANAGER = '+998900000005';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);

test('a promise with measures opens receiving pre-filled from one tap', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(YW_MANAGER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // Record the promise, with the two numbers the price is made of.
  await page.goto('/arrivals');
  const add = page.locator('details').filter({ has: page.getByTestId('save-arrival') });
  await add.locator('summary').click();
  await page.getByTestId('arrival-client').fill('GS777');
  await page.getByRole('button', { name: /GS777/ }).first().click();
  await page.locator('input[name="boxCount"]').fill('4');
  await page.locator('input[name="weightKg"]').fill('120');
  await page.locator('input[name="volumeM3"]').fill('1.5');
  await page.locator('input[name="note"]').fill(`Prefill sinov ${runId}`);
  await page.getByTestId('save-arrival').click();
  await expect(add.getByText('✅')).toBeVisible({ timeout: 15_000 });

  // The row states the measures, and its button carries the promise along.
  await page.goto('/arrivals');
  const row = page.getByTestId('expected-row').filter({ hasText: `Prefill sinov ${runId}` });
  await expect(row).toContainText('120 kg');
  await expect(row).toContainText('1.5 m³');
  await row.getByTestId('receive-expected').click();
  await expect(page).toHaveURL(/\/receive\?arrival=/);

  // The client arrived already chosen — the thing the operator used to
  // search for by hand on every promised receipt.
  await expect(page.locator('main')).toContainText('GS777');

  // Not confirming a real receipt here — cancel the promise so the list and
  // the next run stay clean (#154).
  await page.goto('/arrivals');
  await row.locator('input[name="reason"]').fill('sinov tugadi');
  await row.locator('button[title]').last().click();
  await expect(
    page.getByTestId('expected-row').filter({ hasText: `Prefill sinov ${runId}` }),
  ).toHaveCount(0);
});
