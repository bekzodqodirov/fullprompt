import { expect, test } from '@playwright/test';

/**
 * The skladchi's home screen is his work order, not a menu.
 *
 * Owner: "har bir hodim qiladigan ishiga qarab layout tuz" — a warehouse
 * operator opens the app and reads a sequence: receive, what is coming,
 * loading, handover — each step carrying the live number that says whether
 * it needs him NOW. The number is the point, so the spec proves the number
 * moves with the data instead of merely existing.
 *
 * Runs as Wang Lei, whose locale is zh-CN on purpose: everything asserted
 * here is a testid or a digit, which is what keeps the spec honest in all
 * four languages.
 */

const YW_OPERATOR = '+998900000006';
const OWNER = '+998900000001';
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

/** The badge is absent at zero — absence IS the number. */
async function arrivalsCount(page: import('@playwright/test').Page): Promise<number> {
  await page.goto('/');
  await expect(page.getByTestId('flow-arrivals')).toBeVisible();
  const badge = page.getByTestId('flow-arrivals-count');
  if ((await badge.count()) === 0) return 0;
  return Number((await badge.innerText()).trim());
}

test('the warehouse day, in order, with live numbers', async ({ page }) => {
  await login(page, YW_OPERATOR);

  // The sequence: receive on top, then the steps of the day.
  await expect(page.getByTestId('flow-receive')).toBeVisible();
  await expect(page.getByTestId('flow-arrivals')).toBeVisible();
  await expect(page.getByTestId('flow-batches')).toBeVisible();
  await expect(page.getByTestId('flow-issue')).toBeVisible();

  // A promise recorded for HIS warehouse moves HIS number.
  const before = await arrivalsCount(page);
  await page.goto('/arrivals');
  const add = page.locator('details').filter({ has: page.getByTestId('save-arrival') });
  await add.locator('summary').click();
  await page.getByTestId('arrival-client').fill('GS777');
  await page.getByRole('button', { name: /GS777/ }).first().click();
  await page.locator('input[name="note"]').fill(`Flow sinov ${runId}`);
  await page.getByTestId('save-arrival').click();
  await expect(add.getByText('✅')).toBeVisible({ timeout: 15_000 });

  expect(await arrivalsCount(page)).toBe(before + 1);

  // …and cancelling the promise takes the number back down. This is also the
  // cleanup: the next spec inherits this database (#154).
  await page.goto('/arrivals');
  const row = page.getByTestId('expected-row').filter({ hasText: `Flow sinov ${runId}` });
  await row.locator('input[name="reason"]').fill('sinov tugadi');
  await row.locator('button[title]').last().click();
  await expect(
    page.getByTestId('expected-row').filter({ hasText: `Flow sinov ${runId}` }),
  ).toHaveCount(0);
  expect(await arrivalsCount(page)).toBe(before);
});

test('everyone else keeps the tile home', async ({ page }) => {
  // The owner is not warehouse-scoped: his day is not the warehouse day, and
  // drawing him a skladchi screen would be the wrong kind of helpful.
  await login(page, OWNER);
  await expect(page.getByTestId('flow-receive')).toHaveCount(0);
  await expect(page.getByTestId('home-tasks').or(page.locator('main a[href="/bugun"]')).first()).toBeVisible();
});
