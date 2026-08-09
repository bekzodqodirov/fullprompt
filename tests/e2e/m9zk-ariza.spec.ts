import { expect, test } from '@playwright/test';

/**
 * The advert door, from the outside.
 *
 * Everything the landing decides is proven in the integration suite; what only
 * a browser can show is that the page opens with NO session at all, that a
 * stranger's answer says nothing about our database, and that what they typed
 * arrives on a real card with a real owner's screen behind it.
 *
 * It loses the lead it creates at the end. A lead is never deleted here — «a
 * finished lead leaves the board, never the database» — so losing it with a
 * reason is the honest cleanup and keeps it off every later spec's funnel.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const RUN = String(Date.now()).slice(-6);
const NAME = `Reklama ariza ${RUN}`;
const PHONE = `+99893${RUN}9`;

test.describe.configure({ mode: 'serial' });

test('a stranger with no login leaves their number', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/ariza?manba=instagram&utm_campaign=avgust');
  // No login wall, no app shell — the page an advert points at cannot ask for
  // a session it will never have.
  await expect(page).toHaveURL(/\/ariza/);
  await expect(page.getByTestId('ariza-send')).toBeVisible();

  // The two complaints that ARE allowed to be specific: they are about the box
  // the sender just typed in, and say nothing about us.
  await page.getByTestId('ariza-name').fill('A');
  await page.getByTestId('ariza-send').click();
  await expect(page.getByTestId('ariza-error')).toBeVisible();
  await page.getByTestId('ariza-name').fill(NAME);
  await page.getByTestId('ariza-phone').fill('123');
  await page.getByTestId('ariza-send').click();
  await expect(page.getByTestId('ariza-error')).toBeVisible();
  // A refused send keeps every box — a stranger has no card to come back to.
  await expect(page.getByTestId('ariza-name')).toHaveValue(NAME);

  await page.getByTestId('ariza-phone').fill(PHONE);
  await page.getByTestId('ariza-note').fill('Guangzhoudan 3 kub kiyim');
  await page.getByTestId('ariza-send').click();
  await expect(page.getByTestId('ariza-done')).toBeVisible();
  // Nothing here names a lead, a client or a stage. Created, joined onto an
  // open enquiry and dropped at the cap all look exactly like this.
  await expect(page.getByTestId('ariza-done')).not.toContainText(RUN);

  // The page at 360 px, which is the only width that matters for an advert.
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, 'the form grew sideways').toBeLessThanOrEqual(360);
});

test('it is on the funnel, and on the arrivals ledger', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // The ledger is the screen `lead_intakes` exists for: it shows what an
  // advert produced INCLUDING what it did not turn into.
  await page.goto('/crm/kelganlar');
  const row = page.getByTestId('arrivals-rows').locator('li').filter({ hasText: NAME });
  await expect(row).toBeVisible();
  await expect(row).toContainText('instagram');

  // …and the card itself carries what they wrote, on the lenta, where the
  // second and the tenth message will go too.
  await row.getByRole('link', { name: NAME }).click();
  await expect(page).toHaveURL(/\/crm\/leads\/[0-9a-f-]+$/);
  await expect(page.getByText('Guangzhoudan 3 kub kiyim')).toBeVisible();

  // Booked for today, so it is on the call list the day it arrived — which is
  // the whole reason for paying for the advert.
  await page.goto('/crm/today');
  await expect(page.getByText(NAME)).toBeVisible();
});

test('the lead is lost afterwards, so it leaves the board', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/crm?q=' + encodeURIComponent(NAME) + '&scope=all');
  const card = page
    .getByTestId('funnel-mobile')
    .getByTestId('lead-card')
    .filter({ hasText: NAME })
    .first();
  await expect(card).toBeVisible();

  // Through the bulk bar, which takes the reason in a real input — the card's
  // own ⋯ sheet asks for it with `window.prompt`, and the answer here is the
  // COUNT the sweep reports, which is a claim rather than a disappearance:
  // a lost lead stays on the board in its closed column (round 47), so
  // «it is gone» would be the wrong thing to assert.
  await card.getByTestId('card-select').click();
  const bar = page.getByTestId('bulk-bar');
  const lost = await bar
    .getByTestId('bulk-stage')
    .locator('option[data-kind="lost"]')
    .first()
    .getAttribute('value');
  await bar.getByTestId('bulk-stage').selectOption(lost!);
  await bar.getByTestId('bulk-reason').fill('e2e tozalash');
  await bar.getByTestId('bulk-move').click();
  await expect(bar.getByTestId('bulk-result')).toContainText('1', { timeout: 15_000 });
});
