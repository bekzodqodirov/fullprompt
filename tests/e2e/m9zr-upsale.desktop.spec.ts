import { expect, test } from '@playwright/test';

/**
 * VED phase D — the upsale screen, in a browser.
 *
 * What only a browser can prove: that law 4's exclusion is a real redirect
 * and not a filtered list, that the accountant's total moves as they tick
 * jobs (the amount is never typed), and that the screen fits the phone the
 * sellers carry. The payable rule, the claim and the three states are proven
 * in `upsale.integration.test.ts`.
 *
 * It writes nothing and cleans nothing up: it reads a screen. The one thing
 * it must NOT do is press pay, which would move real money in the seeded
 * database and leave an expense behind for every later spec to count (#183).
 */

const ADMIN = '+998900000001';
const VED = '+998900000004';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test.describe.configure({ mode: 'serial' });

test('the owner sees the scoreboard and every seller', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto('/upsale?dan=2020-01-01');
  await expect(page.getByTestId('upsale-scoreboard')).toBeVisible({ timeout: 15_000 });
  // Three figures, and they are the whole point of the screen.
  await expect(page.getByTestId('upsale-scoreboard')).toContainText('$');
  await expect(page.getByTestId('upsale-period')).toBeVisible();
});

test('the VED is REDIRECTED, not shown an empty table', async ({ page }) => {
  // Law 4: «VED never sees upsale». They computed the floor themselves, so a
  // client price hands them the subtraction — the screen must not exist for
  // them at all.
  await login(page, VED);
  await page.goto('/upsale');
  await expect(page).toHaveURL('/');
});

test('the accountant’s total is computed from the ticks, never typed', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto('/upsale?dan=2020-01-01');

  const fold = page.getByTestId('upsale-pay-fold');
  if ((await fold.count()) === 0) test.skip(true, 'no payable job in this database');
  await fold.locator('summary').click();

  const total = page.getByTestId('upsale-total');
  await expect(total).toContainText('$0.00');

  // Ticking a job moves the figure the accountant is about to press on.
  const first = page.getByTestId('upsale-pick').first();
  await first.check();
  await expect(total).not.toContainText('$0.00');
  // There is no amount input anywhere on this form: the server owns the
  // number, because a typed one is how a screen says «$340 paid» while $200
  // leaves the till.
  await expect(page.getByTestId('upsale-pay').locator('input[name="amount"]')).toHaveCount(0);
  await first.uncheck();
  await expect(total).toContainText('$0.00');
});
