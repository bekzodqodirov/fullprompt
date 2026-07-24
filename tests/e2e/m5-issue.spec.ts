import { expect, test } from '@playwright/test';

/**
 * M5 e2e (logist, phone): export batch to a customs WH → unload flips cargo
 * to ready_for_pickup → VED doc drafts download → issue to the client with
 * receiver capture → handover act PDF.
 */

const LOGIST_PHONE = '+998900000003';
const PASSWORD = 'demo1234';

test('export → ready_for_pickup → issue with handover act', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(LOGIST_PHONE);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // Plan YW → AND (customs), 1 box of the first lot
  await page.goto('/plans/new');
  await page.getByTestId('plan-origin').selectOption({ label: 'YW' });
  await page.getByTestId('plan-dest').selectOption({ label: 'AND' });
  const firstRow = page.locator('#plan-stock-table tbody tr').first();
  await expect(firstRow).toBeVisible({ timeout: 10_000 });
  // Remember the client code of the first row to issue to later
  const rowCode = await firstRow.locator('td').nth(1).innerText(); // e.g. GS777-A
  const clientCode = rowCode.split('-')[0]!;
  await firstRow.locator('input').fill('1');
  await page.getByTestId('submit-plan').click();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.getByTestId('verdict-approve').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]+$/, { timeout: 15_000 });
  const batchUrl = page.url();

  // VED drafts respond
  const invoiceRes = await page.request.get(`${new URL(batchUrl).pathname.replace('/batches/', '/api/batches/')}/invoice`);
  expect(invoiceRes.status()).toBe(200);
  expect((await invoiceRes.body()).subarray(0, 2).toString()).toBe('PK');
  const packingRes = await page.request.get(`${new URL(batchUrl).pathname.replace('/batches/', '/api/batches/')}/packing`);
  expect(packingRes.status()).toBe(200);

  // Load + depart
  await page.getByTestId('open-loading').click();
  await expect(page.getByTestId('load-counter')).toHaveText(/0\/1/, { timeout: 10_000 });
  await page.getByRole('button', { name: /🏷/ }).click();
  await page.locator('button:has(span.font-mono)').filter({ hasText: /YW26-/ }).first().click();
  await expect(page.getByTestId('load-counter')).toHaveText(/1\/1/);
  await expect(page.getByTestId('sync-banner')).not.toContainText('🔄', { timeout: 15_000 });
  await page.goto(batchUrl);
  await page.getByTestId('finish-loading').click();
  page.once('dialog', (d) => void d.accept()); // depart confirm
  await page.getByTestId('depart-batch').click();
  await expect(page.getByText(/🚀/).first()).toBeVisible({ timeout: 15_000 });

  // Unload at AND → ready_for_pickup
  await page.getByTestId('open-unloading').click();
  await expect(page.getByTestId('unload-counter')).toHaveText(/0\/1/, { timeout: 10_000 });
  await page.getByRole('button', { name: /🏷/ }).click();
  await page.locator('button:has(span.font-mono)').filter({ hasText: /YW26-/ }).first().click();
  await expect(page.getByTestId('unload-counter')).toHaveText(/1\/1/);
  await expect(page.getByTestId('sync-banner')).not.toContainText('🔄', { timeout: 15_000 });

  // Issue mode at AND for that client
  await page.goto('/issue');
  await page.getByTestId('issue-wh').selectOption({ label: 'AND' });
  const searchSettled = page.waitForResponse((r) => r.url().includes('/api/clients/search'));
  await page.locator('#issueClientQuery').fill(clientCode);
  await searchSettled;
  await page.getByRole('button', { name: new RegExp(clientCode) }).first().click();

  const firstLot = page.locator('#issuable-boxes > div').first();
  await expect(firstLot).toBeVisible({ timeout: 10_000 });
  await firstLot.locator('button').first().click();

  await page.getByTestId('receiver-name').fill('Karim Olib Ketuvchi');
  await page.getByTestId('receiver-phone').fill('+998907778899');
  await page.getByTestId('confirm-issue').click();

  // Success + act PDF
  await expect(page.getByTestId('act-link')).toBeVisible({ timeout: 15_000 });
  const actHref = await page.getByTestId('act-link').getAttribute('href');
  const actRes = await page.request.get(actHref!);
  expect(actRes.status()).toBe(200);
  expect(actRes.headers()['content-type']).toContain('application/pdf');
  expect((await actRes.body()).subarray(0, 4).toString()).toBe('%PDF');
});
