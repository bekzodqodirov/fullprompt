import { expect, test } from '@playwright/test';

/**
 * VED phase C — the offer, in a browser.
 *
 * What only a browser can prove: that a seller standing on a card with a
 * sealed price can produce a forwardable message in one press, that the
 * below-floor warning appears BEFORE the press rather than reporting a
 * decision already made, and that the price history screen answers about a
 * code. The arithmetic, the claim and the per-code window are proven in
 * `calc-offer.test.ts`, `calc-history.test.ts` and
 * `calc-offer.integration.test.ts`.
 *
 * It writes NO dictionary row: the price book is global and a row left
 * behind prices the next run's goods (#183, #653). Its lead is closed at the
 * end as a TEST, the way m9zo and m9zp close theirs (#508).
 */

const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';
const CODE = '8528520000';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

let leadName = '';
let cardUrl = '';

test.describe.configure({ mode: 'serial' });

test('a sealed price appears on the card without a fold', async ({ page }) => {
  await login(page, ADMIN);

  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  leadName = `VED offer e2e ${Date.now()}`;
  await page.getByTestId('quick-name').fill(leadName);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  // The URL captured at creation, never the board: every earlier spec adds
  // leads to the first column and the board is capped (#501).
  cardUrl = (await made.getByRole('link').first().getAttribute('href'))!;
  await page.goto(cardUrl);

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-podklyuch').click();
  await page.getByTestId('calc-from-city').fill('Yiwu');
  await page.getByTestId('calc-to-city').fill('Toshkent');
  await page.getByTestId('calc-weight').fill('1500');
  await page.getByTestId('calc-volume').fill('30');
  await page.getByTestId('calc-goods').fill('monitor, 100');
  await page.getByTestId('calc-send').click();

  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  const requestUrl = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;
  await page.goto(requestUrl);

  // VED 2.0: the code goes on the ITEM row, the save mints the group with
  // the PP-3818 dictionary's own 10 % / 12 % — no rate typing anywhere.
  await page.locator('[data-cell="tnvedCode"][data-row="0"]').fill(CODE);
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-group-row')).toContainText(CODE, { timeout: 15_000 });
  await page.getByTestId('calc-group-baza').fill('20');
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-group-customs')).toContainText('464', { timeout: 15_000 });

  await page.getByTestId('calc-zone').selectOption('cn');
  await page.getByTestId('calc-confirm-all').click();
  await expect(page.getByTestId('calc-total')).toContainText('3796.96', { timeout: 15_000 });
  await page.getByTestId('calc-do-seal').click();
  await expect(page.getByTestId('calc-sealed')).toBeVisible({ timeout: 15_000 });

  // Back on the card: the price is on screen with no fold to open, because a
  // sealed price is what the seller opens this card to read.
  await page.goto(cardUrl);
  await expect(page.getByTestId('calc-seal')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('calc-seal-total')).toContainText('3796.96');
});

test('the offer carries the SELLER’s price, and the floor is warned about first', async ({
  page,
}) => {
  expect(cardUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(cardUrl);

  const form = page.getByTestId('calc-offer');
  await expect(form).toBeVisible({ timeout: 15_000 });
  // Prefilled with the floor, and quiet about it.
  await expect(page.getByTestId('offer-price')).toHaveValue('3796.96');
  await expect(page.getByTestId('offer-below-floor')).toHaveCount(0);

  // Typing UNDER the floor warns before anything is pressed.
  await page.getByTestId('offer-price').fill('3000');
  await expect(page.getByTestId('offer-below-floor')).toBeVisible();

  // The seller's own price, above the floor.
  await page.getByTestId('offer-price').fill('4500');
  await expect(page.getByTestId('offer-below-floor')).toHaveCount(0);
  await page.getByTestId('offer-make').click();

  const text = page.getByTestId('offer-text');
  await expect(text).toBeVisible({ timeout: 15_000 });
  const body = await text.inputValue();
  expect(body).toContain('4 500.00');
  // The sealed total is what the calculation COST. It is the company's floor
  // and must not reach the customer's message.
  expect(body).not.toContain('3796');
  expect(body).not.toContain('3 796');

  // And the offer is recorded on the card, with a sheet behind it.
  await page.reload();
  await expect(page.getByTestId('calc-offers')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('calc-offer-pdf').first()).toBeVisible();
});

test('the history screen answers about the code, and refuses to guess', async ({ page }) => {
  await login(page, ADMIN);

  await page.goto('/hisoblash/narxlar');
  await expect(page.getByTestId('history-form')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('history-code').fill(CODE);
  await page.getByTestId('history-go').click();
  await expect(page.getByTestId('history-rows')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('history-offer').first()).toContainText('4');

  // A code nobody has ever priced gets the sentence, never somebody else's
  // number — the whole rule the three dictionaries were built on.
  await page.getByTestId('history-code').fill('0000000000');
  await page.getByTestId('history-go').click();
  await expect(page.getByTestId('history-none')).toBeVisible({ timeout: 15_000 });
});

test('the lead it created is closed (cleanup as a test)', async ({ page }) => {
  expect(leadName).not.toBe('');
  await login(page, ADMIN);
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
