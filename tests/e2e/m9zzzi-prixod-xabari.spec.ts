import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import { SELLER_PHONE, cleanupAll, database, mint, newRun } from './prixod-xabari-fixture';

/**
 * «🔗 Bitim biriktirish» — where the seller's Telegram button lands, in a
 * browser (the owner, 2026-11-11: «bitim qoshishni bosganda usha prixodni
 * ichiga kirib bitim qayi bitimligini tanlash imkoni bolsin»;
 * docs/PRIXOD-XABARI.md §C.7).
 *
 * What only a browser can prove: `/receipts/<id>#bitim` opens a long card AT
 * its deal block, on a phone, under the sticky bar; a client with no deal is
 * offered «+ Yangi bitim ochish», and the deal opened from there is BORN with
 * the prixod on it — the seller is back on the cargo, not left on a new deal
 * with the prixod still on none; a seller takes back a file THEY sent (the
 * bot's «📎 Fayl qo‘shish» puts files here) and nobody else's; the VED, who
 * may re-file cargo but not open a deal, is not offered the link.
 *
 * The message, its recipients and the file collection are the integration
 * files' — the Telegram half has no e2e: CI has no bot.
 *
 * Sorts after m9zzzh-* («h» < «i»). Its OWN client, prixod and deal
 * (prixod-xabari-fixture.ts), deleted by a cleanup TEST (#523).
 */

test.describe.configure({ mode: 'serial' });

const VED = '+998900000004';
const DEMO_PASSWORD = 'demo1234';

const run = newRun();
let receiptId = '';
let clientId = '';
let number = '';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function fits(page: Page) {
  const w = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(w.scroll).toBeLessThanOrEqual(w.client);
}

test('mint the client, its prixod and the two files', async () => {
  const sql = database();
  try {
    await cleanupAll(sql);
    ({ receiptId, clientId, number } = await mint(sql, run));
  } finally {
    await sql.end();
  }
  expect(receiptId).not.toBe('');
});

test('the button’s address opens the card AT the deal block, and offers a new deal to a client that has none', async ({ page }) => {
  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${receiptId}#bitim`);
  const block = page.getByTestId('receipt-deal-block');
  await expect(block).toBeVisible();
  // ON the screen, below the sticky app bar — not somewhere down a long card.
  await expect
    .poll(async () => {
      const box = await block.boundingBox();
      const height = page.viewportSize()!.height;
      return box !== null && box.y >= 40 && box.y < height * 0.6;
    })
    .toBe(true);
  await expect(page.getByTestId('receipt-deal-pick')).toBeVisible();
  await expect(page.getByTestId('receipt-deal-new')).toBeVisible();
  await fits(page);
});

test('«+ Yangi bitim ochish»: the deal is born with the prixod on it, and the seller is back on the cargo', async ({ page }) => {
  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${receiptId}#bitim`);
  await page.getByTestId('receipt-deal-new').click();
  await expect(page).toHaveURL(new RegExp(`/bitimlar/new\\?client=${clientId}&prixod=${receiptId}$`));
  await expect(page.getByTestId('deal-form-receipt')).toContainText(number);
  await page.locator('input[name="title"]').fill(`Xabar bitimi ${run.marker}`);
  await page.getByTestId('deal-form').locator('button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`/receipts/${receiptId}#bitim$`));
  const block = page.getByTestId('receipt-deal-block');
  await expect(block.locator('a[href^="/bitimlar/"]').first()).toHaveText(/^B-\d+$/);
  // A prixod that has its deal is not offered another.
  await expect(page.getByTestId('receipt-deal-new')).toHaveCount(0);
  await fits(page);

  const sql = database();
  try {
    const rows = await sql<{ code: string; client_id: string }[]>`
      SELECT d.code, d.client_id FROM receipts r JOIN deals d ON d.id = r.deal_id WHERE r.id = ${receiptId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client_id).toBe(clientId);
  } finally {
    await sql.end();
  }
});

test('a seller takes back the file THEY put on the prixod — and nobody else’s', async ({ page }) => {
  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${receiptId}`);
  const mine = page.locator(`a[title="seller-${run.marker}.pdf"]`);
  const office = page.locator(`a[title="office-${run.marker}.pdf"]`);
  await expect(mine).toBeVisible();
  await expect(office).toBeVisible();
  // One ✕ in the files panel: the seller holds no `receipts.edit`, so the
  // office's file carries none — and neither does an upload tile.
  await expect(mine.locator('xpath=..').getByRole('button', { name: '✕' })).toHaveCount(1);
  await expect(office.locator('xpath=..').getByRole('button', { name: '✕' })).toHaveCount(0);
  await mine.locator('xpath=..').getByRole('button', { name: '✕' }).click();
  await expect(mine).toHaveCount(0);
  await expect(office).toBeVisible();
  await page.reload();
  await expect(page.locator(`a[title="seller-${run.marker}.pdf"]`)).toHaveCount(0);
  await expect(page.locator(`a[title="office-${run.marker}.pdf"]`)).toBeVisible();
});

test('the VED may re-file the cargo but not open a deal: the block, without the link', async ({ page }) => {
  const sql = database();
  try {
    // Back to «no deal», so the link WOULD be drawn for whoever may use it.
    await sql`UPDATE receipts SET deal_id = NULL WHERE id = ${receiptId}`;
  } finally {
    await sql.end();
  }
  await login(page, VED);
  await page.goto(`/receipts/${receiptId}#bitim`);
  await expect(page.getByTestId('receipt-deal-block')).toBeVisible();
  await expect(page.getByTestId('receipt-deal-new')).toHaveCount(0);
});

test('cleanup — nothing of this spec is left for the next one', async () => {
  const sql = database();
  try {
    expect(await cleanupAll(sql)).toEqual({ clients: 0, receipts: 0, deals: 0 });
  } finally {
    await sql.end();
  }
});
