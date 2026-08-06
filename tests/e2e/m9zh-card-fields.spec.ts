import { expect, test } from '@playwright/test';

/**
 * Choosing what a board card says.
 *
 * The rules are proven in the unit suite. What only a browser can show is that
 * the choice SURVIVES — it lives in a cookie read on the server, so the test
 * that matters is a reload: the card has to come back the way it was left,
 * with no flash of the old one and nothing rearranging after hydration.
 *
 * It puts the card back at the end. The choice is per BROWSER and Playwright
 * clears cookies at each `login()`, so it cannot leak into another spec — but
 * the cleanup is a test rather than a promise (round 57).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const board = (page: import('@playwright/test').Page) => page.getByTestId('funnel-mobile');

test('a line taken off the card stays off after a reload', async ({ page }) => {
  await login(page);
  await page.goto('/crm?scope=all');

  // A card that has an owner line today — the default set includes it.
  const card = board(page).getByTestId('lead-card').first();
  await expect(card).toBeVisible();
  const before = await card.innerText();

  await page.getByTestId('board-menu').click();
  await page.getByTestId('card-fields-open').click();
  await expect(page.getByTestId('card-field-owner')).toBeChecked();
  await page.getByTestId('card-field-owner').uncheck();
  await page.getByTestId('card-fields-save').click();

  // Gone, and gone again on a fresh load — which is the whole point of it
  // being a cookie the SERVER reads rather than something the browser applies
  // after the page has already drawn.
  await expect
    .poll(async () => (await board(page).getByTestId('lead-card').first().innerText()).length, {
      timeout: 15_000,
    })
    .toBeLessThan(before.length);
  await page.reload();
  // A closed <details> still holds its checkboxes in the DOM, so the question
  // is not whether they exist — it is what the SERVER rendered them as.
  await page.getByTestId('board-menu').click();
  await page.getByTestId('card-fields-open').click();
  await expect(page.getByTestId('card-field-owner')).not.toBeChecked();
});

test('the name is never offered, so a card can never be blank', async ({ page }) => {
  await login(page);
  await page.goto('/crm?scope=all');
  await page.getByTestId('board-menu').click();
  await page.getByTestId('card-fields-open').click();
  // Seven switchable lines, and no checkbox for the one thing that identifies
  // the card — which is also how every other spec still finds cards by name.
  await expect(page.getByTestId('card-field-name')).toHaveCount(0);
  await expect(page.getByTestId('card-field-company')).toBeVisible();
});

test('the deal board offers the cubic metres it never showed', async ({ page }) => {
  await login(page);
  await page.goto('/bitimlar?scope=all');
  await page.getByTestId('board-menu').click();
  await page.getByTestId('card-fields-open').click();
  const volume = page.getByTestId('card-field-volume');
  await expect(volume).toBeVisible();
  // Off until asked for: the board that shipped did not have this line.
  await expect(volume).not.toBeChecked();
});

test('the menu costs the board no height while it is closed', async ({ page }) => {
  // The board's height is a viewport calculation and everything above it has
  // to be paid for (round 65). A popover in flow would push it down.
  await login(page);
  await page.goto('/crm?scope=all');
  const shut = await board(page).boundingBox();
  await page.getByTestId('board-menu').click();
  await page.getByTestId('card-fields-open').click();
  const open = await board(page).boundingBox();
  expect(Math.round(open!.y)).toBe(Math.round(shut!.y));
  // …and the open panel does not make the document wider than the phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  );
});

test('the card is put back the way it was found', async ({ page }) => {
  await login(page);
  await page.goto('/crm?scope=all');
  await page.getByTestId('board-menu').click();
  await page.getByTestId('card-fields-open').click();
  for (const key of ['company', 'phone', 'source', 'owner', 'code', 'chat', 'nextAction']) {
    await page.getByTestId(`card-field-${key}`).check();
  }
  await page.getByTestId('card-fields-save').click();
  await page.reload();
  await page.getByTestId('board-menu').click();
  await page.getByTestId('card-fields-open').click();
  await expect(page.getByTestId('card-field-owner')).toBeChecked();
});
