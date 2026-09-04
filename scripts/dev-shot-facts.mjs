// The cargo-facts door, in a browser. Usage: node scripts/dev-shot-facts.mjs <outDir>
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// The phone cannot OPEN a request (the bot panel's section chips are desktop
// only), so the desktop pass makes one and the phone pass reads it.
let sharedUrl = null;

for (const [tag, viewport] of [
  ['1280', { width: 1280, height: 900 }],
  ['360', { width: 360, height: 800 }],
]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await login(page);

  if (sharedUrl) {
    await page.goto(BASE + sharedUrl);
    await page.getByTestId('calc-facts').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/facts-filled-${tag}.png`, fullPage: true });
    console.log(tag, 'width', await page.evaluate(() => document.documentElement.scrollWidth));
    await ctx.close();
    continue;
  }

  // A request with NO weight and NO volume — exactly his case.
  await page.goto(BASE + '/crm');
  await page.getByTestId('quick-create').click();
  const pick = page.getByTestId('quick-kind-lead');
  if (await pick.count()) await pick.click();
  await page.getByTestId('quick-name').fill(`Facts shot ${tag} ${Date.now()}`);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await made.waitFor({ timeout: 20_000 });
  await page.goto(BASE + (await made.getByRole('link').first().getAttribute('href')));

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-podklyuch').click();
  await page.getByTestId('calc-goods').fill('Plitka keramik, 100');
  await page.getByTestId('calc-send').click();
  await page.getByTestId('calc-open').waitFor({ timeout: 20_000 });
  const url = await page.getByTestId('calc-open-link').first().getAttribute('href');

  await page.goto(BASE + url);
  await page.getByTestId('calc-facts').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/facts-empty-${tag}.png`, fullPage: true });
  console.log(tag, 'width', await page.evaluate(() => document.documentElement.scrollWidth));

  // Type them, exactly as the VED would.
  await page.getByTestId('calc-fact-from').fill('Guangzhou');
  await page.getByTestId('calc-fact-to').fill('Toshkent');
  await page.getByTestId('calc-fact-weight').fill('812.5');
  await page.getByTestId('calc-fact-volume').fill('4.25');
  await page.getByTestId('calc-facts-save').click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/facts-filled-${tag}.png`, fullPage: true });
  const missing = await page.getByTestId('calc-checklist').innerText();
  console.log(tag, 'checklist after:', JSON.stringify(missing.slice(0, 120)));
  sharedUrl = url;
  await ctx.close();
}

await browser.close();
console.log('done');
