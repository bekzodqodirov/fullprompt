import { expect, test, type Page } from '@playwright/test';
import { cleanPriceIcons, leftovers, seedPriceIcons, type Seeded } from '../fixtures/partiya-belgilar';

/**
 * The two icons (0119) at 1280×900. On a desk the strip sits under the lot's
 * row and an OPEN fold takes the whole width of the row (`open:basis-full`)
 * — a body beside its 44 px icon would be a column two words wide. The phone
 * half, the people and the money law are `m9zzs-partiya-belgilar.spec.ts`.
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const OWNER = '+998900000001';
const ACCOUNTANT = '+998900000010';
const run = `D${Date.now().toString().slice(-5)}`;
let batchPath = '';
let seeded: Seeded | null = null;

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('a truck out of YW with one seeded prixod', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/batches');
  await page.selectOption('select[name="originId"]', { label: 'YW' });
  await page.selectOption('select[name="destId"]', { label: 'TAS1' });
  await page.getByTestId('create-quick-batch').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
  batchPath = new URL(page.url()).pathname;
  seeded = await seedPriceIcons(batchPath.split('/').pop()!, run);
});

test('an open fold takes the row\'s whole width, and the page stays the viewport\'s', async ({ page }) => {
  expect(batchPath).toMatch(/^\/batches\//);
  await login(page, ACCOUNTANT);
  await page.goto(`${batchPath}/pricing`);
  const lot = page.getByTestId('pricing-lot').filter({ hasText: seeded!.ruName.slice(0, 30) });
  await expect(lot).toHaveCount(1);
  const strip = lot.getByTestId('lot-icons');
  const calc = lot.getByTestId('lot-deal-calc');
  await calc.locator('summary').click();
  await expect(calc.getByTestId('calc-answer')).toBeVisible();
  const [stripBox, calcBox] = [(await strip.boundingBox())!, (await calc.boundingBox())!];
  expect(calcBox.width).toBeGreaterThan(stripBox.width - 2);
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
  expect(w.doc).toBeLessThanOrEqual(w.view);
});

test('cleanup: the seed is gone and the truck is cancelled', async ({ page }) => {
  expect(batchPath).toMatch(/^\/batches\//);
  if (seeded) {
    await cleanPriceIcons(seeded);
    expect(await leftovers(seeded)).toBe(0);
  }
  await login(page, OWNER);
  await page.goto(batchPath);
  await page.getByTestId('cancel-batch').click();
  await page.locator('#cancel-reason').fill(`belgilar sinov ${run}`);
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('cancel-batch-confirm').click();
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0, { timeout: 15_000 });
});
