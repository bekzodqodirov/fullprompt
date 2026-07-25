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
  // Decimal weight (owner's bug report: decimals/commas failed validation)
  await page.getByTestId('lot-kg').fill('8.5');
  await expect(page.locator('#mobile-product-lines').getByText('34kg')).toBeVisible(); // live math 4×8.5

  // Photo upload (min-1-photo rule)
  const photo = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 180, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  await page
    .locator('#mobile-product-lines input[type="file"]')
    .first()
    .setInputFiles({ name: 'box.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.locator('#mobile-product-lines img[src*="/api/attachments/"]').first()).toBeVisible({
    timeout: 10_000,
  });

  // Receipt-level extras: general box photo + single total cost
  const generalPhoto = await sharp({
    create: { width: 300, height: 200, channels: 3, background: { r: 90, g: 160, b: 200 } },
  })
    .jpeg()
    .toBuffer();
  await page
    .getByTestId('general-photo-input')
    .setInputFiles({ name: 'general.jpg', mimeType: 'image/jpeg', buffer: generalPhoto });
  await expect(
    page.locator('[data-testid="receipt-files-row"] img[src*="/api/attachments/"]').first(),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('receipt-cost-amount').fill('120');

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

  // Receipt detail shows the single "other"-type cost and the general photo
  const receiptId = href!.match(/\/api\/receipts\/([^/]+)\/labels/)![1];
  await page.goto(`/receipts/${receiptId}`);
  await expect(page.getByText(/120(\.\d+)?\s+CNY/)).toBeVisible();
  await expect(page.locator('img[src*="/api/attachments/"]').first()).toBeVisible({
    timeout: 10_000,
  });

  // Stock table: product photo + amber-bordered general photo, ru in parentheses
  await page.goto('/stock?q=灯具');
  await expect(page.locator('td img[src*="/api/attachments/"]').first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('td img.border-amber-300').first()).toBeVisible();

  // Lightbox: tapping a thumbnail opens the overlay in place (no navigation).
  // The overlay img may fall back from thumb800 to the original variant.
  await page.locator('td img[src*="/api/attachments/"]').first().click();
  const overlay = page.getByRole('button', { name: 'Close' });
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('img[src*="/api/attachments/"]')).toBeVisible({ timeout: 10_000 });
  await overlay.click();
  await expect(overlay).toBeHidden();
  await expect(page).toHaveURL(/\/stock/);

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

  // Unknown code → unclaimed with marking prefilled from the query. Wait for
  // the debounced search to settle (deterministic, no fixed sleep).
  const searchSettled = page.waitForResponse((r) => r.url().includes('/api/clients/search'));
  await page.locator('#clientQuery').fill('QQ9');
  await searchSettled;
  await page.locator('button', { hasText: '❓' }).first().click();
  await expect(page.locator('#marking')).toHaveValue('QQ9');

  // An unknown code that LOOKS like an existing one must not steal the
  // unclaimed path (owner: typing GS500 offered GS300 and left no way out).
  const secondSearch = page.waitForResponse((r) => r.url().includes('/api/clients/search'));
  await page.locator('#clientQuery').fill('GS500');
  await secondSearch;
  // GS500 does not exist; whatever the search returns, the unclaimed path
  // stays reachable — inline row when there are hits, standalone otherwise.
  const inline = page.getByTestId('accept-unclaimed-inline');
  if (await inline.isVisible().catch(() => false)) await inline.click();
  else await page.getByTestId('accept-unclaimed').click();
  await expect(page.locator('#marking')).toHaveValue('GS500');
  // Back to the intended marking for the rest of the flow.
  await page.locator('#marking').fill('QQ9');

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
    .locator('#mobile-product-lines input[type="file"]')
    .first()
    .setInputFiles({ name: 'u.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.locator('#mobile-product-lines img[src*="/api/attachments/"]').first()).toBeVisible({
    timeout: 10_000,
  });

  await page.getByTestId('confirm-receipt').click();
  await expect(page.getByText(/YW-IN-\d{6}-\d{3}/)).toBeVisible({ timeout: 15_000 });
});
