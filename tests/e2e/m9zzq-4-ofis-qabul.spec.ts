import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * The office receipt, the factory barcode and the pallet (0112, the owner's
 * Q9 b, Q10 c and Q10 d), walked as the LOGIST on a phone:
 *
 *  t1 the prixod the floor could not type, entered from the office — who
 *     physically received it (Wang Lei, the YW operator) and the real day
 *     (yesterday in Yiwu), with the factory's barcode on the lot;
 *  t2 the barcode finds the lot in the search and on /stock;
 *  t4 on a loading screen the barcode IDENTIFIES the pile and loads nothing;
 *  t5 a pallet of two of its cartons, made from the prixod card's door;
 *  t6 the cleanup IS a test (#183, round 57): the prixod is voided, so the
 *     spec leaves audit rows and nothing a later spec could trip on.
 *
 * Serial, one worker, one database: every locator names this run's own lot.
 */

test.describe.configure({ mode: 'serial' });

const LOGIST = '+998900000003';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-8);
const PRODUCT = `办公室${runId}`;
// A unique EAN-13: the lookups are exact, and another run's lot is a true hit.
const BARCODE = `69${String(Date.now()).slice(-11)}`;

let receiptUrl = '';

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(LOGIST);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** Yesterday on Yiwu's wall clock — the day the office says the cargo came. */
function yesterdayInYiwu(): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

test('t1: the logist enters a prixod from the office, naming who received it and the day', async ({ page }) => {
  await login(page);
  // «Qabul» is in his menu now, so «+ Yangi» offers it by itself.
  await page.getByTestId('quick-create').click();
  await expect(page.getByTestId('quick-act-receive')).toBeVisible();

  await page.goto('/receive');
  await page.evaluate(() => localStorage.removeItem('gsr-receipt-draft'));
  await page.reload();

  // No default warehouse for the office: the confirm says so first.
  await expect(page.getByTestId('receive-warehouse')).toHaveValue('');
  await page.getByTestId('receive-warehouse').selectOption({ label: 'YW' });

  await page.locator('#clientQuery').fill('gs777');
  await page.getByRole('button', { name: /GS777/ }).first().click();
  await expect(page.getByText('GS777 —')).toBeVisible();

  await page.getByTestId('lot-zh').fill(PRODUCT);
  await page.getByTestId('lot-count').fill('4');
  await page.getByTestId('lot-L').fill('40');
  await page.getByTestId('lot-W').fill('30');
  await page.getByTestId('lot-H').fill('20');
  await page.getByTestId('lot-kg').fill('6');
  await page.getByTestId('lot-barcode').fill(BARCODE);
  await expect(page.getByTestId('lot-barcode-invalid')).toHaveCount(0);

  const photo = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 120, g: 150, b: 90 } },
  })
    .jpeg()
    .toBuffer();
  await page
    .locator('#mobile-product-lines input[type="file"]')
    .first()
    .setInputFiles({ name: 'ofis.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.locator('#mobile-product-lines img[src*="/api/attachments/"]').first()).toBeVisible({
    timeout: 20_000,
  });

  // Everything else is filled: the one thing missing is WHO received it.
  await expect(page.getByTestId('confirm-receipt')).toBeDisabled();
  await page.getByTestId('receive-receiver').selectOption({ label: 'Wang Lei (YW operator)' });
  const day = yesterdayInYiwu();
  await page.getByTestId('receive-date').fill(day);

  // The page must not have grown sideways at 360 px.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  await page.getByTestId('confirm-receipt').click();
  await expect(page.getByText(/YW-IN-\d{6}-\d{3}/)).toBeVisible({ timeout: 15_000 });
  const printHref = await page.getByTestId('print-labels').first().getAttribute('href');
  const receiptId = printHref!.match(/\/print\/receipts\/([^/?]+)/)![1];
  receiptUrl = `/receipts/${receiptId}`;
  await page.goto(receiptUrl);

  await expect(page.getByTestId('receipt-received-date')).toHaveAttribute('data-day', day);
  await expect(page.getByTestId('receipt-received-by')).toContainText('Wang Lei');
  await expect(page.getByTestId('receipt-entered-by')).toContainText('Logist Demo');
  await expect(page.getByTestId('lot-barcode-fact')).toContainText(BARCODE);
});

test('t2: the barcode finds the lot in the search and on /stock', async ({ page }) => {
  expect(receiptUrl, 't1 made the prixod').not.toBe('');
  await login(page);
  await page.goto(`/search?q=${BARCODE}`);
  await expect(page.getByTestId('search-hit').filter({ hasText: BARCODE }).first()).toContainText('GS777-');

  await page.goto(`/stock?q=${BARCODE}`);
  const rows = page.locator('td a[href*="/stock?lot="]');
  await expect(rows).toHaveCount(1);
  await expect(page.locator('table')).toContainText(PRODUCT);
});

test('t4: on the loading screen the barcode identifies the pile and loads nothing', async ({ page }) => {
  expect(receiptUrl, 't1 made the prixod').not.toBe('');
  await login(page);
  await page.goto('/batches');
  await page.locator('select[name="originId"]').selectOption({ label: 'YW' });
  await page.locator('select[name="destId"]').selectOption({ label: 'TAS1' });
  await page.getByTestId('create-quick-batch').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
  const batchUrl = page.url();

  try {
    await page.goto(`${batchUrl}/load`);
    const counter = page.getByTestId('load-counter');
    await expect(counter).toBeVisible({ timeout: 20_000 });
    const before = await counter.textContent();

    await page.getByTestId('manual-open').click();
    await page.getByTestId('manual-code').fill(BARCODE);
    await page.getByTestId('manual-submit').click();

    const sheet = page.getByTestId('barcode-identify');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('barcode-identify-lot')).toContainText('GS777-');
    await expect(sheet.getByTestId('barcode-identify-lot')).toContainText(PRODUCT);
    // Nothing was queued or loaded.
    await expect(counter).toHaveText(before ?? '');
    await expect(page.getByTestId('sync-banner')).toContainText('✅');
    await sheet.getByTestId('barcode-identify-close').click();
    await expect(sheet).toHaveCount(0);
  } finally {
    // The truck is cancelled whatever happened above — a forming truck left
    // behind would be the next spec's input (#154).
    await page.goto(batchUrl);
    await page.getByTestId('cancel-batch').click();
    await page.locator('#cancel-reason').fill(`ofis sinov ${runId}`);
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('cancel-batch-confirm').click();
    await expect(page.getByTestId('cancel-batch')).toHaveCount(0, { timeout: 15_000 });
  }
});

test('t5: a pallet of two cartons, made from the prixod card', async ({ page }) => {
  expect(receiptUrl, 't1 made the prixod').not.toBe('');
  await login(page);
  await page.goto(receiptUrl);
  await page.getByTestId('lot-make-pallet').first().click();
  await expect(page).toHaveURL(/\/crates\/new\?/);
  // Opened filled: the warehouse, the client, the lot, the kind.
  await expect(page.getByTestId('crate-kind-palet')).toHaveAttribute('aria-pressed', 'true');
  // The door's own lot, focused — among every other GS777 lot at YW.
  const count = page.locator('#cratable-boxes > div').filter({ hasText: PRODUCT }).getByTestId('crate-lot-count');
  await expect(count).toBeFocused({ timeout: 10_000 });
  await count.fill('2');
  await page.getByRole('checkbox').check();
  await expect(page.getByTestId('create-crate')).toContainText('(2 📦)');
  await page.getByTestId('create-crate').click();

  await expect(page).toHaveURL(/\/crates\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect(page.getByTestId('crate-kind')).toHaveText(/ПАЛЛЕТ|PALET|PALLET|托盘/);
  await expect(page.locator('h1').first()).toHaveText(/^CR-YW\d{2}-\d{5}$/);
  const labelHref = await page.getByTestId('print-labels').getAttribute('href');
  const crateId = labelHref!.match(/\/print\/crates\/([^/?]+)/)![1];
  const label = await page.request.get(`/api/crates/${crateId}/label`);
  expect(label.status()).toBe(200);
  expect((await label.body()).subarray(0, 4).toString()).toBe('%PDF');

  // Dissolve — the cartons go back to the shelf loose, for t6's void.
  await page.getByRole('button', { name: /⛏/ }).click();
  await expect(page).toHaveURL(/\/crates$/, { timeout: 15_000 });
});

test('t6: cleanup — the prixod is voided and leaves the shelf', async ({ page }) => {
  expect(receiptUrl, 't1 made the prixod').not.toBe('');
  await login(page);
  await page.goto(receiptUrl);
  await page.locator('#void-reason').fill(`e2e ofis ${runId}`);
  await page.locator('form:has(#void-reason) button[type="submit"]').click();
  await expect(page.getByTestId('void-error')).toHaveCount(0);
  await expect(page.locator('#void-reason')).toHaveCount(0, { timeout: 15_000 });
  await page.goto(`/stock?q=${BARCODE}`);
  await expect(page.locator('td a[href*="/stock?lot="]')).toHaveCount(0);
});
