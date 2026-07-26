import { expect, test } from '@playwright/test';

/**
 * What is coming TO a warehouse, and who hands cargo to a client.
 *
 * Aziz manages YW — a Chinese origin warehouse. He expects cargo from
 * clients, never a client at the counter, so handover must not be offered to
 * him at all; the logist's fleet view answers "which truck got where".
 *
 * Named to sort AFTER the trip specs (m3–m5): the fleet view has nothing to
 * show until something has departed, and this suite runs one worker over one
 * database in file order.
 */

const YW_MANAGER = '+998900000005';
const LOGIST = '+998900000003';
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

test('a warehouse writes down the cargo a client promised, and cancels it', async ({ page }) => {
  await login(page, YW_MANAGER);

  await page.goto('/arrivals');
  const add = page.locator('details').filter({ has: page.getByTestId('save-arrival') });
  await add.locator('summary').click();

  // The client is searched for, not picked from a list of three hundred.
  await page.getByTestId('arrival-client').fill('GS777');
  await page.getByRole('button', { name: /GS777/ }).first().click();
  await page.locator('input[name="boxCount"]').fill('3');
  await page.locator('input[name="note"]').fill(`Sinov yuk ${runId}`);
  await page.getByTestId('save-arrival').click();
  await expect(add.getByText('✅')).toBeVisible({ timeout: 15_000 });

  await page.goto('/arrivals');
  const row = page.getByTestId('expected-row').filter({ hasText: `Sinov yuk ${runId}` });
  await expect(row).toBeVisible();
  await expect(row).toContainText('GS777');

  // Cancelling has to say why — the reason is what stops the list becoming
  // a graveyard of promises nobody remembers the fate of.
  await row.locator('input[name="reason"]').fill('mijoz jo‘natmadi');
  await row.locator('button[title]').last().click();
  await expect(
    page.getByTestId('expected-row').filter({ hasText: `Sinov yuk ${runId}` }),
  ).toHaveCount(0);
});

test('handover is not offered where no client ever collects', async ({ page }) => {
  await login(page, YW_MANAGER);
  // The permission is there; the warehouse setting is not. YW is in China.
  await page.goto('/issue');
  await expect(page).toHaveURL('/issue');
  await expect(page.getByTestId('issue-wh')).toHaveCount(0);
});

test('the logist sees where every truck is, and the presets moved to settings', async ({ page }) => {
  await login(page, LOGIST);

  await page.goto('/trucks');
  await expect(page).toHaveURL('/trucks');
  // Earlier specs put trucks on the road, so this is not an empty page.
  await expect(page.getByTestId('truck-row').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('truck-row').first()).toContainText(/→/);

  // The truck PRESETS are a settings screen now.
  await page.goto('/admin/trucks');
  await expect(page).toHaveURL('/admin/trucks');
  await page.getByTestId('add-truck').click();
  await expect(page.getByTestId('save-truck')).toBeVisible();
});
