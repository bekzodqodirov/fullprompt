import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * «Sanab qabul» in the browser (0112, package B): the office counts a lot off
 * a truck on the batch card, the phone then refuses that lot in words, and
 * the finish's missing cartons are answered by the lot and a number.
 *
 * The rules — the total, the compare-and-set, the chunks, the growth, the
 * alarms — are proven in tests/integration/count-accept.integration.test.ts
 * and the doors in tests/unit/count-accept-wire.test.ts. What only a browser
 * shows: the panel is reachable and fits a phone, ONE confirm says what the
 * press does, the phone's toast carries the kernel's sentence, and the
 * missing card closes the gap.
 *
 * Self-made: a fresh client, one lot of four cartons with a photo, one truck,
 * all found by the lot's own product text — never by a position another spec
 * could take (#154). Leaves data (a client, a prixod, a closed truck) and no
 * configuration (#183).
 */

const PASSWORD = 'demo1234';
const LOGIST = '+998900000003';
const OPERATOR = '+998900000006'; // YW
const STAMP = String(Date.now()).slice(-6);
const NAME = `Sanab qabul e2e ${STAMP}`;
const PRODUCT = `计数${STAMP}`;

test.describe.configure({ mode: 'serial' });

let code = '';
let batchUrl = '';
let lotId = '';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('the logist mints a client and the operator receives four cartons for it at YW', async ({ page }) => {
  await login(page, LOGIST);
  await page.getByTestId('quick-create').click();
  await page.getByTestId('quick-kind-client').click();
  await page.getByTestId('quick-name').fill(NAME);
  await page.getByTestId('quick-phone').fill(`+99891${String(Date.now()).slice(-7)}`);
  await page.getByTestId('quick-save').click();
  await expect(page.getByTestId('quick-client-made')).toBeVisible({ timeout: 15_000 });
  code = ((await page.getByTestId('quick-client-code').textContent()) ?? '').trim();
  expect(code).toMatch(/^[A-Z0-9]{2,10}$/);

  await login(page, OPERATOR);
  await page.goto('/receive');
  await page.evaluate(() => localStorage.removeItem('gsr-receipt-draft'));
  await page.reload();
  await page.locator('#clientQuery').fill(code.toLowerCase());
  await page.getByRole('button', { name: new RegExp(code) }).first().click();
  await page.getByTestId('lot-zh').fill(PRODUCT);
  await page.getByTestId('lot-count').fill('4');
  await page.getByTestId('lot-L').fill('40');
  await page.getByTestId('lot-W').fill('30');
  await page.getByTestId('lot-H').fill('20');
  await page.getByTestId('lot-kg').fill('9');
  const photo = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 60, g: 150, b: 90 } },
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
  await page.getByTestId('confirm-receipt').click();
  await expect(page.getByText(/YW-IN-\d{6}-\d{3}/)).toBeVisible({ timeout: 15_000 });
});

test('the logist sends the lot YW → AND and the truck leaves with all four', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto('/plans/new');
  await page.getByTestId('plan-origin').selectOption({ label: 'YW' });
  await page.getByTestId('plan-dest').selectOption({ label: 'AND' });
  // By the lot's own product text, never by position.
  const row = page.locator('#plan-stock-table tbody tr').filter({ hasText: PRODUCT }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.locator('input').fill('4');
  await page.getByTestId('submit-plan').click();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.getByTestId('verdict-approve').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]+$/, { timeout: 15_000 });
  batchUrl = page.url();

  await page.getByTestId('open-loading').click();
  await expect(page.getByTestId('load-counter')).toHaveText(/0\/4/, { timeout: 10_000 });
  for (let n = 1; n <= 4; n += 1) {
    await page.getByRole('button', { name: /🏷/ }).click();
    await page.locator('button:has(span.font-mono)').filter({ hasText: /YW26-/ }).first().click();
    await expect(page.getByTestId('load-counter')).toHaveText(new RegExp(`${n}/4`));
  }
  await expect(page.getByTestId('sync-banner')).not.toContainText('🔄', { timeout: 15_000 });
  await page.goto(batchUrl);
  await page.getByTestId('finish-loading').click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('depart-batch').click();
  // The depart button is itself labelled 🚀; the departure line is drawn
  // only once the truck has left.
  await expect(page.getByTestId('batch-facts')).toBeVisible({ timeout: 15_000 });
});

test('the office counts 2 of the lot from the batch card: one confirm, the truck arrives, the lot is the office’s', async ({ page }) => {
  await login(page, LOGIST);
  // The office's count doors are the card's «Yuklash» tab.
  await page.goto(`${batchUrl}/yuklash#count-accept`);
  // The anchor opens the panel by itself.
  const lot = page.locator('[data-testid^="count-lot-"]').filter({ hasText: PRODUCT });
  await expect(lot).toBeVisible({ timeout: 10_000 });
  lotId = ((await lot.getAttribute('data-testid')) ?? '').replace('count-lot-', '');
  expect(lotId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByTestId(`count-numbers-${lotId}`)).toContainText('4');

  await page.getByTestId(`count-target-${lotId}`).fill('2');
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  await page.getByTestId(`count-accept-${lotId}`).click();
  await expect(page.getByTestId(`count-result-${lotId}`)).toContainText('✅', { timeout: 15_000 });
  // ONE confirm, carrying both the arrival (the truck was on the road — AND
  // tells clients) and the shortfall, in numbers.
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain('«');
  expect(dialogs[0]).toContain(`${code}-`);
  expect(dialogs[0]).toMatch(/4[^0-9]+2/);

  // A counted lot still aboard is the office's open work: the panel opens by itself.
  await page.goto(`${batchUrl}/yuklash`);
  await expect(page.getByTestId('count-accept-panel')).toBeVisible();
  const after = page.getByTestId(`count-lot-${lotId}`);
  await expect(after).toContainText('🔢');
  await expect(page.getByTestId(`count-numbers-${lotId}`)).toContainText('2');
  await expect(page.getByTestId(`count-last-${lotId}`)).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
});

test('the phone refuses the counted lot in words, and its counter does not move', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto(batchUrl);
  await page.getByTestId('open-unloading').click();
  await expect(page.getByTestId('unload-counter')).toHaveText(/2\/4/, { timeout: 10_000 });
  await expect(page.getByTestId('open-count-accept')).toBeVisible();
  // The sticker sheet no longer offers the office's lot.
  await page.getByRole('button', { name: /🏷/ }).click();
  await expect(page.locator('button:has(span.font-mono)').filter({ hasText: PRODUCT })).toHaveCount(0);
  // Typed by hand, a code of that lot is refused on the phone itself.
  const cartons = await page.evaluate(async (url) => {
    const res = await fetch(`/api/batches/${url.split('/').pop()}/planned`);
    const body = (await res.json()) as { boxes: { shortCode: string; status: string; productNameZh: string }[] };
    return body.boxes;
  }, batchUrl);
  const aboard = cartons.find((b) => b.productNameZh.includes(PRODUCT) && b.status === 'in_transit');
  expect(aboard).toBeTruthy();
  await page.getByTestId('manual-code').fill(aboard!.shortCode);
  await page.getByTestId('manual-submit').click();
  const toast = page.getByTestId('unload-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('🔢');
  await expect(toast).toContainText(`${code}-`);
  await expect(page.getByTestId('unload-counter')).toHaveText(/2\/4/);
});

test('the finish names the missing by lot, and «2 of them are here» closes the gap', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto(`${batchUrl}/yuklash`);
  page.on('dialog', (d) => void d.accept());
  await page.getByTestId('finish-unload').click();
  const missing = page.getByTestId(`missing-lot-${lotId}`);
  await expect(missing).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`missing-lot-count-${lotId}`)).toContainText('2');
  await expect(page.getByTestId(`missing-lot-n-${lotId}`)).toHaveValue('2');
  await page.getByTestId(`missing-lot-here-${lotId}`).click();
  await expect(missing).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('close-batch')).toBeVisible();
  await page.getByTestId('close-batch').click();
  await expect(page.getByTestId('close-batch')).toBeHidden({ timeout: 15_000 });
});
