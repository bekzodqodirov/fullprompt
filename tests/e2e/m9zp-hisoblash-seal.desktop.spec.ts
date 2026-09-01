import { expect, test } from '@playwright/test';

/**
 * VED phase B — the workspace and the seal, in a browser.
 *
 * What only a browser can prove: that a person can walk from a bare request
 * to a locked price without touching the database, and that the refusals
 * really appear on screen as words rather than as an empty cell. The
 * arithmetic, the tariff's holes, the dictionaries' dates and the seal's race
 * are proven in `calc-pricing.test.ts` and `calc-seal.integration.test.ts`.
 *
 * Its cleanup is a TEST and not an `afterAll` (#508): a sealed price writes
 * `quoted_amount` onto the card, so this spec's lead is closed at the end the
 * same way m9zo closes its own — and it never touches the dictionaries, which
 * are global and would price the next run's goods (#183, #653).
 */

const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

let leadName = '';
let requestUrl = '';

test.describe.configure({ mode: 'serial' });

test('a request opens with a workspace that refuses to price it', async ({ page }) => {
  await login(page, ADMIN);

  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  leadName = `VED seal e2e ${Date.now()}`;
  await page.getByTestId('quick-name').fill(leadName);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  const href = await made.getByRole('link').first().getAttribute('href');
  await page.goto(href!);

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-podklyuch').click();
  await page.getByTestId('calc-from-city').fill('Yiwu');
  await page.getByTestId('calc-to-city').fill('Toshkent');
  // 1500 kg over 30 m³ is 50 kg/m³ — the first row of his own tariff.
  await page.getByTestId('calc-weight').fill('1500');
  await page.getByTestId('calc-volume').fill('30');
  await page.getByTestId('calc-goods').fill('monitor, 100');
  await page.getByTestId('calc-send').click();

  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  requestUrl = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;
  expect(requestUrl).toBeTruthy();

  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-workspace')).toBeVisible({ timeout: 15_000 });
  // Nothing is priced yet, and the screen SAYS so instead of showing $0.
  await expect(page.getByTestId('calc-total-blocked')).toBeVisible();
  await expect(page.getByTestId('calc-blockers')).toBeVisible();
  await expect(page.getByTestId('calc-do-seal')).toBeDisabled();
});

test('the freight refuses without a zone, and prices off his table with one', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);

  // The city offers an answer; the picker still demands one.
  await expect(page.getByTestId('calc-zone-hint')).toBeVisible();
  await expect(page.getByTestId('calc-freight-price')).toContainText('⚠');

  await page.getByTestId('calc-zone').selectOption('cn');
  // 50 kg/m³ → «1–100» at $110/m³ × 30 m³.
  await expect(page.getByTestId('calc-freight-price')).toContainText('3300', { timeout: 15_000 });
  await expect(page.getByTestId('calc-density')).toContainText('50');
});

test('group, rate, baza, confirm — then seal', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);

  await page.getByTestId('calc-new-group').fill('Monitorlar');
  await page.getByTestId('calc-add-group').click();
  await expect(page.getByTestId('calc-group-row')).toHaveCount(1, { timeout: 15_000 });

  // The goods land in the group through the picker the ungrouped list carries.
  await page.getByTestId('calc-item-group').first().selectOption({ index: 1 });
  await expect(page.getByTestId('calc-ungrouped')).toHaveCount(0, { timeout: 15_000 });

  // With no rates the group refuses, by name.
  await expect(page.getByTestId('calc-group-customs')).toContainText('⚠');

  await page.getByTestId('calc-group-edit').click();
  await page.getByTestId('calc-code').fill('8528520000');
  await page.getByTestId('calc-duty').fill('10');
  await page.getByTestId('calc-vat').fill('12');
  await page.getByTestId('calc-save-rates').click();

  // Anchor on the REFRESHED row before touching it again: the ⚠ was already
  // on screen before the save, so it cannot tell the old tree from the new
  // one — the code cell can, it was «—» until the save's own refresh landed.
  // Clicking the fold during the RSC swap lands on a detached node and the
  // fold never opens (#278's race in App Router clothes; CI's slower runner
  // hit it twice in a row on run 392).
  await expect(page.getByTestId('calc-group-row')).toContainText('8528520000', {
    timeout: 15_000,
  });
  // Still refused — now for the baza, which is per ITEM.
  await expect(page.getByTestId('calc-group-customs')).toContainText('⚠');
  await page.getByTestId('calc-group-edit').click();
  await page.getByTestId('calc-baza').first().fill('20');
  await page.getByTestId('calc-save-baza').first().click();

  // 100 × $20 = $2 000; duty 10 % = $200; VAT 12 % of $2 200 = $264. The
  // GROUP cell stays $464 — the VMQ-55 declaration fee (1 BHM ≈ $32.96 at
  // the demo book's 12 500 UZS/USD) is per REQUEST and lands in the total.
  await expect(page.getByTestId('calc-group-customs')).toContainText('464', { timeout: 15_000 });

  // An unconfirmed group is still the model's opinion — law 1, and the seal
  // stays shut until a person says otherwise.
  await expect(page.getByTestId('calc-do-seal')).toBeDisabled();
  await page.getByTestId('calc-confirm-all').click();
  await expect(page.getByTestId('calc-total')).toContainText('3796.96', { timeout: 15_000 });

  await page.getByTestId('calc-do-seal').click();
  await expect(page.getByTestId('calc-sealed')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('calc-sealed-total')).toContainText('3796.96');
});

test('the sealed price is on the card, and the card cannot change it', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);
  const cardHref = await page.getByTestId('calc-card-link').getAttribute('href');
  await page.goto(cardHref!);

  // Law 2: the price landed on the lead, and the ✏️ form has no box for it.
  //
  // Matched on the digits with any separator between them — the facts rail
  // formats money for the reader's locale, and `ru` prints «3 796,96 USD» with a
  // narrow no-break space that a literal '3796' will never find.
  await expect(page.getByTestId('lead-facts')).toContainText(/3\s*796/, { timeout: 15_000 });
  // The ✏️ form lives in a fold, so it has to be opened before anything in
  // it can be called visible.
  await page.getByTestId('lead-edit-panel').click();
  await expect(page.getByTestId('lead-quote-locked')).toBeVisible();
  await expect(page.getByTestId('lead-quote-amount')).toHaveCount(0);
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
