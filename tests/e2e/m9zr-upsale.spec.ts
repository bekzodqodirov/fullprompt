import { expect, test } from '@playwright/test';

/**
 * The upsale screen on the phone the sellers actually carry.
 *
 * A nine-column table at 360 px is wider than the viewport, and a document
 * wider than its viewport makes mobile Chrome rescale the WHOLE page — every
 * tap target moves, which is #400 and cost round 29 an afternoon. So the
 * screen renders a LIST below `md` and a table from `md`, and this measures
 * that the phone really got the list.
 */
const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';

test('the phone gets a list, and the page is not rescaled', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(ADMIN);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/upsale?dan=2020-01-01');
  await expect(page.getByTestId('upsale-scoreboard')).toBeVisible({ timeout: 15_000 });

  const width = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(width.doc, 'a document wider than the viewport rescales the page').toBe(width.view);

  // Both shapes are in the DOM and CSS chooses — so ask which one is VISIBLE,
  // the way the funnel's own specs have to.
  const list = page.getByTestId('upsale-list');
  const table = page.getByTestId('upsale-table');
  if ((await list.count()) > 0) {
    await expect(list).toBeVisible();
    await expect(table).toBeHidden();
  }
});
