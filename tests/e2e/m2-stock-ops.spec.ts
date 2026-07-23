import { expect, test } from '@playwright/test';
import sharp from 'sharp';

/**
 * M2 e2e (logist): build a crate from GS777 boxes → label PDF → dissolve;
 * mark a box lost → found; return an unclaimed receipt to the sender;
 * export the stock XLSX.
 */

const LOGIST_PHONE = '+998900000003';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(LOGIST_PHONE);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('crate lifecycle: build from GS777 boxes, label, dissolve', async ({ page }) => {
  await login(page);

  await page.goto('/crates/new');
  // YW warehouse + GS777 client
  await page.getByTestId('crate-wh').selectOption({ label: 'YW' });
  const searchSettled = page.waitForResponse((r) => r.url().includes('/api/clients/search'));
  await page.locator('#crateClientQuery').fill('gs777');
  await searchSettled;
  await page.getByRole('button', { name: /GS777/ }).first().click();

  // Tick the first whole lot
  const firstLot = page.locator('#cratable-boxes > div').first();
  await expect(firstLot).toBeVisible({ timeout: 10_000 });
  await firstLot.locator('button').first().click();

  await page.getByRole('checkbox').check();
  await page.getByTestId('create-crate').click();

  // Crate detail: code + label PDF
  await expect(page).toHaveURL(/\/crates\/[0-9a-f-]+/, { timeout: 15_000 });
  await expect(page.getByText(/CR-YW\d{2}-\d{5}/)).toBeVisible();
  const labelHref = await page.getByRole('link', { name: /🖨/ }).getAttribute('href');
  const labelRes = await page.request.get(labelHref!);
  expect(labelRes.status()).toBe(200);
  expect(labelRes.headers()['content-type']).toContain('application/pdf');
  expect((await labelRes.body()).subarray(0, 4).toString()).toBe('%PDF');

  // Dissolve → back to the list
  await page.getByRole('button', { name: /⛏/ }).click();
  await expect(page).toHaveURL(/\/crates$/, { timeout: 15_000 });
});

test('box lost → found (manager flow with mandatory reason)', async ({ page }) => {
  await login(page);

  // Stock → first lot with in-stock boxes → its LAST box (plan reservation
  // takes the lowest seq first, so the last box stays in stock longest).
  await page.goto('/stock?q=化妆品');
  await page.locator('td a[href*="/stock?lot="]').first().click();
  await page.locator('a[href*="/boxes/"]').last().click();
  await expect(page).toHaveURL(/\/boxes\//);

  await page.getByRole('button', { name: /⚠️/ }).click();
  await page.getByTestId('status-reason').fill('не нашлась на полке');
  await page.getByTestId('status-confirm').click();
  await expect(page.getByText('не нашлась на полке')).toBeVisible({ timeout: 10_000 });

  // Found → back to stock
  await page.getByRole('button', { name: /✅/ }).click();
  await page.getByTestId('status-reason').fill('нашлась за стеллажом');
  await page.getByTestId('status-confirm').click();
  await expect(page.getByRole('button', { name: /⚠️/ })).toBeVisible({ timeout: 10_000 });
});

test('unclaimed receipt can be returned to the sender', async ({ page }) => {
  await login(page);

  // Create an unclaimed receipt (same flow as m1, marking RT1)
  await page.goto('/receive');
  await page.evaluate(() => localStorage.removeItem('gsr-receipt-draft'));
  await page.reload();
  const searchSettled = page.waitForResponse((r) => r.url().includes('/api/clients/search'));
  await page.locator('#clientQuery').fill('RT1');
  await searchSettled;
  await page.locator('button', { hasText: '❓' }).click();
  await page.getByTestId('lot-zh').fill('退货');
  await page.getByTestId('lot-count').fill('1');
  await page.getByTestId('lot-L').fill('20');
  await page.getByTestId('lot-W').fill('20');
  await page.getByTestId('lot-H').fill('20');
  await page.getByTestId('lot-kg').fill('3');
  const photo = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 200, g: 90, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  await page
    .locator('#mobile-product-lines input[type="file"]')
    .first()
    .setInputFiles({ name: 'rt.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(
    page.locator('#mobile-product-lines img[src*="/api/attachments/"]').first(),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('confirm-receipt').click();
  await expect(page.getByText(/-IN-\d{6}-\d{3}/)).toBeVisible({ timeout: 15_000 });

  // Open the receipt → return to sender
  await page.locator('a[href^="/receipts/"]').first().click();
  await expect(page).toHaveURL(/\/receipts\//, { timeout: 10_000 });

  await page.getByRole('button', { name: /↩️/ }).click();
  await page.getByTestId('handover-name').fill('Ali Qaytaruvchi');
  await page.getByTestId('handover-phone').fill('+998901234567');
  await page.getByTestId('handover-confirm').click();
  // After return every box is issued → the return button disappears
  await expect(page.getByTestId('handover-confirm')).toBeHidden({ timeout: 10_000 });
});

test('stock XLSX export responds with a workbook', async ({ page }) => {
  await login(page);
  const res = await page.request.get('/api/reports/stock?q=');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('spreadsheetml');
  expect((await res.body()).subarray(0, 2).toString()).toBe('PK');
});
