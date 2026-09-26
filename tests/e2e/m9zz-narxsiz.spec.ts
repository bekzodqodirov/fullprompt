import { expect, test } from '@playwright/test';
import sharp from 'sharp';

/**
 * «Narxsiz yuk» in the browser (0104, owner's Q3b: «ruxsat berilmasa olib
 * ketolmasin, taqiq tursin»).
 *
 * The rule itself — which carton has a price, the gate's instant, the one
 * approval for two questions — is proven in
 * tests/integration/unpriced-cargo.integration.test.ts, the door halves in
 * tests/unit/unpriced-gate-wire.test.ts. What only a browser shows: a road
 * landing with no price is on the accountant's list and NOT on another
 * seller's, the counter refuses it until a holder ticks the override, and the
 * list then says it went out. It is also the render-time i18n check for both
 * screens (#163) as people who are not the admin.
 *
 * Deterministic and self-made: a fresh client, one carton, one truck. It
 * leaves data (a client, a prixod, a truck — history) and no configuration
 * (#183).
 */

const PASSWORD = 'demo1234';
const LOGIST = '+998900000003';
const VED = '+998900000004';
const OPERATOR = '+998900000006'; // YW
const SELLER = '+998900000009';
const ACCOUNTANT = '+998900000010';
const NAME = `Narxsiz e2e ${String(Date.now()).slice(-6)}`;
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date());

test.describe.configure({ mode: 'serial' });

let code = '';
let batchUrl = '';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const listRow = (page: import('@playwright/test').Page) =>
  page.getByTestId('unpriced-client').filter({ hasText: code });

/**
 * The list is paged (150 prixods) with the LONGEST-waiting first, so this
 * spec's brand-new carton sits on the last page whenever the shared database
 * already holds more landed, unpriced cargo from today — which CI's vitest
 * run leaves behind (#154: state a spec leaves is the next one's input).
 * Walks the pages and stays on the one carrying the row; 0 = on none.
 */
async function openOurPage(page: import('@playwright/test').Page): Promise<number> {
  for (let n = 1; n <= 20; n += 1) {
    await page.goto(`/finance/narxsiz?dan=${TODAY}&page=${n}`);
    await expect(page.getByTestId('unpriced-gate')).toBeVisible();
    if ((await listRow(page).count()) > 0) return n;
    if ((await page.getByTestId('unpriced-client').count()) === 0) return 0;
  }
  return 0;
}

test('the logist mints a client and the operator receives one carton for it at YW', async ({ page }) => {
  await login(page, LOGIST);
  await page.getByTestId('quick-create').click();
  await page.getByTestId('quick-kind-client').click();
  await page.getByTestId('quick-name').fill(NAME);
  await page.getByTestId('quick-phone').fill(`+99890${String(Date.now()).slice(-7)}`);
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
  await page.getByTestId('lot-zh').fill('无价');
  await page.getByTestId('lot-count').fill('1');
  await page.getByTestId('lot-L').fill('40');
  await page.getByTestId('lot-W').fill('30');
  await page.getByTestId('lot-H').fill('20');
  await page.getByTestId('lot-kg').fill('9');
  const photo = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 120, g: 90, b: 200 } },
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

test('the logist sends it YW → AND by truck and unloads it', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto('/plans/new');
  await page.getByTestId('plan-origin').selectOption({ label: 'YW' });
  await page.getByTestId('plan-dest').selectOption({ label: 'AND' });
  const row = page.locator('#plan-stock-table tbody tr').filter({ hasText: code }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.locator('input').fill('1');
  await page.getByTestId('submit-plan').click();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.getByTestId('verdict-approve').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]+$/, { timeout: 15_000 });
  batchUrl = page.url();

  await page.getByTestId('open-loading').click();
  await expect(page.getByTestId('load-counter')).toHaveText(/0\/1/, { timeout: 10_000 });
  await page.getByRole('button', { name: /🏷/ }).click();
  await page.locator('button:has(span.font-mono)').filter({ hasText: /YW26-/ }).first().click();
  await expect(page.getByTestId('load-counter')).toHaveText(/1\/1/);
  await expect(page.getByTestId('sync-banner')).not.toContainText('🔄', { timeout: 15_000 });
  await page.goto(batchUrl);
  await page.getByTestId('finish-loading').click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('depart-batch').click();
  await expect(page.getByText(/🚀/).first()).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('open-unloading').click();
  await expect(page.getByTestId('unload-counter')).toHaveText(/0\/1/, { timeout: 10_000 });
  await page.getByRole('button', { name: /🏷/ }).click();
  await page.locator('button:has(span.font-mono)').filter({ hasText: /YW26-/ }).first().click();
  await expect(page.getByTestId('unload-counter')).toHaveText(/1\/1/);
  await expect(page.getByTestId('sync-banner')).not.toContainText('🔄', { timeout: 15_000 });
  // The counter is the phone's own optimistic mark and the banner can read
  // ✅ before the queue has even counted the scan, so a test that ends here
  // closes the page with the landing still in the outbox — the carton stays
  // in_transit and is on no list (seen in CI and here). The batch card is
  // the server's answer: poll it, as m4 does.
  await expect(async () => {
    await page.goto(batchUrl);
    await expect(page.getByTestId('unload-remaining')).toContainText('✅');
  }).toPass({ timeout: 20_000 });
});

test('the accountant sees it on the list, blocked, with the truck as a door; another seller does not', async ({ page }) => {
  await login(page, ACCOUNTANT);
  expect(await openOurPage(page)).toBeGreaterThan(0);
  await expect(listRow(page)).toHaveCount(1);
  await expect(listRow(page).getByTestId('unpriced-blocked')).toBeVisible();
  await expect(listRow(page).locator('a[data-testid="unpriced-truck"]')).toHaveCount(1);

  // The client's manager is the logist who minted it (round 111), so Dilnoza's
  // money scope does not include it.
  await login(page, SELLER);
  expect(await openOurPage(page)).toBe(0);

  // The VED keeps the price-only view of «Partiya moliyasi» (Q19), so the
  // truck is a door for him too — never one that bounces.
  await login(page, VED);
  expect(await openOurPage(page)).toBeGreaterThan(0);
  await expect(listRow(page)).toHaveCount(1);
  const truck = listRow(page).locator('a[data-testid="unpriced-truck"]');
  await expect(truck).toHaveCount(1);
  await truck.click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]+\/pricing$/);
});

test('the counter refuses it until the holder ticks the override, and the list then says it went out', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto('/issue');
  await page.getByTestId('issue-wh').selectOption({ label: 'AND' });
  const searchSettled = page.waitForResponse((r) => r.url().includes('/api/clients/search'));
  await page.locator('#issueClientQuery').fill(code);
  await searchSettled;
  await page.getByRole('button', { name: new RegExp(code) }).first().click();

  const firstLot = page.locator('#issuable-boxes > div').first();
  await expect(firstLot).toBeVisible({ timeout: 10_000 });
  await firstLot.locator('button').first().click();
  await page.getByTestId('receiver-name').fill('Narxsiz Oluvchi');
  await page.getByTestId('receiver-phone').fill('+998907770011');

  await expect(page.getByTestId('issue-unpriced')).toBeVisible();
  await expect(page.getByTestId('confirm-issue')).toBeDisabled();
  await page.getByTestId('issue-price-ok').check();
  await expect(page.getByTestId('confirm-issue')).toBeEnabled();
  await page.getByTestId('confirm-issue').click();
  await expect(page.getByTestId('act-link')).toBeVisible({ timeout: 15_000 });

  await login(page, ACCOUNTANT);
  expect(await openOurPage(page)).toBeGreaterThan(0);
  await expect(listRow(page).getByTestId('unpriced-issued')).toBeVisible();
});
