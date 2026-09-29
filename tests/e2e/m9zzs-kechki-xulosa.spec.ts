import { expect, test, type Page } from '@playwright/test';

/**
 * The evening summary's switch on /profile (the owner's 7a): drawn for the
 * person who receives the message and for nobody else. This also proves the
 * render-time key (`kechkiXulosa.notifMuteOwner`) exists in the bundle the
 * page renders with — a missing key throws at RENDER (#163), which no unit
 * test of the bundles can see.
 *
 * Nothing is saved: the spec only reads the page, so it leaves no mute list
 * behind for the next spec (#183).
 */

const PASSWORD = 'demo1234';
const OWNER = '+998900000001';
const SELLER = '+998900000009';
const ADMIN = '+998900000002';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('the owner sees the evening summary’s own switch, inside a 360 px page', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, OWNER);
  await page.goto('/profile');
  const box = page.getByTestId('profile-mute-owner');
  await expect(box).toBeVisible();
  await expect(page.locator('label', { has: box })).toContainText('20:00');
  // No spec links the demo owner's Telegram (the seed does not either), so the
  // page must say the summary goes nowhere — the drain would mute it silently.
  await expect(page.getByTestId('profile-owner-unlinked')).toBeVisible();
  // The switch must not widen the page (a row wider than the phone rescales it, #400).
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
});

test('a seller and an admin are never offered it — «faqat sizga»', async ({ page }) => {
  for (const phone of [SELLER, ADMIN]) {
    await login(page, phone);
    await page.goto('/profile');
    await expect(page.locator('form').filter({ has: page.locator('input[name="mute_all"]') })).toBeVisible();
    await expect(page.getByTestId('profile-mute-owner')).toHaveCount(0);
    await expect(page.getByTestId('profile-owner-unlinked')).toHaveCount(0);
  }
});
