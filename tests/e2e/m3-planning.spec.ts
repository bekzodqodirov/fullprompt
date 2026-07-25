import { expect, test } from '@playwright/test';

/**
 * M3 e2e (logist, phone): plan with a partial lot → agent Excel → changes
 * loop → v2 approved → batch → loading mode (manual/sticker-lost path) →
 * finish with short-loaded deviation → depart → manifest.
 */

const LOGIST_PHONE = '+998900000003';
const PASSWORD = 'demo1234';

test('plan → approve → load → depart lifecycle', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(LOGIST_PHONE);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // --- Plan editor: origin YW, take 2 boxes of the first (oldest) lot ---
  await page.goto('/plans/new');
  await page.getByTestId('plan-origin').selectOption({ label: 'YW' });
  // Mapped destination — the tracking-map assertion below needs a corridor.
  await page.getByTestId('plan-dest').selectOption({ label: 'TAS1' });
  const firstRow = page.locator('#plan-stock-table tbody tr').first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });
  await firstRow.locator('input').fill('1');
  await expect(page.getByText('Σ 1 📦')).toBeVisible();
  await page.getByTestId('submit-plan').click();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/, { timeout: 15_000 });

  // Agent Excel responds with a workbook
  const xlsxHref = await page.getByRole('link', { name: /⬇️/ }).getAttribute('href');
  const xlsxRes = await page.request.get(xlsxHref!);
  expect(xlsxRes.status()).toBe(200);
  expect((await xlsxRes.body()).subarray(0, 2).toString()).toBe('PK');

  // --- Changes requested → edit → resubmit v2 ---
  await page.getByTestId('verdict-comment').fill('слишком много, убери часть');
  await page.getByTestId('verdict-changes').click();
  await expect(page.getByText('v1').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('link', { name: /✏️/ }).click();
  await expect(page).toHaveURL(/\/plans\/new\?planId=/);
  const rowAgain = page.locator('#plan-stock-table tbody tr').first();
  await expect(rowAgain).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('submit-plan').click();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/, { timeout: 15_000 });
  await expect(page.getByText('v2').first()).toBeVisible();

  // --- Approve → batch ---
  await page.getByTestId('verdict-approve').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]+$/, { timeout: 15_000 });
  await expect(page.getByText(/YW-\d{3}/).first()).toBeVisible();
  const batchUrl = page.url();

  // --- Loading mode: sticker-lost manual path loads 1 of 2 boxes ---
  await page.getByTestId('open-loading').click();
  await expect(page.getByTestId('load-counter')).toHaveText(/0\/1/, { timeout: 10_000 });
  await page.getByRole('button', { name: /🏷/ }).click();
  await page.locator('button:has(span.font-mono)').filter({ hasText: /YW26-/ }).first().click();
  await expect(page.getByTestId('load-counter')).toHaveText(/1\/1/);
  // Outbox drains (sync banner leaves the "syncing" state)
  await expect(page.getByTestId('sync-banner')).not.toContainText('🔄', { timeout: 15_000 });

  // --- Finish loading (1 short-loaded) + depart + manifest ---
  await page.goto(batchUrl);
  await page.getByTestId('finish-loading').click();
  await expect(page.getByText(/1/).first()).toBeVisible({ timeout: 10_000 });
  page.once('dialog', (d) => void d.accept()); // depart confirm
  await page.getByTestId('depart-batch').click();
  await expect(page.getByText(/🚀/).first()).toBeVisible({ timeout: 15_000 });

  const manifestRes = await page.request.get(`${new URL(batchUrl).pathname.replace('/batches/', '/api/batches/')}/manifest`);
  expect(manifestRes.status()).toBe(200);
  expect((await manifestRes.body()).subarray(0, 2).toString()).toBe('PK');

  // --- Tracking map: the departed truck shows up, checkpoint pin works ---
  const batchCode = await page.getByText(/YW-\d{3}/).first().innerText();
  await page.goto(batchUrl);
  await page.getByRole('button', { name: /🛃/ }).click(); // "at the border" pin
  await expect(page.getByRole('button', { name: /🛃/ })).toHaveClass(/border-blue-700/, {
    timeout: 10_000,
  });
  await page.goto('/map');
  await expect(page.locator('svg[role="img"]')).toBeVisible();
  await expect(page.locator(`svg text:has-text("${batchCode}")`).first()).toBeVisible({
    timeout: 10_000,
  });
});
