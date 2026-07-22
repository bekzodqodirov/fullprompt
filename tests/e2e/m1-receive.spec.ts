import { expect, test } from '@playwright/test';
import sharp from 'sharp';

/**
 * M1 e2e: the W1 receiving flow on a phone viewport — operator enters a
 * receipt for GS777, uploads a photo, confirms, gets the next letter, and
 * the label PDF endpoint responds.
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

  // Step 0: client autocomplete gs777 → GS777
  await page.locator('#clientQuery').fill('gs777');
  await page.getByRole('button', { name: /GS777/ }).click();
  await expect(page.getByText('GS777 —')).toBeVisible();
  await page.getByRole('button', { name: /→/ }).click();

  // Step 1: one uniform lot
  await page.locator('input[placeholder="化妆品"]').fill('灯具');
  const numberInputs = page.locator('input[inputmode="numeric"], input[inputmode="decimal"]');
  await numberInputs.nth(0).fill('4'); // box count
  await numberInputs.nth(1).fill('40'); // L
  await numberInputs.nth(2).fill('30'); // W
  await numberInputs.nth(3).fill('20'); // H
  await numberInputs.nth(4).fill('8'); // kg
  await expect(page.getByText('32 kg').first()).toBeVisible(); // live math 4×8

  // Photo upload (min-1-photo rule)
  const photo = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 180, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'box.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.locator('img[src*="/api/attachments/"]')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /→/ }).click(); // to costs
  await page.getByRole('button', { name: /→/ }).click(); // to review
  await expect(page.getByText('Σ 4 📦')).toBeVisible();

  await page.getByRole('button', { name: /✅/ }).click();

  // Success screen: a letter was assigned (sequence position depends on
  // earlier runs — exact-letter continuation is covered by unit/integration
  // tests; here we assert the flow produced one).
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

  // Receipt visible in the list; box searchable via combined form
  await page.goto('/search?q=gs777-a');
  await expect(page.getByText('化妆品')).toBeVisible();
});
