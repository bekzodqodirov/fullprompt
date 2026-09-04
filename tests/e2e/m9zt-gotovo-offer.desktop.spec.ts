import { expect, test } from '@playwright/test';

/**
 * VED 2.0 phase 4, item 5 — the Готово answer opens the offer door, in a
 * browser.
 *
 * What only a browser can prove: that a card whose price came from the
 * queue's «Bajarildi» figure (no seal — production's only price while the
 * dictionaries are empty) renders the SAME offer form a sealed card gets,
 * prefilled with the answer as the floor, and hands back a forwardable text
 * carrying the seller's own price and never the floor. The admissions, the
 * payable predicate and the release law are proven in
 * `calc-offer-answer.integration.test.ts`.
 */

const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(ADMIN);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

let leadName = '';
let cardUrl = '';

test.describe.configure({ mode: 'serial' });

test('a Готово figure becomes the floor: the card offers, the text hides it', async ({ page }) => {
  await login(page);

  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  leadName = `VED gotovo e2e ${Date.now()}`;
  await page.getByTestId('quick-name').fill(leadName);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  cardUrl = (await made.getByRole('link').first().getAttribute('href'))!;
  await page.goto(cardUrl);

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-rastamojka').click();
  await page.getByTestId('calc-goods').fill('krujka, 500');
  await page.getByTestId('calc-send').click();
  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  const requestUrl = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;

  // The queue's own ending: take it, type the figure — no seal anywhere.
  await page.goto(requestUrl);
  const take = page.getByTestId('calc-take');
  if (await take.count()) await take.click();
  await page.getByTestId('calc-finish-open').click();
  await page.getByTestId('calc-answer-amount').fill('1000');
  await page.getByTestId('calc-answer-note').fill('gotovo e2e');
  await page.getByTestId('calc-finish').click();
  await expect(page.getByTestId('calc-answer')).toBeVisible({ timeout: 15_000 });

  // Back on the card: the answer door renders the offer form, prefilled
  // with the Готово figure as the floor.
  await page.goto(cardUrl);
  await expect(page.getByTestId('calc-answer-door')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('offer-price')).toHaveValue('1000.00');
  // Under the floor the warning appears BEFORE any press…
  await page.getByTestId('offer-price').fill('900');
  await expect(page.getByTestId('offer-below-floor')).toBeVisible();
  // …and the seller's own price above it makes the offer in one press.
  await page.getByTestId('offer-price').fill('1200');
  await expect(page.getByTestId('offer-below-floor')).toHaveCount(0);
  await page.getByTestId('offer-make').click();

  const text = page.getByTestId('offer-text');
  await expect(text).toBeVisible({ timeout: 15_000 });
  const body = await text.inputValue();
  expect(body).toContain('1 200.00');
  // The floor is the company's own figure and never reaches the customer.
  expect(body).not.toContain('1 000.00');
  // The sheet is fetched by the OFFER's id — one route for both anchors.
  await expect(page.getByTestId('offer-pdf')).toBeVisible();

  // The recorded offer shows on the card with its PDF door.
  await page.reload();
  await expect(page.getByTestId('calc-offers')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('calc-offer-pdf').first()).toBeVisible();
});

test('the lead it created is closed (cleanup as a test)', async ({ page }) => {
  expect(leadName).not.toBe('');
  await login(page);
  await page.goto('/crm?scope=all');
  const card = page
    .getByTestId('funnel-desktop')
    .getByTestId('lead-card')
    .filter({ hasText: leadName })
    .first();
  if ((await card.count()) === 0) return;
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
