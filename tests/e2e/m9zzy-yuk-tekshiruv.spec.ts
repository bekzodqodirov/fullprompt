import ExcelJS from 'exceljs';
import { expect, test, type Page } from '@playwright/test';
import { cleanup, cleanupEarlier, database, mint, newRun, type Minted } from './yuk-tekshiruv-fixture';

/**
 * «Yuk ma'lumoti tekshirildi» in a real browser (docs/YUK-TEKSHIRUV.md): the
 * owner's worklist — the logist opens Ostatka on «❓ Tekshirilmagan», taps the
 * chip on a row, rings the client from the prixod card, presses «✅ To'g'ri»,
 * and one tap brings him back to the list without the row. Then the plan
 * editor's filter that never touches the plan, the XLSX that is the screen,
 * a rename that turns the ✅ into ⚠, and the warehouse that reads but cannot
 * tick. The rules underneath are proven in
 * tests/integration/lot-check.integration.test.ts.
 *
 * The prixod is this spec's own (yuk-tekshiruv-fixture.ts); the last TEST
 * deletes it and proves nothing carries the marker (round 57's `afterAll` lie).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const LOGIST = '+998900000003';
const YW_OPERATOR = '+998900000006';
const SHOTS = 'test-results';
const run = newRun();
let minted: Minted | null = null;

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const code = () => `${run.marker}-A`;
/** The stock table's row for this spec's lot (the code cell starts with it). */
const stockRow = (page: Page) => page.locator('table tbody tr', { hasText: code() });

async function widths(page: Page) {
  return page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
}

test('mint: 10 cartons of «klaviatura» on the shelf in a Chinese warehouse', async () => {
  const sql = database();
  try {
    await cleanupEarlier(sql);
    minted = await mint(sql, run);
  } finally {
    await sql.end();
  }
});

test('the worklist: ❓ on the row, the chip opens the lot, ✅ To\'g\'ri, one tap back and the row is gone', async ({ page }) => {
  await login(page, LOGIST);
  // The home row is the door to exactly this filter.
  await expect(page.getByTestId('logist-flow-unchecked')).toHaveAttribute('href', '/stock?tek=yoq');

  await page.goto(`/stock?q=${run.marker}&tek=yoq`);
  await expect(page.getByTestId('stock-check-no')).toHaveAttribute('aria-current', 'true');
  const row = stockRow(page);
  await expect(row).toHaveCount(1);
  const chip = row.getByTestId('lot-check-chip');
  await expect(chip).toHaveAttribute('data-state', 'none');
  // The chip is a sibling of the code's link, never inside it (an <a> in an <a>).
  expect(await chip.evaluate((el) => el.parentElement?.closest('a') === null)).toBe(true);
  const { client, scroll } = await widths(page);
  expect(scroll).toBeLessThanOrEqual(client);
  await page.screenshot({ path: `${SHOTS}/yuk-tekshiruv-stock-360.png`, fullPage: true });

  await chip.click();
  await expect(page).toHaveURL(new RegExp(`/receipts/${minted!.receiptId}\\?qaytish=`));
  const panel = page.locator(`#lot-${minted!.lotId}`).getByTestId('lot-check');
  await expect(panel).toHaveAttribute('data-state', 'none');
  await expect(panel.getByTestId('lot-check-face-none')).toBeVisible();
  // The client's phone, to ring (📞) or write (💬).
  await expect(panel.getByTestId('lot-check-phones')).toContainText('+998901112233');
  await expect(panel.getByTestId('lot-check-phones').locator('a[href^="https://t.me/+998901112233"]')).toHaveCount(1);
  await panel.getByTestId('lot-check-note').fill('mijoz telefonda tasdiqladi');
  await panel.getByTestId('lot-check-yes').click();
  await expect(panel.getByTestId('lot-check-face-person')).toBeVisible();
  await expect(panel.getByTestId('lot-check-face-person')).toContainText('mijoz telefonda tasdiqladi');
  await expect(panel).toHaveAttribute('data-state', 'checked');
  const card = await widths(page);
  expect(card.scroll).toBeLessThanOrEqual(card.client);
  await page.screenshot({ path: `${SHOTS}/yuk-tekshiruv-card-360.png`, fullPage: true });

  // One tap back to the filtered list — and the row is no longer on it.
  await page.getByRole('link', { name: /^←/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/stock\\?.*tek=yoq`));
  await expect(stockRow(page)).toHaveCount(0);
});

test('✅ Tekshirilgan lists it; the filter survives 🔍 and a sort click; the XLSX is the screen', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto(`/stock?q=${run.marker}&tek=ha`);
  await expect(stockRow(page).getByTestId('lot-check-chip')).toHaveAttribute('data-state', 'checked');
  await page.locator('form[method="get"] button[type="submit"]').click();
  await expect(page).toHaveURL(/tek=ha/);
  await page.locator('thead th a').first().click();
  await expect(page).toHaveURL(/tek=ha/);
  await expect(stockRow(page)).toHaveCount(1);

  const res = await page.request.get(`/api/reports/stock?q=${run.marker}&tek=ha`);
  expect(res.status()).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await res.body()) as unknown as ExcelJS.Buffer);
  const sheet = wb.worksheets[0]!;
  const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
  const at = header.findIndex((h) => /Проверка|Tekshiruv|Checked|核对/.test(h));
  expect(at).toBeGreaterThan(0);
  expect(String(sheet.getRow(2).getCell(at).value)).toContain('✅');
  expect(sheet.rowCount).toBe(2);
});

test('the plan editor: the filter narrows what is DRAWN, a ticked row it hides is still planned', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto('/plans/new');
  await page.getByTestId('plan-origin').selectOption({ label: 'YW' });
  const row = page.locator('#plan-stock-table tbody tr', { hasText: code() });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('lot-check-chip')).toHaveAttribute('data-state', 'checked');

  await page.getByTestId('plan-check-filter-yes').click();
  await expect(row).toHaveCount(1);
  await row.locator('input').fill('10');
  await expect(page.getByText('Σ 10 📦')).toBeVisible();
  await page.getByTestId('plan-check-filter-no').click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('plan-check-hidden')).toBeVisible();
  await expect(page.getByText('Σ 10 📦')).toBeVisible();
  await page.getByTestId('plan-check-filter-all').click();
  await expect(row).toHaveCount(1);
});

test('a rename after the check: ⚠ on the list and on the card, naming what moved; the logist takes it back', async ({ page }) => {
  const sql = database();
  try {
    await sql`UPDATE receipt_lots SET product_name_ru = 'Мышь' WHERE id = ${minted!.lotId}`;
  } finally {
    await sql.end();
  }
  await login(page, LOGIST);
  await page.goto(`/stock?q=${run.marker}&tek=yoq`);
  await expect(stockRow(page).getByTestId('lot-check-chip')).toHaveAttribute('data-state', 'stale');
  await page.goto(`/receipts/${minted!.receiptId}`);
  const panel = page.locator(`#lot-${minted!.lotId}`).getByTestId('lot-check');
  await expect(panel.getByTestId('lot-check-face-stale')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByTestId('lot-check-undo').click();
  await expect(panel).toHaveAttribute('data-state', 'none');
});

test('the warehouse reads the face and cannot tick', async ({ page }) => {
  await login(page, YW_OPERATOR);
  await page.goto(`/receipts/${minted!.receiptId}`);
  const panel = page.locator(`#lot-${minted!.lotId}`).getByTestId('lot-check');
  await expect(panel.getByTestId('lot-check-face-none')).toBeVisible();
  await expect(panel.getByTestId('lot-check-yes')).toHaveCount(0);
  await expect(panel.getByTestId('lot-check-phones')).toHaveCount(0);
});

test('cleanup: nothing carries the marker', async () => {
  const sql = database();
  try {
    expect(await cleanup(sql, run)).toBe(0);
  } finally {
    await sql.end();
  }
});
