import { expect, test, type Page } from '@playwright/test';

/**
 * The truck card at 1280 px (docs/CARD-TABS.md): the header's tiles are
 * drawn, a tab link keeps the whole header in view — the `#tabs` anchor
 * scrolls the strip under the app bar on a phone and must NOT on a desktop,
 * where the header is the summary a person came for (`lg:scroll-mt-[60rem]`
 * clamps the scroll to the top) — and one element on the page says
 * «current page»: the card's tab. The menus around it say «true», never a
 * second «page».
 *
 * A quick truck out of YW, cancelled at the end (#154).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);
let batchPath = '';

async function login(page: Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('the header, the tiles and a tab link that keeps the header in view', async ({ page }) => {
  await login(page);
  await page.goto('/batches');
  await page.selectOption('select[name="originId"]', { label: 'YW' });
  await page.selectOption('select[name="destId"]', { label: 'TAS1' });
  await page.getByTestId('create-quick-batch').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
  batchPath = new URL(page.url()).pathname;

  await expect(page.getByTestId('batch-tiles')).toBeVisible();
  await expect(page.getByTestId('batch-tile-cargo')).toBeVisible();
  await expect(page.getByTestId('batch-tile-clients')).toBeVisible();

  await page.getByTestId('batch-tab-mashina').click();
  await expect(page).toHaveURL(new RegExp(`${batchPath}/mashina#tabs$`));
  await expect(page.getByTestId('batch-tab-mashina')).toHaveAttribute('aria-current', 'page');
  // Scrolled to the strip on a phone; on a desktop the header stays in view.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const head = (await page.getByTestId('batch-head').boundingBox())!;
  expect(head.y).toBeGreaterThanOrEqual(0);

  // One «current page» on the page — the card's tab.
  await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
});

test('cleanup: the truck is cancelled', async ({ page }) => {
  expect(batchPath).toMatch(/^\/batches\//);
  await login(page);
  await page.goto(batchPath);
  await page.getByTestId('cancel-batch').click();
  await page.locator('#cancel-reason').fill(`karta desktop ${runId}`);
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('cancel-batch-confirm').click();
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0, { timeout: 15_000 });
});
