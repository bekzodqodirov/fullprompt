import { expect, test } from '@playwright/test';

/**
 * M4 e2e (logist, phone): full transfer round-trip — plan → approve → load →
 * depart → UNLOAD at the destination → finish (no discrepancies) → close.
 */

const LOGIST_PHONE = '+998900000003';
const PASSWORD = 'demo1234';

test('unload lifecycle: scan in at destination, finish, close', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(LOGIST_PHONE);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // Plan 1 box → approve → batch
  await page.goto('/plans/new');
  await page.getByTestId('plan-origin').selectOption({ label: 'YW' });
  const firstRow = page.locator('#plan-stock-table tbody tr').first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });
  await firstRow.locator('input').fill('1');
  await page.getByTestId('submit-plan').click();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.getByTestId('verdict-approve').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]+$/, { timeout: 15_000 });
  const batchUrl = page.url();

  // Load the box (manual path) and depart
  await page.getByTestId('open-loading').click();
  await expect(page.getByTestId('load-counter')).toHaveText(/0\/1/, { timeout: 10_000 });
  await page.getByRole('button', { name: /🏷/ }).click();
  await page.locator('button:has(span.font-mono)').filter({ hasText: /YW26-/ }).first().click();
  await expect(page.getByTestId('load-counter')).toHaveText(/1\/1/);
  await expect(page.getByTestId('sync-banner')).not.toContainText('🔄', { timeout: 15_000 });
  await page.goto(batchUrl);
  await page.getByTestId('finish-loading').click();
  await page.getByTestId('depart-batch').click();
  await expect(page.getByText(/🚀/).first()).toBeVisible({ timeout: 15_000 });

  // Unload at the destination
  await page.getByTestId('open-unloading').click();
  await expect(page.getByTestId('unload-counter')).toHaveText(/0\/1/, { timeout: 10_000 });
  await page.getByRole('button', { name: /🏷/ }).click();
  await page.locator('button:has(span.font-mono)').filter({ hasText: /YW26-/ }).first().click();
  await expect(page.getByTestId('unload-counter')).toHaveText(/1\/1/);
  await expect(page.getByTestId('sync-banner')).not.toContainText('🔄', { timeout: 15_000 });

  // Finish unload (no discrepancies) and close
  await page.goto(batchUrl);
  await page.getByTestId('finish-unload').click();
  await expect(page.getByTestId('close-batch')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('close-batch').click();
  await expect(page.getByTestId('close-batch')).toBeHidden({ timeout: 15_000 });

  // Transit report renders
  await page.goto('/transit');
  await expect(page.getByRole('heading')).toBeVisible();
});
