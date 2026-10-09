import { expect, test, type Page } from '@playwright/test';

/**
 * P1 «Kiritish» — the seller's goods TABLE, in a browser (docs/RASTAMOJKA-
 * TUZATISH.md §1 P1.1, §7.1 UX1-UX3, UX13).
 *
 * The owner's sentence: «tnved code va dona m2 juftda otadgan tovarlarni
 * kirgizadgan joyi yoqku». What only a browser can prove: that a seller can
 * TYPE a code, a pair and a net weight into the card's form, that the quick
 * box still reads «nomi, soni» lines into the same rows, that a line the
 * kernel cannot read stops the send with a one-tap answer, and that the VED
 * then finds every figure in its own column. The door's routing itself is
 * proven against the database in calc-kiritish.integration.test.ts.
 *
 * Cleanup is a TEST (#183, #508): the request is answered and the lead
 * closed, or a later spec meets them in the company-wide queue.
 */
const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';
const STAMP = Date.now();
const KAFEL = `Kafel plitka ${STAMP} jadval`;
const KURTKA = `Kurtka ${STAMP} jadval`;

async function login(page: Page, phone: string) {
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

test('a seller types a code, a pair, a count and a net weight into the table', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  leadName = `Jadval e2e ${STAMP}`;
  await page.getByTestId('quick-name').fill(leadName);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  const href = await made.getByRole('link').first().getAttribute('href');
  expect(href, 'the quick-create toast must link to the lead').toBeTruthy();
  await page.goto(href!);

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-rastamojka').click();
  await page.getByTestId('calc-weight').fill('1100');
  await page.getByTestId('calc-volume').fill('5');

  // Row 1 — «Kafel plitka | 6907 | | | 120 m²». The form opens with ONE row.
  const rows = page.getByTestId('calc-rows').getByTestId('calc-row');
  await expect(rows).toHaveCount(1);
  const first = rows.nth(0);
  await first.getByTestId('calc-row-name').fill(KAFEL);
  await first.getByTestId('calc-row-amount').fill('120');
  await first.getByTestId('calc-row-unit').selectOption('m2');
  await first.getByTestId('calc-row-code').fill('6907');
  // Enter in the last row's TNVED adds the next row (UX1).
  await first.getByTestId('calc-row-code').press('Enter');
  await expect(rows).toHaveCount(2);

  // Row 2 — «Kurtka | 6201 | 300 | 150».
  const second = rows.nth(1);
  await expect(second.getByTestId('calc-row-name')).toBeFocused();
  await second.getByTestId('calc-row-name').fill(KURTKA);
  await second.getByTestId('calc-row-qty').fill('300');
  await second.getByTestId('calc-row-kg').fill('150');
  await second.getByTestId('calc-row-code').fill('6201');

  // The quick box still reads «nomi, soni» (UX2) — and a model number at the
  // end of a name stops the send with a one-tap answer (UX3): «55» is part of
  // the name, «10» the count.
  await page.getByTestId('calc-goods').fill('Samsung TV 55, 10');
  await expect(rows).toHaveCount(3);
  await page.getByTestId('calc-send').click();
  await expect(page.getByTestId('calc-send-blocked')).toBeVisible();
  await expect(page.getByTestId('calc-open')).toHaveCount(0);
  await rows.nth(2).getByTestId('calc-row-fix-name').click();
  await expect(rows.nth(2).getByTestId('calc-row-name')).toHaveValue('Samsung TV 55');
  await expect(rows.nth(2).getByTestId('calc-row-qty')).toHaveValue('10');

  await page.getByTestId('calc-send').click();
  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  const openHref = await page.getByTestId('calc-open-link').first().getAttribute('href');
  expect(openHref, 'the panel must link to the request it just opened').toBeTruthy();
  requestUrl = openHref!;
});

test('the VED finds 120 m² in the measure box and both 300 dona and 150 kg on row 2', async ({ page }) => {
  expect(requestUrl, 'the send test must have captured its request').not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });

  // Row 1: the code and the pair, never «120 dona».
  await expect(page.locator('[data-cell="name"][data-row="0"]')).toHaveValue(KAFEL);
  await expect(page.locator('[data-cell="tnvedCode"][data-row="0"]')).toHaveValue('6907');
  await expect(page.locator('[data-cell="quantity"][data-row="0"]')).toHaveValue('');
  await expect(page.locator('[data-cell="measure"][data-row="0"]')).toHaveValue('120');
  // Row 2: the clothing line keeps BOTH figures — a per-kg baza under a
  // per-piece floor needs the two.
  await expect(page.locator('[data-cell="name"][data-row="1"]')).toHaveValue(KURTKA);
  await expect(page.locator('[data-cell="quantity"][data-row="1"]')).toHaveValue('300');
  await expect(page.locator('[data-cell="weightKg"][data-row="1"]')).toHaveValue('150');
  await expect(page.locator('[data-cell="tnvedCode"][data-row="1"]')).toHaveValue('6201');
  // Row 3: the name kept its number.
  await expect(page.locator('[data-cell="name"][data-row="2"]')).toHaveValue('Samsung TV 55');
  await expect(page.locator('[data-cell="quantity"][data-row="2"]')).toHaveValue('10');
});

test('the request is answered and the lead closed (cleanup as a test)', async ({ page }) => {
  expect(requestUrl, 'the send test must have captured its request').not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);
  const take = page.getByTestId('calc-take');
  if (await take.isVisible()) {
    await take.click();
    await expect(take).toHaveCount(0, { timeout: 15_000 });
  }
  await page.getByTestId('calc-finish-open').click();
  await page.getByTestId('calc-answer-amount').fill('480');
  await page.getByTestId('calc-answer-note').fill('e2e');
  await page.getByTestId('calc-answer-internal').fill('ichki izoh e2e');
  await page.getByTestId('calc-finish').click();
  await expect(page.getByTestId('calc-answer')).toBeVisible({ timeout: 15_000 });

  await page.goto('/crm?scope=all');
  const card = page.getByTestId('funnel-desktop').getByTestId('lead-card').filter({ hasText: leadName }).first();
  if ((await card.count()) === 0) return;
  await card.getByTestId('card-select').click();
  const bar = page.getByTestId('bulk-bar');
  const lost = await bar.getByTestId('bulk-stage').locator('option[data-kind="lost"]').first().getAttribute('value');
  await bar.getByTestId('bulk-stage').selectOption(lost!);
  await bar.getByTestId('bulk-reason').fill('e2e tozalash');
  await bar.getByTestId('bulk-move').click();
  await expect(bar.getByTestId('bulk-result')).toContainText('1', { timeout: 15_000 });
});
