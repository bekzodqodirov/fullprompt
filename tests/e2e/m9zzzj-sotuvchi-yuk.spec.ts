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
  }
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

test('the warehouse that typed the bill still reads it on the same card', async ({ page }) => {
  await login(page, YW_OPERATOR_PHONE);
  await page.goto(`/receipts/${minted.other.receiptId}`);
  await expect(page.getByTestId('receipt-costs')).toContainText(/772[.,]19/);
});

test('cleanup', async () => {
  const sql = database();
  try {
    expect(await cleanupAll(sql)).toBeGreaterThanOrEqual(2);
    const left = await sql`SELECT 1 FROM clients WHERE client_code LIKE ${`${run.marker}%`}`;
    expect(left).toHaveLength(0);
  } finally {
    await sql.end();
  }
});
