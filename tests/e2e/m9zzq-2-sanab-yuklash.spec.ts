import { expect, test } from '@playwright/test';
import sharp from 'sharp';

/**
 * «Sanab yuklash» in the browser (0112, the owner's Q1-Q7): the office's
 * count-load door on the batch card, and the phone that stops scanning the
 * lot once the office has counted it.
 *
 * The rules — the total with its compare-and-set, the reverse gear, the plan
 * and the prixod as ceilings, the lock order — are proven in
 * tests/integration/count-load.integration.test.ts. What only a browser
 * shows: the panel exists for the logist and NOT for the warehouse manager
 * (Q3), the phone refuses a counted lot at once with its name (offline too,
 * so nothing is queued), an over-plan press asks for a reason in words, and
 * the whole panel fits a 360 px phone.
 *
 * Self-made and deterministic: a fresh client, one lot of four cartons, one
 * truck planned with three. It leaves data (a client, a prixod, a truck —
 * history) and no configuration (#183).
 */

const PASSWORD = 'demo1234';
const LOGIST = '+998900000003';
const MANAGER = '+998900000005'; // YW warehouse manager
const OPERATOR = '+998900000006'; // YW
const NAME = `Sanab e2e ${String(Date.now()).slice(-6)}`;

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

const ourRow = (page: import('@playwright/test').Page) =>
  page.getByTestId('count-load-row').filter({ hasText: code });

test('the logist mints a client and the operator receives four cartons for it at YW', async ({ page }) => {
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
  await page.getByTestId('lot-zh').fill('计数');
  await page.getByTestId('lot-count').fill('4');
  await page.getByTestId('lot-L').fill('40');
  await page.getByTestId('lot-W').fill('30');
  await page.getByTestId('lot-H').fill('20');
  await page.getByTestId('lot-kg').fill('9');
  const photo = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 60, g: 140, b: 90 } },
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

test('the logist plans three of the four onto a YW → AND truck', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto('/plans/new');
  await page.getByTestId('plan-origin').selectOption({ label: 'YW' });
  await page.getByTestId('plan-dest').selectOption({ label: 'AND' });
  const row = page.locator('#plan-stock-table tbody tr').filter({ hasText: code }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.locator('input').fill('3');
  await page.getByTestId('submit-plan').click();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]+$/, { timeout: 15_000 });
  await page.getByTestId('verdict-approve').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]+$/, { timeout: 15_000 });
  batchUrl = page.url();
});

test('the warehouse manager has no count door (Q3) — neither on the card nor on the scan screen', async ({ page }) => {
  expect(batchUrl).toMatch(/\/batches\//);
  await login(page, MANAGER);
  await page.goto(batchUrl);
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.getByTestId('count-load-open')).toHaveCount(0);
  await page.goto(`${batchUrl}/load`);
  await expect(page.getByTestId('open-count-load')).toHaveCount(0);
});

test('the logist counts two aboard on the card; the chip says so; the panel fits the phone', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto(`${batchUrl}/load`);
  // The logist standing at the truck reaches the panel in one tap.
  await page.getByTestId('open-count-load').click();
  await expect(page).toHaveURL(/#count-load$/);
  await expect(ourRow(page)).toBeVisible({ timeout: 15_000 });
  await expect(ourRow(page).getByTestId('count-load-aboard')).toHaveText('0/3');
  await ourRow(page).getByTestId('count-load-input').fill('2');
  await ourRow(page).getByTestId('count-load-save').click();
  await expect(ourRow(page).getByTestId('count-load-result')).toContainText('2');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  await page.reload();
  await expect(page.getByTestId('batch-counted-chip')).toContainText('2');
  await expect(ourRow(page)).toHaveAttribute('data-mode', 'counted');
});

test('the operator’s phone refuses the counted lot at once, by name, and queues nothing — even offline', async ({ page }) => {
  await login(page, OPERATOR);
  const batchId = batchUrl.split('/').pop()!;
  const snap = (await (await page.request.get(`/api/batches/${batchId}/planned`)).json()) as {
    boxes: { shortCode: string; status: string; clientCode: string | null; letter: string | null }[];
  };
  const planned = snap.boxes.find((b) => b.status === 'planned' && b.clientCode === code)!;
  expect(planned).toBeTruthy();
  const label = `${code}-${planned.letter}`;

  await page.goto(`${batchUrl}/load`);
  await expect(page.getByTestId('lot-count-only').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('open-count-load')).toHaveCount(0);
  const counter = await page.getByTestId('load-counter').textContent();

  await page.context().setOffline(true);
  await page.getByRole('button', { name: /🏷/ }).click();
  await page.getByTestId('manual-code').fill(planned.shortCode);
  await page.getByTestId('manual-submit').click();
  await expect(page.getByTestId('load-toast')).toContainText(label);
  await expect(page.getByTestId('load-counter')).toHaveText(counter ?? '');
  // Nothing went into the outbox: offline, the banner counts the queue — 0.
  await expect(page.getByTestId('sync-banner')).toContainText('📴');
  await expect(page.getByTestId('sync-banner')).toContainText(/\b0\b/);
  await page.context().setOffline(false);
});

test('over the plan asks for a reason, then loads with the ⚠ mark; finish and depart carry four', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto(`${batchUrl}#count-load`);
  await expect(ourRow(page)).toBeVisible({ timeout: 15_000 });
  await ourRow(page).getByTestId('count-load-input').fill('4');
  await expect(ourRow(page).getByTestId('count-load-reason')).toBeVisible();
  await ourRow(page).getByTestId('count-load-save').click();
  await expect(ourRow(page).getByTestId('count-load-error')).toBeVisible();
  // The refusal kept what was typed (#377): only the reason is added.
  await expect(ourRow(page).getByTestId('count-load-input')).toHaveValue('4');
  await ourRow(page).getByTestId('count-load-reason').fill('zavod 1 ta ortiq berdi');
  await ourRow(page).getByTestId('count-load-save').click();
  await expect(ourRow(page).getByTestId('count-load-result')).toContainText('4');
  await page.reload();
  // The header's ⚠ chip: one carton beyond the plan, the one on the truck.
  await expect(page.getByText(/^\+1 /).first()).toBeVisible();

  await page.getByTestId('finish-loading').click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('depart-batch').click();
  await expect(page.getByText(/🚀/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('batch-contents-total')).toContainText('4 📦');
});
