import { expect, test } from '@playwright/test';

/**
 * The VED on the seller's card, in a browser (the owner's 14a 15a 16a,
 * docs/VED-TARIX.md §10): «noaniqliklar bolganda ved hodimi hsoblashdan
 * kartaga otib aniqlashtirib oladi» — and «may NOT edit».
 *
 * What only a browser can prove: that the history row's card link opens the
 * KARTA for a person the CRM layout would send home, that the karta takes a
 * text note and draws the seller's offer price, and that it draws none of the
 * lead card's write doors. The door itself, the note pings and the file
 * branch are proven in `calc-card-door.integration.test.ts`.
 *
 * Its OWN fixture (review tests-completeness-14): the queue lists open jobs
 * only, an offer anchors only a seal or a completed answer, and the shared
 * database holds other people's requests — so the admin makes a lead, answers
 * it and offers on it, and the VED reaches it by the request id captured at
 * creation, never by `.first()`. Sorts after m9zt (one worker, one database,
 * #154) and closes its lead as a final test.
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

const STAMP = Date.now();
const GOODS = `karta tovar e2e ${STAMP}`;
let leadName = '';
let cardUrl = '';
let requestId = '';

test.describe.configure({ mode: 'serial' });

test('the admin makes a lead, answers its calculation and offers a price', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  leadName = `VED karta e2e ${STAMP}`;
  await page.getByTestId('quick-name').fill(leadName);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  cardUrl = (await made.getByRole('link').first().getAttribute('href'))!;
  await page.goto(cardUrl);

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-rastamojka').click();
  await page.getByTestId('calc-goods').fill(`${GOODS}, 300`);
  await page.getByTestId('calc-send').click();
  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  const requestUrl = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;
  requestId = requestUrl.split('/').pop()!;
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);

  await page.goto(requestUrl);
  const take = page.getByTestId('calc-take');
  if (await take.count()) await take.click();
  await page.getByTestId('calc-finish-open').click();
  await page.getByTestId('calc-answer-amount').fill('1000');
  await page.getByTestId('calc-answer-note').fill('karta e2e');
  await page.getByTestId('calc-answer-internal').fill('ichki karta e2e');
  await page.getByTestId('calc-finish').click();
  await expect(page.getByTestId('calc-answer')).toBeVisible({ timeout: 15_000 });

  await page.goto(cardUrl);
  await expect(page.getByTestId('calc-answer-door')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('offer-price').fill('1200');
  await page.getByTestId('offer-make').click();
  await expect(page.getByTestId('offer-text')).toBeVisible({ timeout: 15_000 });
});

test('the VED walks from the history row to the karta, asks, and reads the seller’s price', async ({ page }) => {
  expect(requestId).not.toBe('');
  await login(page, VED);
  await page.goto(`/hisoblash/tarix?turi=javob&q=${encodeURIComponent(GOODS)}`);
  const row = page
    .getByTestId('calc-registry-answer')
    .filter({ has: page.locator(`a[href="/hisoblash/${requestId}"]`) });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  // The card link is the KARTA for him — the CRM card would send him home.
  const link = row.getByTestId('registry-card');
  await expect(link).toHaveAttribute('href', `/hisoblash/${requestId}/karta`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/hisoblash/${requestId}/karta`));
  await expect(page.getByTestId('calc-karta')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: leadName })).toBeVisible();
  await expect(page.getByTestId('karta-facts')).toBeVisible();

  // Read-only: none of the lead card's write doors (14a).
  await expect(page.getByTestId('lead-edit-panel')).toHaveCount(0);
  await expect(page.getByTestId('calc-send')).toHaveCount(0);
  await expect(page.getByTestId('offer-make')).toHaveCount(0);

  // 16a: the seller's price, without its PDF door.
  await expect(page.getByTestId('calc-offer-price').first()).toContainText('$1200.00');
  await expect(page.getByTestId('calc-offer-pdf')).toHaveCount(0);

  // 15a: a TEXT note on the lead — no 📎 on his box.
  await expect(page.getByTestId('feed-note-attach')).toHaveCount(0);
  const question = `Necha kub? e2e ${STAMP}`;
  await page.getByTestId('feed-note-body').fill(question);
  await page.getByTestId('feed-note-save').click();
  await expect(page.getByTestId('client-feed')).toContainText(question, { timeout: 15_000 });
});

test('the VED is still refused the CRM card itself', async ({ page }) => {
  expect(cardUrl).not.toBe('');
  await login(page, VED);
  await page.goto(cardUrl);
  await expect(page).not.toHaveURL(/\/crm\/leads\//);
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
