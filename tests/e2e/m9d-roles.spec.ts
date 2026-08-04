import { expect, test } from '@playwright/test';

/**
 * The role constructor: who can do what, edited as data.
 *
 * Everything here happens on a role this file invents and then deletes, so it
 * cannot change what the other specs are allowed to do — this suite runs one
 * worker over one database in file order, and stripping a permission off
 * `warehouse_operator` here would break receiving three files earlier on the
 * next run.
 */

const OWNER = '+998900000001';
const YW_MANAGER = '+998900000005';
const PASSWORD = 'demo1234';
const ROLE = 'e2e_dispatcher';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('the owner invents a role, grants it a permission and takes it away again', async ({
  page,
}) => {
  await login(page, OWNER);
  await page.goto('/admin/roles');

  await page.getByTestId('new-role-panel').click();
  await page.getByTestId('role-code').fill(ROLE);
  await page.getByTestId('role-name').fill('E2E dispecher');
  await page.getByTestId('save-role').click();

  const card = page.getByTestId(`role-${ROLE}`);
  await expect(card).toBeVisible();
  // A new role starts with nothing — it cannot be a back door.
  await expect(page.getByTestId(`grants-${ROLE}`)).toContainText('0');

  await page.getByTestId(`toggle-${ROLE}`).click();
  await card.locator('input[name="grant"][value="receipts.create"]').check();
  await page.getByTestId(`save-${ROLE}`).click();
  // Wait for the action to answer before navigating — reloading mid-flight
  // aborts the request and the assertion below would be measuring nothing.
  await expect(page.getByTestId(`save-${ROLE}`)).toHaveText('✅');

  // Reload rather than trust the optimistic tick: the point is that the grant
  // reached the database.
  await page.reload();
  await expect(page.getByTestId(`grants-${ROLE}`)).toContainText('1');

  // A role the owner can hand out — the whole reason the screen exists. Before
  // this, the user form read a hard-coded list and a new role was unassignable.
  await page.goto('/admin/users/new');
  await expect(page.locator('input[name="roleCodes"][value="' + ROLE + '"]')).toHaveCount(1);

  await page.goto('/admin/roles');
  await page.getByTestId(`toggle-${ROLE}`).click();
  await page.getByTestId(`delete-${ROLE}`).click();
  await expect(page.getByTestId(`role-${ROLE}`)).toHaveCount(0);
});

test('nobody edits the powers of the role they hold', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/admin/roles');

  await page.getByTestId('toggle-super_admin').click();
  const card = page.getByTestId('role-super_admin');
  // Said before the click, not after a refused save.
  await expect(card.getByRole('paragraph').filter({ hasText: '⚠️' })).toBeVisible();
  await expect(page.getByTestId('save-super_admin')).toBeDisabled();
  await expect(card.locator('input[name="grant"]:not([type="hidden"])').first()).toBeDisabled();
});

test('a warehouse manager never reaches the permissions screen', async ({ page }) => {
  await login(page, YW_MANAGER);
  await page.goto('/admin/roles');
  await expect(page).toHaveURL('/');
});
