import { expect, test } from '@playwright/test';

/**
 * «Reklama lidi sotuvchiga darhol yetib borsin» (0113), where a browser is
 * the only witness: the sellers table on /crm/tahlil carries its new column
 * with the header that explains it, and the page still fits a phone; the
 * profile offers the new mute group WITH its warning.
 *
 * Everything the column and the pushes decide is proven in the integration
 * suite (inbound-contact*.integration.test.ts); the Telegram halves need a
 * bot and are watched in production's logs. Nothing is saved here — a mute
 * ticked by a spec is configuration every later spec's owner inherits (#183).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';

test.describe.configure({ mode: 'serial' });

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('the sellers table says how fast each seller reached their advert leads', async ({ page }) => {
  await login(page);
  await page.goto('/crm/tahlil');
  const header = page.getByTestId('seller-first-contact');
  await expect(header).toBeVisible();
  // The legend is IN the header, not a tooltip (#420).
  await expect(header).toContainText('n');
  // The wider table scrolls inside its own box; the page does not grow (#400).
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'the page grew sideways').toBeLessThanOrEqual(360);
});

test('the profile offers the new-lead mute, and says what it costs', async ({ page }) => {
  await login(page);
  await page.goto('/profile');
  const box = page.locator('input[name="mute_leads"]');
  await expect(box).toBeAttached();
  // The warning sits under the box it belongs to.
  const label = page.locator('label').filter({ has: box });
  await expect(label.locator('span span')).not.toBeEmpty();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'the page grew sideways').toBeLessThanOrEqual(360);
});
