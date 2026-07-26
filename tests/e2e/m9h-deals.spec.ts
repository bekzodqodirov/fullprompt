import { expect, test } from '@playwright/test';

/**
 * Bitim — the quote and the reality on one screen.
 *
 * The part only a browser can prove: a job raised from a client card gets a
 * price, the cargo that actually arrived is pulled in from the receipt without
 * anybody typing it, and the card SAYS the two do not match — which is the
 * whole reason the feature exists (docs/DEALS.md).
 *
 * Runs last in the file order on purpose (DECISIONS #154): it leaves a deal on
 * a demo client behind, which is data rather than configuration, and it adds
 * no stages, fields or roles that would change what earlier specs render.
 */

const OWNER = '+998900000001';
const YW_OPERATOR = '+998900000006';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('a job is quoted, the cargo arrives bigger, and the card says so', async ({ page }) => {
  await login(page, OWNER);

  // Raised from the client card — where a salesperson already is. GS777 by
  // name, not "the first row": the point of this test is a job with REAL
  // cargo behind it, and the first client alphabetically has none, which is
  // how the first version of this spec passed while proving nothing.
  await page.goto('/admin/clients?q=GS777');
  await page.locator('a[href^="/admin/clients/"]:not([href$="/new"])').first().click();
  await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]+$/);
  await expect(page.getByText('GS777')).toBeVisible();
  const clientUrl = page.url();

  await page.getByTestId('client-new-deal').click();
  await expect(page).toHaveURL(/\/bitimlar\/new\?client=/);

  // Deliberately a tiny quote: whatever the seeded cargo turns out to be, it
  // is certainly more than a tenth of a cubic metre, so the verdict is
  // decided by the real numbers rather than by a hard-coded expectation.
  const title = `Bitim ${runId}`;
  await page.getByTestId('deal-title').fill(title);
  await page.getByTestId('deal-volume').fill('0.1');
  await page.getByTestId('deal-weight').fill('10');
  await page.getByTestId('deal-amount').fill('200');
  await page.getByTestId('save-deal').click();

  // The create action redirects to the card it just made.
  await expect(page).toHaveURL(/\/bitimlar\/[0-9a-f-]+$/);
  const dealUrl = page.url();
  await expect(page.getByTestId('deal-compare')).toBeVisible();

  // Nothing is linked yet, so the card must say the cargo has not arrived
  // rather than claim the job is on budget.
  await expect(page.getByTestId('deal-compare')).toContainText('0.1');

  // Attach cargo that already exists — the retro-fix path for a receipt the
  // warehouse confirmed before anyone raised the job.
  const picker = page.getByTestId('link-receipt-pick');
  await expect(picker).toBeVisible();
  const options = await picker.locator('option').all();
  const values = (await Promise.all(options.map((o) => o.getAttribute('value')))).filter(Boolean);
  expect(values.length).toBeGreaterThan(1);
  await picker.selectOption(values[1]!);
  await page.getByTestId('link-receipt-save').click();

  // The reality column is filled in from the receipt, and the verdict flips.
  await expect(page.getByTestId('deal-compare')).toContainText(/%/);
  await page.reload();
  await expect(page.getByTestId('deal-compare')).toContainText(/%/);

  // …and the job now shows up as needing attention on the board.
  await page.goto('/bitimlar?scope=all');
  await expect(page.getByTestId('deal-attention')).toBeVisible();

  // The client card carries the same job, so a salesperson sees it before
  // picking up the phone.
  await page.goto(clientUrl);
  await expect(page.getByTestId('client-deal-row').first()).toBeVisible();
  await page.goto(dealUrl);
  await expect(page.getByText(title)).toBeVisible();
});

test('a warehouse operator never reaches the deal board', async ({ page }) => {
  await login(page, YW_OPERATOR);
  // Not in their menu — the deal board is sales and VED work.
  await expect(page.locator('main a[href="/bitimlar"]')).toHaveCount(0);
  // …and the route itself refuses, not only the tile.
  await page.goto('/bitimlar');
  await expect(page).toHaveURL('/');
});
