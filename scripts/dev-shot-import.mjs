// Sub-round A screenshots against the local standalone server on gsr_ci.
// Usage: node scripts/dev-shot-import.mjs <outDir>
//
// It walks the whole thing the way a person does — uploads the fixture,
// waits for the parse, opens a calculation whose product matches a
// declaration, and photographs the filled row and the picker — then removes
// the import again, because a ready batch prices every later save (#183).
import { chromium } from '@playwright/test';

const OUT = process.argv[2] ?? '/tmp/shots';
const BASE = 'http://127.0.0.1:3000';
const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const FIXTURE = 'tests/fixtures/customs-import-sample.xlsx';
const CODE = '5603139000';
const GOODS = 'Нетканый материал из химических нитей в рулонах';

async function login(page) {
  await page.goto(BASE + '/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await page.waitForURL(BASE + '/');
}

const width = (page) => page.evaluate(() => document.documentElement.scrollWidth);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// ---- desktop: upload, price a row, open the picker -------------------------
const deskCtx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
});
const desk = await deskCtx.newPage();
await login(desk);

await desk.goto(BASE + '/admin/bojxona-import');
await desk.getByTestId('import-file').setInputFiles(FIXTURE);
await desk.getByTestId('import-upload').click();
await desk.getByTestId('import-ready').first().waitFor({ timeout: 60_000 });
await desk.waitForTimeout(400);
await desk.screenshot({ path: `${OUT}/import-admin-1280.png`, fullPage: true });
console.log('1280 admin width', await width(desk));

await desk.goto(BASE + '/crm');
await desk.getByTestId('quick-create').click();
const pickLead = desk.getByTestId('quick-kind-lead');
if (await pickLead.count()) await pickLead.click();
await desk.getByTestId('quick-name').fill(`Import shot ${Date.now()}`);
await desk.getByTestId('quick-save').click();
const made = desk.getByTestId('quick-made');
await made.waitFor({ timeout: 20_000 });
await desk.goto(BASE + (await made.getByRole('link').first().getAttribute('href')));

await desk.getByTestId('calc-panel').click();
await desk.getByTestId('calc-section-rastamojka').click();
await desk.getByTestId('calc-goods').fill(`${GOODS}, 100`);
await desk.getByTestId('calc-send').click();
await desk.getByTestId('calc-open').waitFor({ timeout: 20_000 });
const requestUrl = await desk.getByTestId('calc-open-link').first().getAttribute('href');

await desk.goto(BASE + requestUrl);
await desk.getByTestId('calc-table').waitFor({ timeout: 20_000 });
await desk.locator('[data-cell="weightKg"][data-row="0"]').fill('100');
await desk.locator('[data-cell="tnvedCode"][data-row="0"]').fill(CODE);
await desk.getByTestId('calc-save-table').click();
await desk.getByTestId('calc-baza-import').first().waitFor({ timeout: 20_000 });
await desk.waitForTimeout(500);
await desk.screenshot({ path: `${OUT}/import-filled-1280.png`, fullPage: true });
console.log('1280 calc width', await width(desk));

await desk.getByTestId('calc-item-menu').last().click();
await desk.getByTestId('calc-import-pick').click();
await desk.getByTestId('calc-import-candidate').first().waitFor({ timeout: 20_000 });
await desk.waitForTimeout(600);
await desk.screenshot({ path: `${OUT}/import-picker-1280.png` });

// ---- phone: the same calculation, read-only -------------------------------
const phoneCtx = await browser.newContext({
  viewport: { width: 360, height: 800 },
  deviceScaleFactor: 2,
});
const phone = await phoneCtx.newPage();
await login(phone);
await phone.goto(BASE + '/admin/bojxona-import');
await phone.getByTestId('import-ready').first().waitFor({ timeout: 20_000 });
await phone.waitForTimeout(400);
await phone.screenshot({ path: `${OUT}/import-admin-360.png`, fullPage: true });
console.log('360 admin width', await width(phone));

await phone.goto(BASE + requestUrl);
await phone.waitForTimeout(700);
await phone.screenshot({ path: `${OUT}/import-calc-360.png`, fullPage: true });
console.log('360 calc width', await width(phone));

// ---- put the import back: it is CONFIGURATION -----------------------------
await desk.goto(BASE + requestUrl);
await desk.getByTestId('calc-table').waitFor({ timeout: 20_000 });
await desk.getByTestId('calc-baza').last().fill('9');
await desk.getByTestId('calc-save-table').click();
await desk.waitForTimeout(1500);
await desk.goto(BASE + '/admin/bojxona-import');
desk.once('dialog', (d) => void d.accept());
const del = desk.getByTestId('import-delete').first();
if (await del.count()) {
  await del.click();
  await desk.waitForTimeout(1500);
}
console.log('imports left', await desk.getByTestId('import-batch').count());

await browser.close();
console.log('done');
