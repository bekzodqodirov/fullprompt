import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Jamoa guruhi (0134) on the phone: the owner's panel and every colleague's
 * rating screen render in all their parts at 360 px, and the doors are where
 * they should be. No Telegram here (CI has no token and this container no
 * network) — the bot half is integration-proven (staff-group.integration).
 *
 *  1. the owner: the hub door, the panel's four sections with no group
 *     connected, the team goal saved and read back;
 *  2. a seller: the profile's door to /reyting, the three blocks, and no way
 *     into the panel;
 *  3. cleanup, a final TEST: the goal put back as it was (a setting is
 *     CONFIGURATION — the next spec's rating reads it, #183).
 */

const OWNER = '+998900000001';
const SELLER = '+998900000009';
const DEMO_PASSWORD = 'demo1234';

test.describe.configure({ mode: 'serial' });

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to restore this spec’s setting');
  return postgres(url, { max: 1, onnotice: () => {} });
}

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function fitsTheScreen(page: Page) {
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  const viewport = await page.evaluate(() => document.documentElement.clientWidth);
  expect(width).toBeLessThanOrEqual(viewport);
}

let goalBefore: unknown = undefined;

test('the owner: the hub door and the panel, no group connected', async ({ page }) => {
  const sql = database();
  try {
    const [row] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'staff_rating_goal_m3'`;
    goalBefore = row ? row.value : null;
  } finally {
    await sql.end();
  }
  await login(page, OWNER);
  await page.goto('/admin');
  await expect(page.locator('a[href="/admin/jamoa-guruhi"]').first()).toBeVisible();
  await page.goto('/admin/jamoa-guruhi');
  await expect(page.getByTestId('staff-group-status')).toBeVisible();
  await expect(page.getByTestId('staff-group-not-connected')).toBeVisible();
  await expect(page.getByTestId('staff-group-media')).toBeVisible();
  await expect(page.getByTestId('staff-group-upload-label')).toBeVisible();
  await expect(page.getByTestId('staff-group-posts')).toBeVisible();
  await fitsTheScreen(page);

  await page.getByTestId('staff-group-goal').fill('40');
  await page.getByTestId('staff-group-goal-save').click();
  await expect(page.getByTestId('staff-group-goal-section').getByRole('status')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('staff-group-goal')).toHaveValue('40');
});

test('a seller: the profile door, the three blocks, and the goal line', async ({ page }) => {
  await login(page, SELLER);
  await page.goto('/profile');
  await page.getByTestId('profile-rating').click();
  await expect(page).toHaveURL('/reyting');
  await expect(page.getByTestId('rating-running')).toBeVisible();
  await expect(page.getByTestId('rating-closed')).toBeVisible();
  await expect(page.getByTestId('rating-month')).toBeVisible();
  await expect(page.getByTestId('rating-running-goal')).toContainText('40');
  await fitsTheScreen(page);
});

test('a seller cannot open the panel', async ({ page }) => {
  await login(page, SELLER);
  await page.goto('/admin/jamoa-guruhi');
  await expect(page).not.toHaveURL(/jamoa-guruhi/);
});

test('cleanup: the goal is put back as it was', async () => {
  const sql = database();
  try {
    if (goalBefore === null) await sql`DELETE FROM settings WHERE key = 'staff_rating_goal_m3'`;
    else if (goalBefore !== undefined) {
      await sql`UPDATE settings SET value = ${sql.json(goalBefore as never)} WHERE key = 'staff_rating_goal_m3'`;
    }
    const [row] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'staff_rating_goal_m3'`;
    expect(row ? row.value : null).toEqual(goalBefore);
  } finally {
    await sql.end();
  }
});
