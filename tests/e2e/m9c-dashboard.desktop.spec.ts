import { expect, test } from '@playwright/test';

/**
 * The dashboard at a desk: the P&L and the cash flow sit side by side on one
 * scale, the page is exactly the window wide, and a month answers a pointer
 * with its numbers (the one tooltip the page mounts).
 */

test('the two money charts share a row, and a month tells its numbers', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill('+998900000001');
  await page.locator('input[name="password"]').fill('demo1234');
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
  await page.goto('/dashboard');

  const pnl = page.getByTestId('dash-pnl');
  const cash = page.getByTestId('dash-cash');
  await expect(pnl).toBeVisible();
  const [a, b] = [(await pnl.boundingBox())!, (await cash.boundingBox())!];
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  expect(b.x).toBeGreaterThan(a.x + a.width - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

  // The last month's band carries its figures; hovering it shows them.
  const band = page.getByTestId('dash-pnl-chart').locator('button[data-tip]').last();
  await band.hover();
  const tip = page.locator('[role="tooltip"]');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('$');
});
