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

  // Create a warehouse
  await page.goto('/admin/warehouses/new');
  await page.locator('input[name="code"]').fill(`T${runId.slice(0, 3)}`);
  await page.locator('input[name="batchPrefix"]').fill(`T${runId.slice(0, 3)}`);
  await page.locator('input[name="name"]').fill(`Test WH ${runId}`);
  await page.locator('select[name="country"]').selectOption('UZ');
  await page.locator('select[name="type"]').selectOption('distribution');
  await page.locator('select[name="timezone"]').selectOption('Asia/Tashkent');
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/admin/warehouses');
  await expect(page.getByText(`Test WH ${runId}`)).toBeVisible();

  // Create a client bound to the seeded sales manager
  await page.goto('/admin/clients/new');
  await page.locator('input[name="clientCode"]').fill(`GS9${runId.slice(0, 3)}`);
  await page.locator('input[name="name"]').fill(`Test Client ${runId}`);
  await page.locator('select[name="salesManagerId"]').selectOption({ label: 'Dilnoza (Sales)' });
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/admin/clients');
  await expect(page.getByText(`Test Client ${runId}`)).toBeVisible();

  // Client code prefix validation rejects a malformed code
  await page.goto('/admin/clients/new');
  await page.locator('input[name="clientCode"]').fill('XX123');
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
  await expect(page.locator('nav')).toHaveCount(0);
  // Direct admin URL bounces back home (server-side gate)
  await page.goto('/admin/warehouses');
  await expect(page).toHaveURL('/');
});
