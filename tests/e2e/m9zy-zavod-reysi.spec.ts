import { expect, test } from '@playwright/test';

/**
 * «Zavod reysi» in the browser (0100).
 *
 * The money, the one-press «olindi», the receive door's in-transaction check
 * and the notices are proven in `tests/integration/pickup.integration.test.ts`.
 * What only a browser can show: the factory directory takes a pasted point,
 * a trip is written from one form with its lines, «Olindi» is pressed on the
 * card, and the warehouse sees the truck on /receive and opens the wizard
 * PRE-FILLED — goods in, count left empty, the factory's number beside it.
 *
 * The trip is CANCELLED and the factory deactivated in a final TEST: a live
 * trip sits on every later /receive screen of its destination, and a factory
 * is configuration (#183).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const STAMP = Date.now().toString().slice(-6);
const FACTORY = `E2E zavod ${STAMP}`;
const GOODS = `Oyinchoq ${STAMP}`;

test.describe.configure({ mode: 'serial' });

let pickupUrl = '';

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const factoryRow = (page: import('@playwright/test').Page) =>
  page.getByTestId('factory-row').filter({ hasText: FACTORY });

test('a factory is saved, and a pasted Chinese-map point is placed and confirmed', async ({ page }) => {
  await login(page);
  await page.goto('/zavod/zavodlar');
  const create = page.locator('details').filter({ has: page.getByTestId('factory-form') }).first();
  if (!(await create.evaluate((el) => (el as HTMLDetailsElement).open))) await create.locator('summary').click();
  const form = create.getByTestId('factory-form');
  await form.getByTestId('factory-name').fill(FACTORY);
  await form.getByTestId('factory-address').fill('浙江省义乌市福田路1号');
  await form.getByTestId('factory-save').click();
  // No geocoder is called from a test server (GEO_NETWORK=off): the save
  // says so in words instead of pretending it found the gate.
  await expect(form.getByTestId('factory-msg')).toContainText('⚠');
  await expect(factoryRow(page)).toBeVisible();

  const row = factoryRow(page);
  await row.locator('summary').click();
  await row.getByTestId('factory-point-text').fill('29.3060, 120.0750');
  await row.getByTestId('factory-point-save').click();
  await expect(row.getByTestId('factory-point-state')).toContainText(/✓|провер|tekshir|confirm|已确认/i, {
    timeout: 10_000,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('a trip is written from one form, and «Olindi» is one press on the card', async ({ page }) => {
  await login(page);
  await page.goto('/zavod/yangi');
  const stop = page.getByTestId('pickup-stop-form').first();
  await stop.getByTestId('stop-factory').selectOption({ label: FACTORY });
  const line = stop.getByTestId('pickup-line').first();
  await line.getByTestId('line-owner').fill('GS777');
  await line.getByTestId('line-goods').fill(GOODS);
  await line.getByTestId('line-boxes').fill('5');
  await line.getByTestId('line-m3').fill('1,5');
  await page.getByTestId('pickup-plate').fill(`E2E${STAMP}`);
  await page.getByTestId('pickup-create').click();
  await expect(page).toHaveURL(/\/zavod\/[0-9a-f-]{36}$/);
  pickupUrl = page.url();

  const card = page.getByTestId('pickup-stop').first();
  await expect(card.getByTestId('stop-line')).toContainText(GOODS);
  await card.getByTestId('collect-driver-count').first().fill('4');
  await card.getByTestId('collect-submit').click();
  await expect(card.getByTestId('stop-collected')).toBeVisible();
  await expect(card.getByTestId('collect-form')).toHaveCount(0);
  await expect(card.getByTestId('stop-line')).toContainText('4');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('the warehouse sees the truck on /receive and the wizard opens pre-filled, count left to recount', async ({ page }) => {
  expect(pickupUrl, 'the trip from the previous test').not.toBe('');
  await login(page);
  await page.goto('/receive');
  const incoming = page.getByTestId('incoming-pickups');
  await expect(incoming).toBeVisible();
  if (!(await incoming.evaluate((el) => (el as HTMLDetailsElement).open))) await incoming.locator('summary').click();
  const truck = incoming.getByTestId('incoming-truck').filter({ hasText: GOODS });
  await truck.getByTestId('incoming-receive').first().click();
  await expect(page).toHaveURL(/pickup=/);
  await expect(page.getByTestId('receive-pickup')).toContainText(FACTORY);
  // Goods in, the count EMPTY, the factory's and the driver's numbers beside it.
  await expect(page.getByTestId('lot-count-hint').first()).toContainText('5');
  await expect(page.getByTestId('lot-count-hint').first()).toContainText('4');
  await expect(page.getByTestId('lot-count').first()).toHaveValue('');
});

test('cleanup: the trip is cancelled and leaves /receive; the factory is deactivated', async ({ page }) => {
  expect(pickupUrl).not.toBe('');
  await login(page);
  await page.goto(pickupUrl);
  page.once('dialog', (dialog) => dialog.accept('e2e cleanup'));
  await page.getByTestId('pickup-cancel').click();
  await expect(page.getByTestId('pickup-cancel')).toHaveCount(0);

  await page.goto('/receive');
  await expect(page.getByTestId('incoming-truck').filter({ hasText: GOODS })).toHaveCount(0);

  await page.goto('/zavod/zavodlar');
  const row = factoryRow(page);
  await row.locator('summary').click();
  await row.getByRole('button', { name: /faolsiz|деактив|deactivate|停用/i }).click();
  await expect(row).toHaveClass(/opacity-60/);
});
