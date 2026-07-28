import { expect, test } from '@playwright/test';

/**
 * The conversations screen — phase 2 of the client chat in the CRM.
 *
 * Runs after everything else and creates NOTHING: it reads whatever the
 * integration suite left in `tg_messages` earlier in the same CI run, so it
 * cannot change what any other spec renders (#154, #183).
 *
 * What only an e2e can prove: that the screen is reachable, that a row leads
 * to its thread, and — the part that matters — that reading what a client
 * told us in confidence is behind a permission.
 */

const OWNER = '+998900000001';
const OPERATOR = '+998900000006';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('the conversation list opens and leads into a thread', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar');
  await expect(page).toHaveURL(/\/suhbatlar$/);

  const rows = page.getByTestId('conversation-row');
  // The integration suite writes conversations earlier in the same run. If it
  // ever stops, this asserts the empty state instead of quietly passing on an
  // empty page — a screen that shows nothing must say so.
  if ((await rows.count()) === 0) {
    await expect(page.getByTestId('conversations-empty')).toBeVisible();
    return;
  }

  await rows.first().click();
  await expect(page).toHaveURL(/\/suhbatlar\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('conversation-thread')).toBeVisible();
  // Read-only in this phase, and the screen must not pretend otherwise.
  await expect(page.locator('textarea')).toHaveCount(0);
});

test('search narrows the list, and a miss says so', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar?q=zzz-no-such-client-zzz');
  await expect(page.getByTestId('conversations-empty')).toBeVisible();
  await expect(page.getByTestId('conversation-row')).toHaveCount(0);
});

test('a warehouse operator cannot read what clients told sales', async ({ page }) => {
  // Not clutter-hiding — a real gate. These are conversations customers had in
  // confidence with their manager, and the page carries its own check rather
  // than trusting the menu to keep anybody out (#198).
  await login(page, OPERATOR);
  await page.goto('/suhbatlar');
  await expect(page).toHaveURL('/');
});
