import { expect, test, type Page } from '@playwright/test';

/**
 * «Hodimlar» and «Bu oy» (0117), opened by the people they are for — and
 * refused to the people they are not. READ-ONLY on purpose: a KPI table
 * version, a category, a salary template or a payout is CONFIGURATION that
 * every later spec would inherit (#183), so this spec saves none of them and
 * leaves the database exactly as it found it. Assertions are testids and
 * words, never digits: the figures belong to whatever the suite left before.
 */

const PASSWORD = 'demo1234';
const OWNER = '+998900000001';
const VED = '+998900000004';
const SELLER = '+998900000009';
const ACCOUNTANT = '+998900000010';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** The page must fit its viewport — a wider document makes a phone zoom the whole page out (#400). */
async function fitsViewport(page: Page) {
  const { doc, view } = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(doc).toBeLessThanOrEqual(view);
}

for (const size of [
  { width: 360, height: 800 },
  { width: 1280, height: 900 },
]) {
  test(`the owner reads every person's pay and the KPI table at ${size.width}px`, async ({ page }) => {
    await page.setViewportSize(size);
    await login(page, OWNER);
    await page.goto('/hodimlar');
    await expect(page).toHaveURL(/\/hodimlar/);
    await expect(page.getByTestId('hodimlar-month')).toBeVisible();
    await expect(page.getByTestId('hodimlar-table')).toBeVisible();
    // Either people with pay, or the empty sentence — never a blank page.
    await expect(page.getByTestId('hodimlar-list').or(page.getByTestId('hodimlar-empty')).first()).toBeVisible();
    // The two category pickers are the settings power's — the owner has it.
    await expect(page.getByTestId('staff-category-kpi_expense_category_id')).toBeVisible();
    await fitsViewport(page);
  });
}

test('the accountant opens /hodimlar; the tab sits in the money workspace', async ({ page }) => {
  await login(page, ACCOUNTANT);
  await page.goto('/hodimlar');
  await expect(page).toHaveURL(/\/hodimlar/);
  await expect(page.getByTestId('hodimlar-month')).toBeVisible();
  await expect(page.getByTestId('ws-tabs').locator('a[href="/hodimlar"]').first()).toBeAttached();
});

test('a seller reads his own month on the profile, and /hodimlar is not his', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, SELLER);
  await page.goto('/profile');
  await expect(page.getByTestId('profile-month')).toBeVisible();
  await expect(page.getByTestId('profile-month-work')).toBeVisible();
  await expect(page.getByTestId('profile-month-income')).toBeVisible();
  await fitsViewport(page);
  await page.goto('/hodimlar');
  await expect(page).toHaveURL('/');
});

test('the VED sees no upsale anywhere and no /hodimlar', async ({ page }) => {
  await login(page, VED);
  await page.goto('/profile');
  await expect(page.getByTestId('profile-month')).toBeVisible();
  await expect(page.getByTestId('profile-month-upsale')).toHaveCount(0);
  await page.goto('/hodimlar');
  await expect(page).toHaveURL('/');
  await page.goto('/upsale');
  await expect(page).toHaveURL('/');
});
