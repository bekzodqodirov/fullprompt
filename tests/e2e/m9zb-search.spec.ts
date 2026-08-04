import { expect, test } from '@playwright/test';

/**
 * The command palette.
 *
 * What only a browser can show: the icon in the app bar opens a panel instead
 * of leaving the page, typing narrows it live, Enter follows the highlighted
 * row, and the panel does not survive the navigation it caused. The scoping
 * rules underneath are proven in the integration suite, where an actor's
 * warehouses can be set to something the seeded logins do not have.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';

test.beforeEach(async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
});

test('the app bar icon opens the palette and a hit navigates', async ({ page }) => {
  await page.goto('/stock');
  await page.locator('header a[href="/search"]').click();

  // It opened over the page rather than leaving it.
  await expect(page.getByTestId('search-palette')).toBeVisible();
  await expect(page).toHaveURL('/stock');

  await page.getByTestId('palette-input').fill('GS777');
  const hits = page.getByTestId('palette-hit');
  await expect(hits.first()).toBeVisible({ timeout: 10_000 });

  await hits.first().click();
  // Wherever the first hit points, the panel is gone and the page moved.
  await expect(page.getByTestId('search-palette')).toHaveCount(0);
  await expect(page).not.toHaveURL('/stock');
});

test('a query too short to mean anything asks for nothing', async ({ page }) => {
  await page.goto('/stock');
  await page.locator('header a[href="/search"]').click();
  // Assert the panel is OPEN before asserting emptiness: this test passed
  // once while the icon was still navigating away and the palette never
  // appeared at all — zero hits for the wrong reason is not a proof.
  await expect(page.getByTestId('search-palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('G');
  await expect(page.getByTestId('palette-hit')).toHaveCount(0);
  await expect(page.getByTestId('palette-input')).toHaveValue('G');
});

test('the search page still works with the same answers', async ({ page }) => {
  // The palette is an overlay ON a page that must keep working — this is the
  // no-JavaScript door, and the export of the whole feature's honesty.
  await page.goto('/search?q=GS777');
  await expect(page.getByTestId('search-hit').first()).toBeVisible();
});
