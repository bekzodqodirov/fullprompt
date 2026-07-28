import { expect, test } from '@playwright/test';

/**
 * The owner's feedback round, batch 1 (2026-07-28).
 *
 * «Boshqaruv» is a hub of buttons now, not a corridor into the warehouse
 * list; expense types are data he edits himself; and the two sales boards
 * carry doors to each other. Each spec is written against the thing he
 * actually complained about.
 */

const OWNER = '+998900000001';
const YW_OPERATOR = '+998900000006';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('administration opens as a hub of buttons, not the warehouse list', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/admin');
  await expect(page).toHaveURL('/admin');
  // Every section is a button on ONE screen — nothing left to a strip that
  // scrolls off the phone. The owner holds every permission, so all doors.
  const tiles = page.getByTestId('admin-tile');
  expect(await tiles.count()).toBeGreaterThanOrEqual(10);
  await expect(page.locator('a[href="/admin/cost-types"]').first()).toBeVisible();

  // …and the operator still has no way in.
  await login(page, YW_OPERATOR);
  await page.goto('/admin');
  await expect(page).toHaveURL('/');
});

test('the owner adds his own expense type — it was never hard-coded, now it has a door', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/admin/cost-types');
  await page.getByTestId('add-cost-type').click();
  const name = `Perevalka ${runId}`;
  await page.locator('input[name="name"]').fill(name);
  await page.getByTestId('save-cost-type').click();
  await expect(page.getByText(name)).toBeVisible();

  // Hidden types leave the expense forms but keep their history — and hiding
  // OUR row keeps later specs' dropdowns free of test data (#154). The form
  // queries only `active` types, so the chip is the visible proof.
  const row = page.locator('.card').filter({ hasText: name }).first();
  await row.locator('form button[type="submit"]').click();
  await expect(page.locator('.card').filter({ hasText: name }).first()).toHaveClass(/opacity-60/);
});

test('each sales board carries the door to the other', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/crm');
  await page.getByTestId('to-deals').click();
  await expect(page).toHaveURL('/bitimlar');
  await page.getByTestId('to-leads').click();
  await expect(page).toHaveURL('/crm');
});
