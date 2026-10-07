import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * «Narx kanali» (the owner's F, 2026-10-07) — the panel where the staff's
 * price channel is connected and watched.
 *
 * Configures NOTHING (#183): a connected channel would make every later seal
 * in the suite post, so this spec only reads the empty state — the door on the
 * hub, the setup steps in the active locale, the queue — and the gate.
 */
const ADMIN = '+998900000002';
const SELLER = '+998900000009';
const PASSWORD = 'demo1234';

// Russian is the default locale; the words come from the bundle, so a missing
// key (which would render the key itself) cannot pass.
const ru = JSON.parse(readFileSync('messages/ru.json', 'utf8')) as { priceChannel: Record<string, string> };

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('the admin finds the door and the empty channel’s setup steps', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto('/admin');
  await expect(page.locator('a[data-testid="admin-tile"][href="/admin/narx-kanali"]')).toHaveCount(1);

  await page.goto('/admin/narx-kanali');
  const status = page.getByTestId('price-channel-status');
  await expect(status).toBeVisible();
  await expect(page.getByTestId('price-channel-not-connected')).toHaveText(ru.priceChannel.notConnected!);
  await expect(page.getByTestId('price-channel-setup').locator('li')).toHaveCount(4);
  await expect(page.getByTestId('price-channel-queue')).toBeVisible();
  await expect(page.getByTestId('price-channel-members')).toBeVisible();
  // The configured viewport, never innerWidth (#1241): nothing pushes the page wider.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(360);
});

test('a seller is turned away by the page’s own gate', async ({ page }) => {
  await login(page, SELLER);
  await page.goto('/admin/narx-kanali');
  await expect(page).toHaveURL('/');
});
