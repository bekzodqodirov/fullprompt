import { expect, test } from '@playwright/test';

/**
 * The collapsible sidebar (owner, 2026-07-28: "sidemenu collapsable bo'lishi
 * kerak"). Desktop project: the sidebar does not exist on a phone.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';

test('the sidebar folds to an icon rail and remembers the choice', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar.locator('.section-title').first()).toBeVisible();

  // Fold: labels and group titles go, icons stay, links still work.
  await page.getByTestId('sidebar-toggle').click();
  await expect(sidebar.locator('.section-title')).toHaveCount(0);
  await sidebar.locator('a[href="/stock"]').click();
  await expect(page).toHaveURL('/stock');

  // The choice survives a full reload — it lives in the browser, per person.
  await page.reload();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('sidebar').locator('.section-title')).toHaveCount(0);

  // …and unfolds again.
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar').locator('.section-title').first()).toBeVisible();
});
