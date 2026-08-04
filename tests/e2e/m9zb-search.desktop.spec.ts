import { expect, test } from '@playwright/test';

/**
 * Ctrl+K, which only a keyboard has.
 *
 * The mobile project emulates touch, so the shortcut belongs here — the same
 * split the composer's Enter-to-send rule uses (round 14).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';

test('a keyboard opens and closes the palette from any page', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/stock');
  // Retried, because the shortcut's listener is attached by an effect: press
  // it in the gap between the server HTML arriving and React hydrating and
  // nothing happens. That is true for a real person too — it is a fraction of
  // a second, not a defect — but a test that pressed once passed alone and
  // failed inside the full suite, where the machine is busier (round 45's
  // late-hydration lesson in a new costume).
  await expect(async () => {
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('search-palette')).toBeVisible({ timeout: 700 });
  }).toPass({ timeout: 15_000 });
  await expect(page).toHaveURL('/stock');

  await page.getByTestId('palette-input').fill('GS777');
  await expect(page.getByTestId('palette-hit').first()).toBeVisible({ timeout: 10_000 });

  // Escape puts it away and leaves the page where it was.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search-palette')).toHaveCount(0);
  await expect(page).toHaveURL('/stock');
});
