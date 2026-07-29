import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { expect, test } from '@playwright/test';

/**
 * Round 17 in the browser: the damage discount survives the save and shows
 * on the card, the profit panel renders for somebody with finance.reports,
 * and the goods file round-trips upload → review → confirmed lines.
 *
 * There is deliberately no ANTHROPIC_API_KEY here or in CI, so the import
 * exercises the DEGRADE path the spec demands (DEALS.md answer 6c): the file
 * parses, every good becomes its own line, grouping is manual. The AI half
 * is covered by the pure grouping post-processing and must be watched live
 * on the server. Leaves a deal on GS777 behind — data, not configuration
 * (#154/#183).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);

test('discount with a reason, profit for finance eyes, and the goods file becomes lines', async ({
  page,
}, testInfo) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // A deal of our own on the seeded client, as m9h does.
  await page.goto('/admin/clients?q=GS777');
  await page.locator('a[href^="/admin/clients/"]:not([href$="/new"])').first().click();
  await page.getByTestId('client-new-deal').click();
  await page.getByTestId('deal-title').fill(`Chegirma sinov ${runId}`);
  await page.getByTestId('deal-amount').fill('300');
  await page.getByTestId('save-deal').click();
  await expect(page).toHaveURL(/\/bitimlar\/[0-9a-f-]+$/);

  // The owner may read profit — the panel is there before any money moved.
  await expect(page.getByTestId('deal-profit-panel')).toBeVisible();

  // A discount without a reason is refused; with one it lands on the card.
  await page.getByTestId('deal-discount-panel').click();
  await page.getByTestId('discount-amount').fill('45');
  await page.getByTestId('save-discount').click();
  await expect(page.getByTestId('deal-discount-form').getByRole('alert')).toBeVisible();
  await page.getByTestId('discount-reason').fill(`shikast ${runId}`);
  await page.getByTestId('save-discount').click();
  await expect(page.getByTestId('deal-compare')).toContainText('45');
  await expect(page.getByTestId('deal-compare')).toContainText(`shikast ${runId}`);

  // The client's goods file: written here so the spec owns its fixture.
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('goods');
  sheet.addRow(['Наименование', 'Кол-во', 'Сумма']);
  sheet.addRow([`Krossovka ${runId}`, 10, 500]);
  sheet.addRow([`Futbolka ${runId}`, 20, 300]);
  sheet.addRow(['Итого', 30, 800]);
  mkdirSync(testInfo.outputPath(), { recursive: true });
  const filePath = join(testInfo.outputPath(), 'goods.xlsx');
  writeFileSync(filePath, Buffer.from(await workbook.xlsx.writeBuffer()));

  await page.getByTestId('deal-lines-panel').click();
  await page.getByTestId('import-goods-file').setInputFiles(filePath);

  // Review, not write: two goods (the «Итого» row is arithmetic), editable.
  await expect(page.getByTestId('import-review')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('import-line')).toHaveCount(2);

  await page.getByTestId('import-confirm').click();
  // The confirmed draft became the deal's real lines.
  await expect(page.getByTestId('import-review')).toHaveCount(0);
  const descriptions = page.getByTestId('line-description');
  await expect(descriptions).toHaveCount(2);
  await expect(descriptions.first()).toHaveValue(new RegExp(runId));
});
