import { expect, test } from '@playwright/test';

/**
 * VED phase E1 — «hisob va haqiqat», in a browser.
 *
 * What only a browser can prove, and what #777 shipped wrong one round ago:
 * that the THREE doors are real. The audience is a composite of grants the
 * owner edits with checkboxes, and the last time a phase-E-shaped screen was
 * gated, it locked out the accountant — who is half of what it is for. So
 * this logs in as each of the three roles that matter and reads the answer,
 * rather than asserting about a predicate.
 *
 * The arithmetic, the refusal ladder and the link doors are proven in
 * `calc-actuals.integration.test.ts`. This writes nothing and leaves nothing
 * behind: it reads a screen.
 */

const ADMIN = '+998900000001';
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

test('the owner reads the coverage line first', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto('/hisoblash/nazorat');
  // Coverage is deliberately the FIRST section: with nothing linked, every
  // number below it is about nothing, and a screen that hides that reads
  // «we have no errors» when it means «we have no data».
  await expect(page.getByTestId('control-coverage')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('control-queue')).toBeVisible();
  await expect(page.getByTestId('control-warned')).toBeVisible();
  await expect(page.getByTestId('control-accuracy')).toBeVisible();
});

test('the ACCOUNTANT can open it — the door #777 got wrong', async ({ page }) => {
  // They cannot open /hisoblash at all (it gates on `ved.docs`), which is why
  // the link lives on /hisoblash/narxlar too. The screen is half theirs: the
  // rastamojka they type into the cost grid is the other side of every
  // comparison on it.
  await login(page, ACCOUNTANT);
  await page.goto('/hisoblash/nazorat');
  await expect(page).toHaveURL(/\/hisoblash\/nazorat/);
  await expect(page.getByTestId('control-coverage')).toBeVisible({ timeout: 15_000 });
});

test('the VED can open it — they are the person it measures', async ({ page }) => {
  await login(page, VED);
  await page.goto('/hisoblash/nazorat');
  await expect(page).toHaveURL(/\/hisoblash\/nazorat/);
  await expect(page.getByTestId('control-coverage')).toBeVisible({ timeout: 15_000 });
  // And the door is on the queue's own header, where they already are.
  await page.goto('/hisoblash');
  await expect(page.getByTestId('calc-control-link')).toBeVisible();
});

test('a SELLER is redirected — a cost breakdown is not their screen', async ({ page }) => {
  // Law 10: sellers read PRICES, never the cost side. Redirected and not
  // shown an empty table, so the screen does not exist for them at all.
  await login(page, SELLER);
  await page.goto('/hisoblash/nazorat');
  await expect(page).toHaveURL('/');
});
