import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * «QR yopishtirilmadi» (0112, the owner's Q8), walked by the people who do it:
 * the YW operator receives a lot of sacks with no sticker, the stock table
 * and the stocktake say so and never offer them as lost, the stickers are
 * printed LATER where the sacks stand and confirmed on, and the YW manager
 * voids the test receipt at the end so YW's stock is what it was.
 *
 * Data only (#183): one receipt of its own, found by a product name no other
 * spec uses, voided by the final TEST (round 57: an `afterAll` cleanup lies
 * when the run dies before it). The stocktake is opened and NEVER submitted —
 * a submit would write YW's other cartons off for every later spec.
 */

const OPERATOR = '+998900000006'; // Wang Lei, YW operator (zh-CN)
const MANAGER = '+998900000005'; // Aziz, YW manager
const PASSWORD = 'demo1234';
const PRODUCT = `无码袋${String(Date.now()).slice(-6)}`;

let receiptHref = '';
let ywId = '';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test.describe.serial('QR-siz lot: marked at the door, printed later, never written off', () => {
  test('T1 — the operator ticks «QR yopishtirilmadi» and gets no sticker for it', async ({ page }) => {
    await login(page, OPERATOR);
    await page.goto('/receive');
    await page.evaluate(() => localStorage.removeItem('gsr-receipt-draft'));
    await page.reload();

    await page.locator('#clientQuery').fill('gs777');
    await page.getByRole('button', { name: /GS777/ }).click();
    await expect(page.getByText('GS777 —')).toBeVisible();

    await page.getByTestId('lot-zh').fill(PRODUCT);
    await page.getByTestId('lot-count').fill('2');
    await page.getByTestId('lot-L').fill('60');
    await page.getByTestId('lot-W').fill('40');
    await page.getByTestId('lot-H').fill('30');
    await page.getByTestId('lot-kg').fill('12');
    await page.getByTestId('lot-qr-skipped').check();

    const photo = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 150, g: 120, b: 60 } },
    })
      .jpeg()
      .toBuffer();
    await page
      .locator('#mobile-product-lines input[type="file"]')
      .first()
      .setInputFiles({ name: 'sack.jpg', mimeType: 'image/jpeg', buffer: photo });
    await expect(page.locator('#mobile-product-lines img[src*="/api/attachments/"]').first()).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId('confirm-receipt').click();
    await expect(page.getByTestId('receipt-lot-qrless')).toBeVisible({ timeout: 15_000 });
    // Nothing to print for a lot whose cartons get no sticker — and the
    // screen says where the stickers come from instead.
    await expect(page.getByTestId('receipt-qrless-note')).toBeVisible();
    await expect(page.getByTestId('print-labels')).toHaveCount(0);

    const hrefs = await page.locator('a[href^="/receipts/"]').evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('href') ?? ''),
    );
    receiptHref = hrefs.find((href) => /^\/receipts\/[0-9a-f-]{36}$/.test(href)) ?? '';
    expect(receiptHref).not.toBe('');
  });

  test('T2 — the stock row wears the chip, and a banner leads to the print list', async ({ page }) => {
    await login(page, OPERATOR);
    await page.goto(`/stock?q=${encodeURIComponent(PRODUCT)}`);
    await expect(page.locator('tbody tr').filter({ hasText: PRODUCT }).getByTestId('qrless-chip')).toBeVisible();
    const banner = page.getByTestId('stock-qrless-print').first();
    await expect(banner).toBeVisible();
    const href = (await banner.getAttribute('href')) ?? '';
    ywId = /warehouseId=([0-9a-f-]{36})/.exec(href)?.[1] ?? '';
    expect(ywId).not.toBe('');
    expect(href).toContain('mode=stiker');
  });

  test('T3 — the stocktake counts what a scan can find and never offers the sacks as lost', async ({ page }) => {
    await login(page, MANAGER);
    await page.goto(`/inventory?warehouseId=${ywId}&mode=full`);
    await expect(page.getByTestId('inventory-finish')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('inventory-qrless-count')).toBeVisible();
    await page.getByTestId('inventory-finish').click();
    const kept = page.getByTestId('inventory-qrless');
    await expect(kept).toBeVisible();
    await expect(kept).toContainText(PRODUCT);
    // The manager ticks what goes lost — and there is nothing to tick here.
    await expect(kept.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(page.getByTestId('inventory-missing')).not.toContainText(PRODUCT);
    // NOT submitted: YW's other cartons stay where they are for the next spec.
  });

  test('T4 — printed where they stand, confirmed on, and the chip is gone', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __prints: number }).__prints = 0;
      window.print = () => {
        (window as unknown as { __prints: number }).__prints += 1;
      };
    });
    await login(page, OPERATOR);
    await page.goto(`/inventory?warehouseId=${ywId}`);
    await page.getByTestId('inventory-mode-stiker').click();
    const row = page.getByTestId('qr-print-lot').filter({ hasText: PRODUCT });
    await expect(row).toBeVisible();
    await row.getByTestId('print-labels').click();

    await expect(page).toHaveURL(/\/print\/qrsiz\?/);
    await expect(page.locator('.label-frame')).toHaveCount(2);
    // Opening the sheet printed, and stamped nothing: the row is still QR-siz.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints))
      .toBeGreaterThan(0);

    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('qr-stuck-confirm').click();
    await expect(page.getByTestId('qr-stuck-done')).toBeVisible();

    await page.goto(`/stock?q=${encodeURIComponent(PRODUCT)}`);
    const line = page.locator('tbody tr').filter({ hasText: PRODUCT });
    await expect(line).toBeVisible();
    await expect(line.getByTestId('qrless-chip')).toHaveCount(0);
  });

  test('T5 — the manager voids the test receipt, so YW stock is what it was', async ({ page }) => {
    expect(receiptHref).not.toBe('');
    await login(page, MANAGER);
    await page.goto(receiptHref);
    await page.getByTestId('void-receipt-reason').fill('e2e QR-siz test');
    await page.getByTestId('void-receipt-btn').click();
    await expect(page.getByTestId('void-receipt-btn')).toHaveCount(0, { timeout: 15_000 });
    await page.goto(`/stock?q=${encodeURIComponent(PRODUCT)}`);
    await expect(page.locator('tbody tr').filter({ hasText: PRODUCT })).toHaveCount(0);
  });
});
