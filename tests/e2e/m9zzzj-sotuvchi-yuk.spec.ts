import 'dotenv/config';
import { expect, test } from '@playwright/test';
import { BILL, QUOTE, SELLER_PHONE, YW_OPERATOR_PHONE, cleanupAll, database, mint, newRun, type Minted } from './sotuvchi-yuk-fixture';
import { login } from './prixod-xabari-landing';

/**
 * The sellers see where the cargo is (2026-11-18, his «sotuvchilarga ham
 * skladdagi yuklarni korishga ruxsat ochib berish kerak furalarga va
 * skladlarni korishga ruxsat kerak», answered «hammasi sening taklifing»):
 * Ostatka, the board, the trucks and the map are in the seller's menu and
 * open to him — every client's cargo (1a) — while a prixod's bills stay with
 * the people who enter or read costs (4a), and a colleague's prixod draws him
 * no «Bitim» cell to move it with (the design judge's LEAK-1).
 *
 * The server is the oracle for the doors; the page's own TEXT and its PAYLOAD
 * are searched for the two figures nobody prints (the deal quote, the bill),
 * because a client component is handed everything it is given.
 */

test.describe.configure({ mode: 'serial' });

const run = newRun();
let minted: Minted;

test('mint a client of his and a colleague’s, each with a prixod, a deal and a bill', async () => {
  const sql = database();
  try {
    await cleanupAll(sql);
    minted = await mint(sql, run);
  } finally {
    await sql.end();
  }
});

test('his menu draws Ostatka, the board, the trucks and the map, and each one opens', async ({ page }) => {
  await login(page, SELLER_PHONE);
  for (const href of ['/stock', '/batches', '/trucks', '/map', '/transit']) {
    const response = await page.goto(href);
    expect(response?.status(), href).toBe(200);
    await expect(page, href).toHaveURL(new RegExp(`${href.replace('/', '\\/')}(\\?.*)?$`));
    // The MENU, not only the door: the phone's «•••» sheet draws the page —
    // its workspace's card or its page chip — only when the seller's menu
    // offers it (a page that opens by address and is in no menu passes the
    // lines above; the as-built review, E2E-1).
    await page.getByTestId('more-button').click();
    await expect(page.getByTestId('more-sheet').locator(`a[href="${href}"]`).first(), href).toBeVisible();
  }
  // A hand-typed or cut address reads as the list, never an error page (SEL-6).
  for (const href of ['/stock?client=GS777', '/stock?lot=nope', '/stock?wh=YW']) {
    expect((await page.goto(href))?.status(), href).toBe(200);
  }
  expect((await page.request.get('/api/reports/stock?wh=YW')).status()).toBe(200);
  // Every client's cargo — the colleague's too (1a).
  await page.goto(`/stock?q=${run.marker}`);
  await expect(page.locator('main')).toContainText(`${run.marker}O`);
  await expect(page.locator('main')).toContainText(`${run.marker}M`);
});

test('a colleague’s prixod: the cargo, and no deal cell, no bill, no quote in the page', async ({ page }) => {
  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${minted.other.receiptId}`);
  await expect(page.getByTestId('receipt-lots')).toContainText(`Sotuvchi yuk OTHER`);
  await expect(page.getByTestId('receipt-deal-block')).toHaveCount(0);
  await expect(page.getByTestId('receipt-costs')).toHaveCount(0);
  const html = await page.content();
  expect(html).not.toContain(QUOTE.OTHER);
  expect(html).not.toContain(BILL.OTHER);
  expect(html).not.toContain(minted.other.dealCode);
});

test('his own prixod: the deal cell to work with — still no bill, and no quote in its payload', async ({ page }) => {
  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${minted.mine.receiptId}`);
  await expect(page.getByTestId('receipt-deal-block')).toContainText(minted.mine.dealCode);
  await expect(page.getByTestId('receipt-costs')).toHaveCount(0);
  const html = await page.content();
  // The cell is a client component: what it is handed is in the page. It is
  // handed {id, code, title, cargo} and never the deal row.
  expect(html).not.toContain(QUOTE.MINE);
  expect(html).not.toContain(BILL.MINE);
});

test('a colleague’s client’s prixod on a deal HE owns: the cell is his to work with', async ({ page }) => {
  // Only the deal's owner makes this prixod his — the client and the stamp are
  // the colleague's (the as-built review, FENCE-2: the card's fact, in a browser).
  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${minted.hisDeal.receiptId}`);
  await expect(page.getByTestId('receipt-deal-block')).toContainText(minted.hisDeal.dealCode);
  await expect(page.getByTestId('receipt-costs')).toHaveCount(0);
});

test('a colleague’s client’s LOOSE prixod: the cell offers his deal and only his — and files it there', async ({ page }) => {
  // The rule's last clause on the card (the as-built review, EE-1): no «— uzish»
  // to save, no «+ Yangi bitim», and the colleague's deal is not even named.
  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${minted.loose.receiptId}`);
  const cell = page.getByTestId('receipt-deal-block');
  await expect(cell).toBeVisible();
  const pick = page.getByTestId('receipt-deal-pick');
  await expect(pick.locator('option', { hasText: minted.loose.dealCode })).toHaveCount(1);
  await expect(pick.locator('option', { hasText: minted.loose.theirDealCode })).toHaveCount(0);
  expect(await page.content()).not.toContain(minted.loose.theirDealCode);
  await expect(page.getByTestId('receipt-deal-new')).toHaveCount(0);
  await expect(page.getByTestId('receipt-deal-save')).toHaveCount(0);
  // The server takes the one move it was offered.
  const value = await pick.locator('option', { hasText: minted.loose.dealCode }).getAttribute('value');
  await pick.selectOption(value!);
  await page.getByTestId('receipt-deal-save').click();
  await expect(cell.locator(`a[href^="/bitimlar/"]`)).toHaveText(minted.loose.dealCode);
});

test('the warehouse that typed the bill still reads it on the same card', async ({ page }) => {
  await login(page, YW_OPERATOR_PHONE);
  await page.goto(`/receipts/${minted.other.receiptId}`);
  await expect(page.getByTestId('receipt-costs')).toContainText(/772[.,]19/);
});

test('cleanup', async () => {
  const sql = database();
  try {
    expect(await cleanupAll(sql)).toBeGreaterThanOrEqual(4);
    const left = await sql`SELECT 1 FROM clients WHERE client_code LIKE ${`${run.marker}%`}`;
    expect(left).toHaveLength(0);
  } finally {
    await sql.end();
  }
});
