import { expect, test } from '@playwright/test';

/**
 * «Telegram ulash» in the browser — round 21.
 *
 * CI has no TELEGRAM_API_ID / TG_SESSION_KEY and no route to Telegram, so
 * what only this spec can prove is the honest part: the screen is reachable
 * by the people whose job it is, refuses the warehouse, and a submit on an
 * unconfigured server says SO in a sentence instead of hanging or lying.
 * The real three-step login is pure-function-proved in
 * telegram-connect.test.ts; the first live connect is watched in docker
 * logs, as every Telegram feature before it was.
 *
 * Creates nothing, leaves nothing (#154): a refused begin writes no row.
 */

const SALES = '+998900000009';
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

test('a sales manager reaches the connect screen from the conversations list', async ({
  page,
}) => {
  await login(page, SALES);
  await page.goto('/suhbatlar');
  await page.getByTestId('connect-link').click();
  await expect(page).toHaveURL(/\/suhbatlar\/ulash$/);
  await expect(page.getByTestId('connect-form')).toBeVisible();

  // An unconfigured server refuses BEFORE anybody types a code — with a
  // sentence, not a spinner (the tg-login lesson, on screen).
  await page.getByTestId('connect-phone').fill('+998901234567');
  await page.getByTestId('connect-submit').click();
  await expect(page.getByTestId('connect-error')).toBeVisible();
});

test('the warehouse does not connect Telegram accounts', async ({ page }) => {
  await login(page, OPERATOR);
  await page.goto('/suhbatlar/ulash');
  await expect(page).toHaveURL('/');
});
