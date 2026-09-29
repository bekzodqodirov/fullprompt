import { expect, test, type Page } from '@playwright/test';
import { database } from './chegara-fixture';
import { mintFifoJobs, sweepFifoJobs } from './upsale-fifo-fixture';

/**
 * His 3a on /upsale: the seller's share waits on the KPI's paid-cargo rule,
 * the client's money settling the OLDEST debt first. One client of Dilnoza's,
 * two jobs: A charged a month ago, B today, $1300 paid today with no deal —
 * so A is «To'lashga tayyor» and B «Yuki to'lanmagan», and B says how much
 * opens it. The old rule (the client's balance) held both.
 *
 * NEVER presses pay: a payout is money every later spec would read. The
 * fixture is swept by its NAME in the last test (#523), and that sweep is a
 * TEST, not an afterAll (round 57's lie).
 */

const PASSWORD = 'demo1234';
const OWNER = '+998900000001';
const SELLER = '+998900000009';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test.describe.configure({ mode: 'serial' });

let offerA = '';
let offerB = '';

test('mint: two jobs of one client, the older one paid by the only money', async () => {
  const sql = database();
  try {
    ({ offerA, offerB } = await mintFifoJobs(sql));
  } finally {
    await sql.end();
  }
  expect(offerA).not.toBe('');
  expect(offerB).not.toBe('');
});

test('the owner at desktop width: A is ready, B waits and says how much opens it', async ({ page }) => {
  expect(offerA, 'the mint ran').not.toBe('');
  // The table is `hidden md:block`: the width BEFORE login (m9zzs's precedent).
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, OWNER);
  await page.goto('/upsale?dan=2020-01-01');

  const rowA = page.locator(`[data-testid="upsale-tr"][data-offer="${offerA}"]`);
  const rowB = page.locator(`[data-testid="upsale-tr"][data-offer="${offerB}"]`);
  await expect(rowA.getByTestId('upsale-state')).toHaveAttribute('data-state', 'payable');
  await expect(rowB.getByTestId('upsale-state')).toHaveAttribute('data-state', 'awaiting_payment');
  await expect(rowB.getByTestId('upsale-fifo-hint')).toBeVisible();
  await expect(rowB.getByTestId('upsale-fifo-hint')).toContainText('$1300.00');
  await expect(page.getByTestId('upsale-rule')).toBeVisible();

  // The pay list ticks what is payable NOW, and nothing else (R11).
  const fold = page.getByTestId('upsale-pay-fold');
  await fold.locator('summary').click();
  await expect(fold.locator(`[data-testid="upsale-pay-row"][data-offer="${offerA}"]`)).toHaveCount(1);
  await expect(fold.locator(`[data-testid="upsale-pay-row"][data-offer="${offerB}"]`)).toHaveCount(0);
});

test('the seller at 360: her own client’s money is hers to read, the floor never', async ({ page }) => {
  expect(offerA, 'the mint ran').not.toBe('');
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, SELLER);
  await page.goto('/upsale?dan=2020-01-01');

  const rowA = page.locator(`[data-testid="upsale-row"][data-offer="${offerA}"]`);
  const rowB = page.locator(`[data-testid="upsale-row"][data-offer="${offerB}"]`);
  await expect(rowA.getByTestId('upsale-state')).toHaveAttribute('data-state', 'payable');
  await expect(rowB.getByTestId('upsale-state')).toHaveAttribute('data-state', 'awaiting_payment');
  // Rule 10: the client's card names her, so the sum that opens B is hers.
  await expect(rowB.getByTestId('upsale-fifo-hint')).toBeVisible();
  await expect(rowB.getByTestId('upsale-fifo-hint')).toContainText('$1300.00');
  // «Tannarx korinmasin sotuvchiga»: the $1000 floor is printed nowhere.
  await expect(rowA).not.toContainText('$1000.00');
  await expect(rowB).not.toContainText('$1000.00');

  // A wider document makes a phone zoom the whole page out (#400).
  const { doc, view } = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(doc).toBeLessThanOrEqual(view);
});

test('cleanup: every run’s jobs swept by their name, nothing left', async () => {
  const sql = database();
  try {
    expect(await sweepFifoJobs(sql)).toEqual({ clients: 0, offers: 0 });
  } finally {
    await sql.end();
  }
});
