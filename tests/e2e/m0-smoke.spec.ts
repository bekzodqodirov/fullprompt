import { expect, test } from '@playwright/test';

/**
 * M0 demo flow (docs/PLAN.md): log in as admin → create a warehouse → create
 * a client → verify both appear → verify the audit browser recorded it all.
 * Runs against a seeded database.
 */

const ADMIN_PHONE = '+998900000001';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);

test('login rejects a wrong password', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/телефон|telefon|电话/i).fill(ADMIN_PHONE);
  await page.locator('input[name="password"]').fill('wrong-password');
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('admin creates warehouse + client, sees them in audit', async ({ page }) => {
  // Login
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(ADMIN_PHONE);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // No horizontal scroll at 360px (spec §15)
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(360);

  // The admin nav belongs to the admin section, not to every screen — an
  // admin used to meet "warehouses / clients / employees" on the home page.
  // (The app's own tab bar is a <nav> too, hence the section-specific id.)
  await expect(page.getByTestId('sub-nav')).toHaveCount(0);
  await page.goto('/admin/warehouses');
  await expect(page.getByTestId('sub-nav')).toHaveCount(1);

  // Create a warehouse
  await page.goto('/admin/warehouses/new');
  await page.locator('input[name="code"]').fill(`T${runId}`);
  await page.locator('input[name="batchPrefix"]').fill(`T${runId}`);
  await page.locator('input[name="name"]').fill(`Test WH ${runId}`);
  await page.locator('select[name="country"]').selectOption('UZ');
  await page.locator('select[name="type"]').selectOption('distribution');
  await page.locator('select[name="timezone"]').selectOption('Asia/Tashkent');
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/admin/warehouses');
  await expect(page.getByText(`Test WH ${runId}`)).toBeVisible();

  // Create a client bound to the seeded sales manager
  await page.goto('/admin/clients/new');
  await page.locator('input[name="clientCode"]').fill(`GS9${runId}`);
  await page.locator('input[name="name"]').fill(`Test Client ${runId}`);
  await page.locator('select[name="salesManagerId"]').selectOption({ label: 'Dilnoza (Sales)' });
  await page.locator('main form button[type="submit"]').first().click();
  // Saving lands on the new client CARD so the assigned code is visible
  // (owner: the list hid what code the system gave).
  await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]{36}$/);
  await expect(page.getByText(`Test Client ${runId}`)).toBeVisible();
  await expect(page.getByText(`GS9${runId}`)).toBeVisible();

  // Client code format validation rejects a malformed code (too short)
  await page.goto('/admin/clients/new');
  await page.locator('input[name="clientCode"]').fill('X');
  await page.locator('input[name="name"]').fill('Bad Code');
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page.getByRole('alert')).toBeVisible();

  // Audit browser shows the creations
  await page.goto('/admin/audit');
  await expect(page.getByText('warehouse').first()).toBeVisible();
  await expect(page.getByText('client').first()).toBeVisible();
});

test('warehouse-scoped operator sees no admin nav', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill('+998900000006');
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
  await expect(page.getByTestId('sub-nav')).toHaveCount(0);
  // Direct admin URL bounces back home (server-side gate)
  await page.goto('/admin/warehouses');
  await expect(page).toHaveURL('/');
});
