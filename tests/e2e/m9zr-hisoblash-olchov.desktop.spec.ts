import { expect, test } from '@playwright/test';

/**
 * VED 2.0 phase 3 — the unit-driven row, in a browser.
 *
 * What only a browser can prove: that typing the ONE m² code in the book
 * (6907, «15 %, min $1/m²») grows the row its O'lchov line; that the baza
 * select offers m² for exactly that row; that the LIVE block figure updates
 * and the seal takes the same number; and that deleting a row carrying an
 * unsaved draft releases the dirty gate instead of wedging every later save
 * (the shipped-audit's finding, proven where it lived — in client state).
 *
 * Its own lead, its own cleanup as a test (#183/#508); the dictionaries are
 * never touched.
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
let requestUrl = '';

test.describe.configure({ mode: 'serial' });

test('a m² code asks for its measure, prices live, and seals the same number', async ({ page }) => {
  await login(page);

  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  leadName = `VED olchov e2e ${Date.now()}`;
  await page.getByTestId('quick-name').fill(leadName);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  const href = await made.getByRole('link').first().getAttribute('href');
  await page.goto(href!);

  // Rastamojka only — no freight fixture, the customs side is the subject.
  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-rastamojka').click();
  await page.getByTestId('calc-goods').fill('plitka, 50\nvaza, 10');
  await page.getByTestId('calc-send').click();
  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  requestUrl = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;

  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });

  // 6907 — the one m² row in PP-3818. Before the save there is no O'lchov
  // line anywhere: the law shape arrives with the block.
  await expect(page.getByTestId('calc-measure')).toHaveCount(0);
  await page.locator('[data-cell="tnvedCode"][data-row="0"]').fill('6907');
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-group-row').first()).toContainText('6907', { timeout: 15_000 });

  // The code said m² — the row grew its measure input, and the basis select
  // now OFFERS m² for exactly this row. The grouped row renders LAST: the
  // table draws ungrouped rows first, then the declaration blocks.
  await expect(page.getByTestId('calc-measure')).toHaveCount(1);
  const basis = page.getByTestId('calc-basis').last();
  await expect(basis.locator('option[value="m2"]')).toHaveCount(1);
  // …and the codeless row's select still offers nothing beyond unit/kg.
  await expect(
    page.getByTestId('calc-basis').first().locator('option[value="m2"]'),
  ).toHaveCount(0);

  // 200 m² at $1/m²: value 200; advalor 15 % = 30; specific 200 × $1 = 200
  // → MAX 200; VAT 12 % of 400 = 48 → the block's own figure is $248.
  await page.getByTestId('calc-measure').fill('200');
  await page.getByTestId('calc-baza').last().fill('1');
  await basis.selectOption('m2');
  await expect(page.getByTestId('calc-unsaved')).toBeVisible();
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-group-row').first()).toContainText('248', {
    timeout: 15_000,
  });
});

test('deleting a row with an unsaved draft releases the gate — never a wedge', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page);
  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });

  // A half-typed cell on the codeless row (vaza) — which renders FIRST,
  // because ungrouped rows sit above the declaration blocks…
  await page.locator('[data-cell="quantity"][data-row="0"]').fill('77');
  await expect(page.getByTestId('calc-unsaved')).toBeVisible();

  // …then the row is deleted through its ⋯. The draft must die WITH the row:
  // before the fix, drafts were keyed by seq and survived, so every later
  // save refused not_found about a row no longer on the screen, and the
  // dirty gate latched until a full reload.
  await page.getByTestId('calc-item-menu').first().click();
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('calc-item-delete').click();
  await expect(page.getByTestId('calc-row')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('calc-unsaved')).toHaveCount(0);

  // The gate released — the confirm door is reachable and the block confirms.
  await page.getByTestId('calc-confirm-all').click();
  await expect(page.getByTestId('calc-group-ok')).toBeVisible({ timeout: 15_000 });

  // And the seal takes the block's figure + the 1-BHM declaration fee
  // ($32.96 at the demo book's 12 500): 248 + 32.96 = 280.96.
  await page.getByTestId('calc-do-seal').click();
  await expect(page.getByTestId('calc-sealed')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('calc-sealed-total')).toContainText('280.96');
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
