import { expect, test } from '@playwright/test';

/**
 * The quarterly customs dump, in a browser (docs/VED-IMPORT-AI.md §2).
 *
 * What only a browser can prove: that the admin's upload lands, that the
 * background parse settles the row READY without anybody reloading by hand,
 * that a calculation whose product matches a declaration comes back with its
 * baza filled and wearing the «📥 taxmin» chip, and that the ⋯ picker offers
 * the file's own rows for the VED to choose from.
 *
 * CLEANUP IS A TEST (#183/#508, #57's lie). A ready import is the loudest
 * CONFIGURATION this suite can leave behind: it fills the baza of every
 * coded row with an empty one, on every later save, in every later spec. The
 * last test retypes the price (which releases the provenance) and then
 * removes the batch through its own button.
 */

const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';
const FIXTURE = 'tests/fixtures/customs-import-sample.xlsx';
/** The fixture's first declaration: a per-kg nonwoven at $1.7548/kg. */
const CODE = '5603139000';
const GOODS = 'Нетканый материал из химических нитей в рулонах';

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(ADMIN);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

let leadName = '';
let requestUrl = '';

test.describe.configure({ mode: 'serial' });

test('the admin uploads the quarter and the parse settles it READY', async ({ page }) => {
  await login(page);
  await page.goto('/admin/bojxona-import');
  await expect(page.getByTestId('customs-import')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('import-file').setInputFiles(FIXTURE);
  await page.getByTestId('import-upload').click();
  await expect(page.getByTestId('import-queued')).toBeVisible({ timeout: 15_000 });

  // The row is the progress bar: the request only stored the bytes, and the
  // screen refreshes itself while anything is still being parsed.
  await expect(page.getByTestId('import-ready').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('import-batch').first()).toContainText('customs-import-sample');
});

test('a coded row with an empty baza comes back priced from the file', async ({ page }) => {
  await login(page);

  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  leadName = `VED import e2e ${Date.now()}`;
  await page.getByTestId('quick-name').fill(leadName);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  await page.goto((await made.getByRole('link').first().getAttribute('href'))!);

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-rastamojka').click();
  await page.getByTestId('calc-goods').fill(`${GOODS}, 100`);
  await page.getByTestId('calc-send').click();
  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  requestUrl = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;

  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });

  // The row states a WEIGHT, so a per-kg declaration can price it; the code
  // is advalor, so the law pins no unit and kilograms are asked for first.
  await page.locator('[data-cell="weightKg"][data-row="0"]').fill('100');
  await page.locator('[data-cell="tnvedCode"][data-row="0"]').fill(CODE);
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-group-row').first()).toContainText(CODE, {
    timeout: 15_000,
  });

  // Nobody typed a price, and the row is not empty: the save says which rows
  // it filled, and the row itself says the number is an estimate.
  await expect(page.getByTestId('calc-save-note')).toContainText('📥');
  await expect(page.getByTestId('calc-baza-import')).toHaveCount(1);
  await expect(page.getByTestId('calc-baza').last()).toHaveValue(/1\.75/);
});

test('the ⋯ offers the file’s own declarations to pick from', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page);
  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('calc-item-menu').last().click();
  await page.getByTestId('calc-import-pick').click();
  const candidates = page.getByTestId('calc-import-candidate');
  await expect(candidates.first()).toBeVisible({ timeout: 15_000 });
  // Every candidate names its price and the unit it is priced in — the VED
  // is choosing a declaration, not a number.
  await expect(candidates.first()).toContainText('$');
  await candidates.first().click();
  await expect(page.getByTestId('calc-unsaved')).toBeVisible();
});

test('cleanup: the price becomes the VED’s and the import is removed', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page);
  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });

  // A number the VED types is theirs — the provenance goes with the price it
  // explained, so nothing is left pointing at the import.
  await page.getByTestId('calc-baza').last().fill('9');
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-baza-import')).toHaveCount(0, { timeout: 15_000 });

  await page.goto('/admin/bojxona-import');
  const rows = page.getByTestId('import-batch');
  const before = await rows.count();
  page.once('dialog', (d) => void d.accept());
  await rows.first().getByTestId('import-delete').click();
  await expect(rows).toHaveCount(before - 1, { timeout: 15_000 });

  // …and the lead this walk created goes too.
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
