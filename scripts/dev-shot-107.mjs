// Round 107 screenshots against the local standalone server on gsr_ci.
// Usage: node shot-107.mjs <outDir>
import { chromium } from '@playwright/test';

const OUT = process.argv[2] ?? '/tmp/shots';
const BASE = 'http://127.0.0.1:3000';
const OWNER = '+998900000001';
const PASSWORD = 'demo1234';

async function login(page) {
  await page.goto(BASE + '/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await page.waitForURL(BASE + '/');
}

// This container ships the FULL chromium only (the headless-shell binary
// the default headless mode wants is absent — the ritual's CI=1 footgun).
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

for (const [tag, viewport] of [
  ['360', { width: 360, height: 800 }],
  ['1280', { width: 1280, height: 800 }],
]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await login(page);

  // 1. Admin dashboard on the home screen.
  await page.goto(BASE + '/');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/dash-${tag}.png`, fullPage: viewport.width === 360 });

  // 2. The rasxod fold on /receive, opened.
  await page.goto(BASE + '/receive');
  const fold = page.getByTestId('rasxod-fold');
  if (await fold.count()) {
    await fold.locator('summary').click();
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: `${OUT}/rasxod-${tag}.png` });

  // 3. The stock crates strip.
  await page.goto(BASE + '/stock');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/stock-${tag}.png` });

  // 4. The expenses queue panel.
  await page.goto(BASE + '/accounting/expenses');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/expenses-${tag}.png` });

  // 5. Quick «+» client banner.
  await page.goto(BASE + '/stock');
  await page.getByTestId('quick-create').click();
  await page.getByTestId('quick-kind-client').click();
  await page.getByTestId('quick-name').fill('Skrinshot mijoz');
  await page.getByTestId('quick-phone').fill('+998901112233');
  await page.getByTestId('quick-save').click();
  await page.getByTestId('quick-client-made').waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${OUT}/quick-code-${tag}.png` });
  // Deactivate the screenshot client to keep the book clean.
  await page.getByTestId('quick-to-card').click();
  await page.waitForURL(/admin\/clients/);
  await page.locator('button.btn-danger').first().click();
  await page.waitForTimeout(400);

  // 6. The won dialog, mint mode, from a fresh lead's card.
  await page.goto(BASE + '/crm/leads/new');
  await page.locator('input[name="name"]').fill('Skrinshot lid');
  await page.getByTestId('save-lead').click();
  await page.waitForURL(/\/crm\/leads\//);
  await page.getByTestId('stage-fold').click();
  await page.getByTestId('stage-won').click();
  await page.getByTestId('won-dialog').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/won-dialog-${tag}.png` });
  // Confirm to also capture the result banner once (360 only), then the lead
  // is closed (won) so it leaves the board.
  await page.getByTestId('won-confirm').click();
  await page.getByTestId('won-made').waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${OUT}/won-banner-${tag}.png` });
  const code = (await page.getByTestId('won-client-code').textContent())?.trim();
  console.log(tag, 'won code:', code);
  await page.getByTestId('won-done').click();

  await ctx.close();
}

await browser.close();
console.log('done');
