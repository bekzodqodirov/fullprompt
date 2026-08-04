import { expect, test } from '@playwright/test';

/**
 * Saved views, columns and sorting on a real list.
 *
 * The rules are proven in unit and integration tests; what only a browser can
 * show is that the three controls compose — a filter typed into the list's own
 * GET form, a column turned off in the picker and a sort click all end up in
 * ONE address bar, and saving that address under a name brings the whole state
 * back with one press.
 *
 * Every view it creates is deleted at the end. A saved view is CONFIGURATION
 * (#183): left behind on the owner's account, the next spec that opens
 * /admin/clients bare would be redirected into somebody else's filter.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const NAME = `E2E view ${String(Date.now()).slice(-6)}`;

test.beforeEach(async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
});

test('a filter, a hidden column and a sort save together as one view', async ({ page }) => {
  await page.goto('/admin/clients?q=GS7');
  await expect(page.getByTestId('clients-table')).toBeVisible();
  const before = await page.locator('tbody tr').count();
  expect(before).toBeGreaterThan(0);

  // The manager column is on by default…
  const manager = page.getByRole('columnheader', { name: /Менеджер|Manager|Sotuv|经理/ });
  await expect(manager).toBeVisible();

  // …and the picker turns it off, which lands in the URL.
  await page.getByTestId('column-picker').locator('summary').click();
  await page.getByTestId('col-manager').click();
  await expect(page).toHaveURL(/cols=/);
  await expect(manager).toHaveCount(0);
  // The filter survived the column change — one address bar, not two states.
  await expect(page).toHaveURL(/q=GS7/);

  // Sorting composes with both.
  await page.locator('thead th a').first().click();
  await expect(page).toHaveURL(/sort=code/);
  await expect(page).toHaveURL(/q=GS7/);
  await expect(page).toHaveURL(/cols=/);

  // Save the lot under a name.
  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-name').fill(NAME);
  await page.getByTestId('view-save').click();
  await expect(page.getByTestId('view-chip').filter({ hasText: NAME })).toBeVisible();

  // Leave, come back bare, and press the chip: the whole state returns.
  await page.goto('/admin/clients');
  await expect(page).toHaveURL('/admin/clients');
  await expect(manager).toBeVisible();

  await page.getByTestId('view-chip').filter({ hasText: NAME }).click();
  await expect(page).toHaveURL(/q=GS7/);
  await expect(page).toHaveURL(/sort=code/);
  await expect(manager).toHaveCount(0);
  await expect(page.locator('tbody tr')).toHaveCount(before);
});

test('the export link carries the view, not the whole table', async ({ page }) => {
  await page.goto('/admin/clients?q=GS7&cols=code,name&sort=name&dir=asc');
  const href = await page.getByTestId('clients-xlsx').getAttribute('href');
  expect(href).toContain('q=GS7');
  expect(href).toContain('cols=code%2Cname');
  expect(href).toContain('sort=name');
});

/**
 * The cleanup is a TEST, not an afterAll hook.
 *
 * `browser.newPage()` in a hook opens a context that does not carry the
 * project's baseURL or its logged-in state, so the tidy-up silently did
 * nothing and the view it left behind redirected the next spec that opened
 * this list. A last test runs with the same fixtures as the others.
 */
test('the view it created is removed again', async ({ page }) => {
  await page.goto('/admin/clients');
  await page.getByTestId('view-menu').click();
  const row = page.locator('li').filter({ hasText: NAME });
  if (await row.count()) await row.getByTestId('view-delete').click();
  await expect(page.getByTestId('view-chip').filter({ hasText: NAME })).toHaveCount(0);
});
