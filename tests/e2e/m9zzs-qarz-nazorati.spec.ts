import { expect, test, type Page } from '@playwright/test';

/**
 * Qarz nazorati (0114) in a real browser, on the phone project (360 px):
 *
 *  - the seller records a payment promise on HIS client's «Pul» tab;
 *  - the accountant opens «Qarzga berilgan yuklar» and the document is no
 *    wider than the phone;
 *  - the warehouse manager, who holds the grant and reads no ledger, gets
 *    the sentence on /approvals instead of an empty list;
 *  - cleanup, a final TEST (round 57's `afterAll` lie): the promise is
 *    cancelled and the charge voided.
 *
 * The debt the promise needs is this spec's OWN charge (the judge's MISSING
 * item: whether GS205 owes anything depends on earlier specs), voided in the
 * final test with the promise, so nothing is left for the next spec (#154):
 * a live debt arms the handover gate, a live promise is an open task.
 *
 * NOT serial, on purpose: in serial mode one failure SKIPS every later test,
 * cleanup included, and leaves the $123.45 and an open promise on GS205 for
 * every spec after this one (#183). Each test resolves the client itself (a
 * failure costs Playwright its worker and module state starts again, round
 * 62's lesson), and the charge carries a FIXED note, so the cleanup finds this
 * spec's rows — a failed earlier run's included — by what they say, never by
 * an id a dead worker held (#523).
 */

const PASSWORD = 'demo1234';
const SELLER = '+998900000009'; // Dilnoza — owns GS777, GS102, GS205
const ACCOUNTANT = '+998900000010';
const WAREHOUSE_MANAGER = '+998900000005';
const CODE = 'GS205';
const AMOUNT = '123.45';
const NOTE = 'qarz e2e m9zzs';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function clientIdOf(page: Page): Promise<string> {
  const found = await page.request.get(`/api/clients/search?q=${CODE}`);
  const body = (await found.json()) as { results: { id: string; clientCode: string }[] };
  const id = body.results.find((row) => row.clientCode === CODE)?.id ?? '';
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

const ledgerForm = (page: Page) => page.locator('form').filter({ has: page.locator('input[name="txDate"]') });
/** This spec's charges that are still live — a voided row greys out (opacity-50). */
const liveCharges = (page: Page) => page.locator('div.border-b:not(.opacity-50)').filter({ hasText: NOTE });

test('the accountant posts this spec’s own charge on the seller’s client', async ({ page }) => {
  await login(page, ACCOUNTANT);
  const clientId = await clientIdOf(page);
  await page.goto(`/finance/${clientId}`);
  const form = ledgerForm(page);
  await form.getByRole('button', { name: /🧾/ }).click();
  await form.locator('input[name="amount"]').fill(AMOUNT);
  await form.locator('select[name="currency"]').selectOption('USD');
  await form.locator('input[name="note"]').fill(NOTE);
  await form.locator('button[type="submit"]').click();
  await expect(form.getByText('✅')).toBeVisible({ timeout: 15_000 });
});

test('the register renders for the accountant, no wider than the phone', async ({ page }) => {
  await login(page, ACCOUNTANT);
  await page.goto('/finance/qarzga-berilgan');
  await expect(page.getByTestId('releases-filter')).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
});

test('the warehouse manager decides nothing and is told where requests go', async ({ page }) => {
  await login(page, WAREHOUSE_MANAGER);
  await page.goto('/approvals');
  await expect(page.getByTestId('approvals-none-yours')).toBeVisible();
  await expect(page.getByTestId('approval-row')).toHaveCount(0);
});

test('the seller records a promise on his own client', async ({ page }) => {
  await login(page, SELLER);
  const clientId = await clientIdOf(page);
  await page.goto(`/finance/${clientId}`);
  const form = page.getByTestId('promise-form');
  await expect(form).toBeVisible();
  // A promise larger than the debt is refused in words and keeps the figure.
  await page.getByTestId('promise-amount').fill('999999');
  await page.getByTestId('promise-save').click();
  await expect(page.getByTestId('promise-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('promise-amount')).toHaveValue('999999');

  await page.getByTestId('promise-amount').fill('50');
  await page.getByTestId('promise-save').click();
  const open = page.getByTestId('promise-open');
  await expect(open).toBeVisible({ timeout: 15_000 });
  await expect(open).toContainText('$50.00');
  await expect(page.getByTestId('promise-progress')).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
});

test('cleanup: the seller cancels the promise and the accountant voids the charge', async ({ page }) => {
  await login(page, SELLER);
  const clientId = await clientIdOf(page);
  await page.goto(`/finance/${clientId}`);
  // Whatever an earlier test got to: a promise is cancelled only if one is open.
  if ((await page.getByTestId('promise-cancel').count()) > 0) {
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('promise-cancel').click();
  }
  await expect(page.getByTestId('promise-open')).toHaveCount(0, { timeout: 15_000 });

  await login(page, ACCOUNTANT);
  await page.goto(`/finance/${clientId}`);
  // Every live charge this spec ever posted — one per run, and a run that
  // died before its cleanup left one more.
  for (let left = await liveCharges(page).count(); left > 0; left -= 1) {
    page.once('dialog', (dialog) => void dialog.accept('qarz e2e tozalash'));
    await liveCharges(page).first().getByRole('button', { name: /✖/ }).click();
    // The action revalidates the ledger: the row greys out as voided.
    await expect(liveCharges(page)).toHaveCount(left - 1, { timeout: 15_000 });
  }
  await expect(liveCharges(page)).toHaveCount(0);
});
