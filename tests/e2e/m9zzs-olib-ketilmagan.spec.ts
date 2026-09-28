import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

/**
 * «Olib ketilmagan yuk» (0116, the owner's 3a) in a real browser, at 360 px:
 *
 *  t1 a SELLER mints a client — so the seller is its manager (round 111);
 *  t2 the LOGIST types an office prixod for it at TAS1, received SIX days ago
 *     (0112's back-dating): a walk-in dated by its receipt's day, which is the
 *     design review's #1 — dated by the typing minute it would read «0 kun»
 *     and never reach the 5+ tab;
 *  t3 the logist sees it on the default 5+ tab and on «Hammasi», not on 10+,
 *     and the home carries the row's door;
 *  t4 the seller sees it on her own list;
 *  t5 the admin's seller filter: «sotuvchisiz» hides it, the seller shows it
 *     (the review's #11 — there is no second demo seller to log in as);
 *  t6 the accountant and the VED are refused by the URL;
 *  t7 cleanup IS a test (#183): the prixod voided, the client deactivated —
 *     data only, no configuration is left behind.
 *
 * This is also the render-time i18n check for the new keys (#163).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const SELLER = '+998900000009';
const LOGIST = '+998900000003';
const ADMIN = '+998900000002';
const ACCOUNTANT = '+998900000010';
const VED = '+998900000004';
const runId = String(Date.now()).slice(-6);
const CLIENT_NAME = `Olib ketilmagan ${runId}`;
const PRODUCT = `未提${runId}`;
const LIST = '/my-clients/olib-ketilmagan';

let code = '';
let clientUrl = '';
let receiptUrl = '';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** Six days before today on Tashkent's wall clock. */
function sixDaysAgoInTashkent(): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 6);
  return d.toISOString().slice(0, 10);
}

const row = (page: Page) => page.locator(`[data-testid="uncollected-row"][data-client="${code}"]`);

test('t1: a seller mints a client and so becomes its manager', async ({ page }) => {
  await login(page, SELLER);
  await page.getByTestId('quick-create').click();
  await page.getByTestId('quick-kind-client').click();
  await page.getByTestId('quick-name').fill(CLIENT_NAME);
  await page.getByTestId('quick-phone').fill(`+99890${runId}1`);
  await page.getByTestId('quick-save').click();
  await expect(page.getByTestId('quick-client-made')).toBeVisible({ timeout: 15_000 });
  code = (await page.getByTestId('quick-client-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{2,10}$/);
  await page.getByTestId('quick-to-card').click();
  await expect(page.locator('h1')).toContainText(code);
  clientUrl = new URL(page.url()).pathname;
});

test('t2: the logist types an office prixod at TAS1, received six days ago', async ({ page }) => {
  expect(code, 't1 minted the client').not.toBe('');
  await login(page, LOGIST);
  await page.goto('/receive');
  await page.evaluate(() => localStorage.removeItem('gsr-receipt-draft'));
  await page.reload();
  await page.getByTestId('receive-warehouse').selectOption({ label: 'TAS1' });

  await page.locator('#clientQuery').fill(code.toLowerCase());
  await page.getByRole('button', { name: new RegExp(code) }).first().click();
  await expect(page.getByText(`${code} —`)).toBeVisible();

  await page.getByTestId('lot-zh').fill(PRODUCT);
  await page.getByTestId('lot-count').fill('3');
  await page.getByTestId('lot-L').fill('40');
  await page.getByTestId('lot-W').fill('30');
  await page.getByTestId('lot-H').fill('20');
  await page.getByTestId('lot-kg').fill('5');
  const photo = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 120, b: 150 } },
  })
    .jpeg()
    .toBuffer();
  await page
    .locator('#mobile-product-lines input[type="file"]')
    .first()
    .setInputFiles({ name: 'olib.jpg', mimeType: 'image/jpeg', buffer: photo });
  await expect(page.locator('#mobile-product-lines img[src*="/api/attachments/"]').first()).toBeVisible({
    timeout: 20_000,
  });

  // Who received it: the logist himself (the picker's first real option).
  await page.getByTestId('receive-receiver').selectOption({ index: 1 });
  await page.getByTestId('receive-date').fill(sixDaysAgoInTashkent());
  await page.getByTestId('confirm-receipt').click();
  await expect(page.getByTestId('print-labels').first()).toBeVisible({ timeout: 15_000 });
  const printHref = await page.getByTestId('print-labels').first().getAttribute('href');
  const receiptId = printHref!.match(/\/print\/receipts\/([^/?]+)/)![1];
  receiptUrl = `/receipts/${receiptId}`;
});

test('t3: the logist sees it at six days on the 5+ tab and «Hammasi», not on 10+', async ({ page }) => {
  expect(receiptUrl, 't2 made the prixod').not.toBe('');
  await login(page, LOGIST);
  // The door on his home, whatever else is waiting in the company.
  await expect(page.getByTestId('logist-flow-uncollected')).toBeVisible();

  await page.goto(LIST);
  await expect(row(page)).toHaveCount(1);
  await expect(row(page).getByTestId('uncollected-days')).toHaveText(/\b6\b/);
  await expect(row(page)).toContainText('TAS1');
  await expect(row(page)).toContainText('Dilnoza');
  // Six days: on the warn line, below the alarm.
  await expect(row(page).getByTestId('uncollected-days')).toHaveClass(/chip-warn/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  await page.getByTestId('uncollected-tab-qizil').click();
  await expect(page).toHaveURL(/daraja=qizil/);
  await expect(row(page)).toHaveCount(0);

  await page.getByTestId('uncollected-tab-hammasi').click();
  await expect(page).toHaveURL(/daraja=hammasi/);
  await expect(row(page)).toHaveCount(1);
});

test('t4: the seller sees her own client on her own list', async ({ page }) => {
  expect(receiptUrl, 't2 made the prixod').not.toBe('');
  await login(page, SELLER);
  await page.goto(LIST);
  await expect(row(page)).toHaveCount(1);
  // A seller has no seller picker — her book is her own.
  await expect(page.getByTestId('uncollected-seller-form')).toHaveCount(0);
  await row(page).locator('a').first().click();
  await expect(page).toHaveURL(clientUrl);
});

test('t5: the admin\'s seller filter — «sotuvchisiz» hides it, the seller shows it', async ({ page }) => {
  expect(receiptUrl, 't2 made the prixod').not.toBe('');
  await login(page, ADMIN);
  await page.goto(LIST);
  await page.getByTestId('uncollected-seller').selectOption('none');
  await page.getByTestId('uncollected-seller-form').locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/sotuvchi=none/);
  await expect(row(page)).toHaveCount(0);

  await page.getByTestId('uncollected-seller').selectOption({ label: 'Dilnoza (Sales)' });
  await page.getByTestId('uncollected-seller-form').locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/sotuvchi=[0-9a-f-]{36}/);
  await expect(row(page)).toHaveCount(1);
});

test('t6: the accountant and the VED are refused by the URL', async ({ page }) => {
  for (const phone of [ACCOUNTANT, VED]) {
    await login(page, phone);
    await page.goto(LIST);
    await expect(page, phone).toHaveURL('/');
  }
});

test('t7: cleanup — the prixod is voided and the client deactivated', async ({ page }) => {
  expect(receiptUrl, 't2 made the prixod').not.toBe('');
  await login(page, LOGIST);
  await page.goto(receiptUrl);
  await page.locator('#void-reason').fill(`e2e olib ${runId}`);
  await page.locator('form:has(#void-reason) button[type="submit"]').click();
  await expect(page.getByTestId('void-error')).toHaveCount(0);
  await expect(page.locator('#void-reason')).toHaveCount(0, { timeout: 15_000 });

  await page.goto(`${LIST}?daraja=hammasi`);
  await expect(row(page)).toHaveCount(0);

  await page.goto(clientUrl);
  await expect(page.locator('h1')).toContainText(code);
  await page.locator('button.btn-danger').first().click();
  await expect(page.locator('button.btn-primary').first()).toBeVisible();
});
