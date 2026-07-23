import { expect, test } from '@playwright/test';
import sharp from 'sharp';

/**
 * M1 e2e (single-window layout): operator enters a receipt for GS777 on one
 * screen, uploads a photo, confirms, gets a letter, and the label PDF
 * endpoint responds.
 */

const OPERATOR_PHONE = '+998900000006'; // YW operator (seeded)
const PASSWORD = 'demo1234';

test('operator completes a receipt and gets labels', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OPERATOR_PHONE);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/receive');
  await page.evaluate(() => localStorage.removeItem('gsr-receipt-draft'));
  await page.reload();

  // Client autocomplete gs777 → GS777
  await page.locator('#clientQuery').fill('gs777');
  await page.getByRole('button', { name: /GS777/ }).click();
  await expect(page.getByText('GS777 —')).toBeVisible();

  // One uniform product line
  await page.getByTestId('lot-zh').fill('灯具');
  await page.getByTestId('lot-count').fill('4');
  await page.getByTestId('lot-L').fill('40');
  await page.getByTestId('lot-W').fill('30');
  await page.getByTestId('lot-H').fill('20');
  await page.getByTestId('lot-kg').fill('8');
  await expect(page.locator('#mobile-product-lines').getByText('32kg')).toBeVisible(); // live math 4×8

  // Photo upload (min-1-photo rule)
  const photo = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 180, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: 'box.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.locator('#mobile-product-lines img[src*="/api/attachments/"]').first()).toBeVisible({
    timeout: 10_000,
  });

  // Per-line note (replaces the removed "pieces" field, owner's feedback)
  await page.getByTestId('lot-note').fill('доставщик перепутал коробку');

  // Sticky footer totals + confirm
  await expect(page.getByText('Σ 4 📦')).toBeVisible();
  await page.getByTestId('confirm-receipt').click();

  // Success screen: a letter was assigned
  await expect(page.getByText(/YW-IN-\d{6}-\d{3}/)).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('li', { hasText: '灯具' }).locator('span.font-mono').first(),
  ).toHaveText(/^[A-Z]{1,2}$/);

  // Labels PDF endpoint responds with a PDF
  const href = await page.getByRole('link', { name: /🖨/ }).getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');
  expect((await res.body()).subarray(0, 4).toString()).toBe('%PDF');

  // The note shows on the receipt detail page
  const receiptId = href!.match(/\/api\/receipts\/([^/]+)\/labels/)![1];
  await page.goto(`/receipts/${receiptId}`);
  await expect(page.getByText('доставщик перепутал коробку')).toBeVisible();

  // Combined client+letter search still resolves
  await page.goto('/search?q=gs777-a');
  await expect(page.getByText('化妆品')).toBeVisible();
});

test('unclaimed intake captures the box marking', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OPERATOR_PHONE);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/receive');
  await page.evaluate(() => localStorage.removeItem('gsr-receipt-draft'));
  await page.reload();

  // Unknown code → unclaimed with marking prefilled from the query
  await page.locator('#clientQuery').fill('QQ9');
  await page.waitForTimeout(600); // debounce; no hits expected
  await page.locator('button', { hasText: '❓' }).click();
  await expect(page.locator('#marking')).toHaveValue('QQ9');

  await page.getByTestId('lot-zh').fill('杂货');
  await page.getByTestId('lot-count').fill('2');
  await page.getByTestId('lot-L').fill('30');
  await page.getByTestId('lot-W').fill('30');
  await page.getByTestId('lot-H').fill('30');
  await page.getByTestId('lot-kg').fill('5');

  const photo = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 120, g: 120, b: 220 } },
  })
    .jpeg()
    .toBuffer();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: 'u.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.locator('#mobile-product-lines img[src*="/api/attachments/"]').first()).toBeVisible({
    timeout: 10_000,
  });

  await page.getByTestId('confirm-receipt').click();
  await expect(page.getByText(/YW-IN-\d{6}-\d{3}/)).toBeVisible({ timeout: 15_000 });
});
