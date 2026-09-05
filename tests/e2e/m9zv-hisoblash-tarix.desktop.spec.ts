import { expect, test } from '@playwright/test';

/**
 * The registry of SEALED calculations — his «hisoblangan narsalarning
 * tarixi» — in a browser.
 *
 * What only a browser can prove: that the THREE doors are real (his answer
 * 2A — himself, the accountant, the VED; not the sellers), and that the
 * number a person reads is the CHAIN's «V1» and not the stored column's.
 * The rank arithmetic, the two recalc guards and the filters are proven in
 * `calc-chain.integration.test.ts`. This spec writes nothing.
 *
 * It reads the seal m9zp left behind (one shared database, #154): a sealed
 * price is never deleted, and m9zp's cleanup closes its lead, which is not
 * the same thing.
 */

const VED = '+998900000004';
const ACCOUNTANT = '+998900000010';
const SELLER = '+998900000009';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test.describe.configure({ mode: 'serial' });

test('the VED opens it from the queue, and reads V1 on a sealed row', async ({ page }) => {
  await login(page, VED);
  await page.goto('/hisoblash');
  await page.getByTestId('calc-registry-link').click();
  await expect(page).toHaveURL(/\/hisoblash\/tarix/);
  await expect(page.getByTestId('calc-registry')).toBeVisible({ timeout: 15_000 });
  const rows = page.getByTestId('calc-registry-row');
  await expect(rows.first()).toBeVisible();
  // Every row is a VERSION with its rank; the un-corrected seal m9zp left
  // reads V1 — and no row prints the bare «v1» the stored counter wore.
  await expect(page.getByTestId('registry-version').first()).toHaveText(/^V\d+$/);
  // The VED may open the request itself.
  await expect(page.getByTestId('registry-request-link').first()).toBeVisible();
});

test('a text filter narrows in SQL and the empty answer is a sentence', async ({ page }) => {
  await login(page, VED);
  await page.goto('/hisoblash/tarix');
  await page.getByTestId('registry-q').fill('no-such-client-zzz');
  await page.getByTestId('registry-apply').click();
  await expect(page).toHaveURL(/q=no-such-client-zzz/);
  await expect(page.getByTestId('registry-empty')).toBeVisible({ timeout: 15_000 });
});

test('the ACCOUNTANT can open it, from the one calc screen they can reach', async ({ page }) => {
  await login(page, ACCOUNTANT);
  await page.goto('/hisoblash/narxlar');
  await page.getByTestId('calc-registry-link').click();
  await expect(page).toHaveURL(/\/hisoblash\/tarix/);
  await expect(page.getByTestId('calc-registry')).toBeVisible({ timeout: 15_000 });
  // Not a VED: the request link is not offered (the page behind it redirects).
  await expect(page.getByTestId('registry-request-link')).toHaveCount(0);
});

test('a SELLER is redirected — every figure here is a floor (law 4)', async ({ page }) => {
  await login(page, SELLER);
  await page.goto('/hisoblash/tarix');
  await expect(page).toHaveURL('/');
  // And the door is not drawn for them on the price history either.
  await page.goto('/hisoblash/narxlar');
  await expect(page.getByTestId('calc-registry-link')).toHaveCount(0);
});
