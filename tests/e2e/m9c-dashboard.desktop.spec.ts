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

test('at a desk the canvas holds: profit beside its line, four tiles in a row, alerts above the fold', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill('+998900000001');
  await page.locator('input[name="password"]').fill('demo1234');
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
  await page.goto('/dashboard');

  // A card streams in under its own Suspense: React inserts it HIDDEN and
  // swaps it in a moment later, so a box read before it shows is null.
  const box = async (id: string) => {
    await expect(page.getByTestId(id)).toBeVisible();
    return (await page.getByTestId(id).boundingBox())!;
  };
  // The hero's figure and its twelve-month line share one row.
  const value = await box('dash-hero-value');
  const line = await box('dash-hero-line');
  expect(line.x).toBeGreaterThan(value.x + value.width - 1);
  expect(line.y).toBeLessThan(value.y + value.height);
  // Four tiles on one line.
  const ys = await Promise.all(['tile-revenue', 'tile-cost', 'tile-cash', 'tile-receivable'].map(async (id) => (await box(id)).y));
  for (const y of ys) expect(Math.abs(y - ys[0]!)).toBeLessThan(2);
  // The two pictures side by side, and the three cards of the next row.
  const [weeks, days] = [await box('dash-cash-weeks'), await box('dash-intake-days')];
  expect(Math.abs(weeks.y - days.y)).toBeLessThan(2);
  const [fill, trucks, funnel] = [await box('dash-fill'), await box('dash-trucks'), await box('dash-funnel')];
  expect(Math.abs(fill.y - trucks.y)).toBeLessThan(2);
  expect(Math.abs(trucks.y - funnel.y)).toBeLessThan(2);
  // What needs a person is on the first screen, not under the charts.
  expect((await box('dash-alerts')).y).toBeLessThan(900);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);

  // A month of the line answers a pointer with its dollars.
  const band = page.getByTestId('dash-hero-line').locator('button[data-tip]').last();
  await band.hover();
  const tip = page.locator('[role="tooltip"]');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('$');
});
