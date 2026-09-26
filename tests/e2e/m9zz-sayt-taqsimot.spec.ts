import { expect, test } from '@playwright/test';

/**
 * «Saytdan so'rovlar» in the browser (round 113) at 360 px: the admin ticks a
 * seller for a website team and types the Telegram handle they answer on, the
 * panel's «keyingi» line names them, and the website's own question — sent
 * over real HTTP from the website's page — gets that handle back.
 *
 * The ranking, the fences and the tag landing are proven in
 * tests/integration/site-assign.integration.test.ts. What only this spec
 * shows: the panel saves through the real form, a folded person's card still
 * posts, the route answers in the standalone build, and every string renders
 * in the default locale (#163).
 *
 * A team tick is CONFIGURATION (#183): while it stands, every website visitor
 * in the rest of the suite would be sent to this seller. So the last test
 * unticks and clears the handle, and proves it by reading the page back.
 * The offer the route writes is data and stays.
 */

const PASSWORD = 'demo1234';
const ADMIN = '+998900000001';
const SELLER_NAME = 'Dilnoza (Sales)';
const HANDLE = `e2e_sayt_${String(Date.now()).slice(-6)}`;

test.describe.configure({ mode: 'serial' });

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const sellerCard = (page: import('@playwright/test').Page) =>
  page.getByTestId('site-person').filter({ hasText: SELLER_NAME });

async function openSellerCard(page: import('@playwright/test').Page) {
  await page.goto('/admin/taqsimot');
  await expect(page.getByTestId('site-panel')).toBeVisible();
  // Nobody ticked her yet and she has no connected Telegram, so she sits in
  // the fold — which is exactly the case the per-row posting exists for.
  if (!(await sellerCard(page).isVisible())) {
    await page.getByTestId('site-form').locator('details > summary').click();
  }
  await expect(sellerCard(page)).toBeVisible();
}

test('the admin ticks a seller for a website team and the panel names her next', async ({ page }) => {
  await login(page, ADMIN);
  await openSellerCard(page);
  const card = sellerCard(page);
  await card.getByTestId('site-team-cargo').check();
  await card.getByTestId('site-username').fill(`@${HANDLE}`);
  await page.getByTestId('site-save').click();
  await expect(page.getByTestId('site-save')).toContainText('✅');

  await page.reload();
  await expect(sellerCard(page)).toBeVisible(); // ticked → out of the fold
  await expect(sellerCard(page).getByTestId('site-team-cargo')).toBeChecked();
  await expect(sellerCard(page).getByTestId('site-person-status')).toContainText(`@${HANDLE}`);
  await expect(page.getByTestId('site-next')).toContainText(`@${HANDLE}`);

  // A card at 360 px must not widen the page (#400).
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
});

test('the website page asks and gets her handle; another page gets nothing', async ({ page }) => {
  const lead = `GSR-E2E${String(Date.now()).slice(-6)}`;
  const url = `/api/lead/assign?team=cargo&tag=yuk&page=/narxlar/&lang=uz&lead=${lead}`;
  const ours = await page.request.get(url, { headers: { origin: 'https://gsrlogistics.uz' } });
  expect(ours.status()).toBe(200);
  expect(await ours.json()).toEqual({ username: HANDLE });
  expect(ours.headers()['access-control-allow-origin']).toBe('https://gsrlogistics.uz');

  const theirs = await page.request.get(url.replace(lead, `${lead}X`), {
    headers: { origin: 'https://evil.example' },
  });
  expect(await theirs.json()).toEqual({ username: null });
  expect(theirs.headers()['access-control-allow-origin']).toBeUndefined();

  // …and the offer shows on the panel's recent list.
  await login(page, ADMIN);
  await page.goto('/admin/taqsimot');
  await expect(page.getByTestId('site-offers')).toContainText(`@${HANDLE}`);
});

test('cleanup: the tick and the handle come off again', async ({ page }) => {
  await login(page, ADMIN);
  await openSellerCard(page);
  const card = sellerCard(page);
  await card.getByTestId('site-team-cargo').uncheck();
  await card.getByTestId('site-username').fill('');
  await page.getByTestId('site-save').click();
  await expect(page.getByTestId('site-save')).toContainText('✅');

  await openSellerCard(page);
  await expect(sellerCard(page).getByTestId('site-team-cargo')).not.toBeChecked();
  await expect(sellerCard(page).getByTestId('site-username')).toHaveValue('');
  await expect(page.getByTestId('site-next')).not.toContainText(`@${HANDLE}`);
});
