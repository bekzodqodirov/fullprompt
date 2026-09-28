import { expect, test, type Page } from '@playwright/test';

/**
 * B9 at 1280×900: the error list and the backup panel's disk lines as the
 * owner sees them on a desktop. Reads only — nothing to leave behind.
 */

const PASSWORD = 'demo1234';
const OWNER = '+998900000001';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('the error list and the disk lines at desktop width', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/admin/xatolar?davr=30');
  await expect(page.getByTestId('system-errors')).toBeVisible();
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(w.doc).toBeLessThanOrEqual(w.view);
  await page.screenshot({ path: 'test-results/kuzatuv-xatolar-1280.png', fullPage: true });

  // The disk lines ride on the backup panel — a reading or «noma'lum», never a blank.
  await page.goto('/admin');
  const disks = page.getByTestId('disk-lines');
  await expect(disks).toBeVisible();
  await expect(disks.locator('dd').first()).not.toBeEmpty();
  await page.screenshot({ path: 'test-results/kuzatuv-admin-1280.png', fullPage: true });
});
