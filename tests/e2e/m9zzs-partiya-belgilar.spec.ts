import { expect, test, type Page } from '@playwright/test';
import { cleanPriceIcons, leftovers, seedPriceIcons, type Seeded } from '../fixtures/partiya-belgilar';

/**
 * «Partiya moliyasi»'s two icons (0119), opened by the two people they are
 * for, at 360 px.
 *
 * What only a browser can prove: that 📈 and 🧮 open by a PRESS (a phone has
 * no hover), that the accountant reads the Готово answer marked «не
 * запечатан» beside the deal's client price, that the VED reads the same
 * answer and none of the page's money that law 4 keeps from them — no cost,
 * no margin, no client price, no upsale, and the seeded OFFER's price nowhere
 * in the page's markup — and that with BOTH folds open and a long
 * name the page is still 360 wide. The list itself, the sheet's rules and the
 * role matrix are proven in `price-history`, `deal-calc-sheet` and
 * `price-icons-matrix` (integration); the home row by `calc-link-ask` (a seal
 * is configuration for every later spec, #935, so none is made here).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const OWNER = '+998900000001';
const VED = '+998900000004';
const ACCOUNTANT = '+998900000010';
const run = Date.now().toString().slice(-6);
let batchPath = '';
let seeded: Seeded | null = null;
/**
 * What law 4 keeps from the VED on this page, as the page prints it: the
 * deal's client price (the fixture's `clientPrice`, 4321.00) and the upsale
 * the released offer makes above the 700 floor (987.65 − 700). The offer's
 * own figure is never printed here at all, so it cannot be the control.
 */
const LAW_FOUR = ['4321.00', '287.65'];

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** The seeded lot's row on the truck's «Narx» tab. */
async function openLot(page: Page) {
  await page.goto(`${batchPath}/pricing`);
  const lot = page.getByTestId('pricing-lot').filter({ hasText: seeded!.ruName.slice(0, 30) });
  await expect(lot).toHaveCount(1);
  return lot;
}

test('a truck out of YW, and on it one prixod of a deal with a Готово answer', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/batches');
  await page.selectOption('select[name="originId"]', { label: 'YW' });
  await page.selectOption('select[name="destId"]', { label: 'TAS1' });
  await page.getByTestId('create-quick-batch').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
  batchPath = new URL(page.url()).pathname;
  seeded = await seedPriceIcons(batchPath.split('/').pop()!, run);
});

test('the accountant: 📈 opens by a press to the honest empty sentence and the AI door; 🧮 shows the unsealed answer', async ({ page }) => {
  expect(batchPath).toMatch(/^\/batches\//);
  await login(page, ACCOUNTANT);
  const lot = await openLot(page);

  const history = lot.getByTestId('lot-price-history');
  await expect(history.getByTestId('price-history-none')).toBeHidden();
  await history.locator('summary').click();
  await expect(history.getByTestId('price-history-none')).toBeVisible();
  await expect(history.getByTestId('price-history-ai')).toBeVisible();

  const calc = lot.getByTestId('lot-deal-calc');
  await calc.locator('summary').click();
  const answer = calc.getByTestId('calc-answer');
  await expect(answer).toBeVisible();
  await expect(answer).toContainText('700');
  await expect(answer).toContainText('не запечатан');

  // The control: the accountant IS law 4's audience for the client price —
  // the offer's own figure is on the page and the upsale line is drawn, so
  // the VED half's absences below are absences of something that exists.
  await expect(page.getByTestId('pricing-deal-price')).toBeVisible();
  await expect(page.getByTestId('pricing-deal-upsale')).toBeVisible();
  for (const digits of LAW_FOUR) await expect(page.getByTestId('pricing-deal-price')).toContainText(digits);
});

test('the VED: 🧮 and the answer, and none of the money law 4 keeps from them', async ({ page }) => {
  expect(batchPath).toMatch(/^\/batches\//);
  await login(page, VED);
  const lot = await openLot(page);

  await expect(lot.getByTestId('lot-price-history')).toHaveCount(1);
  const calc = lot.getByTestId('lot-deal-calc');
  await calc.locator('summary').click();
  await expect(calc.getByTestId('calc-answer')).toContainText('700');

  for (const testid of [
    'pricing-deal-price',
    'pricing-deal-upsale',
    'pricing-deal-totals',
    'lot-cost',
    'pricing-total-cost',
    'pricing-total-margin',
  ]) {
    await expect(page.getByTestId(testid), testid).toHaveCount(0);
  }
  // The client price and the upsale nowhere on the page — not in the open
  // fold, not in the markup (a hidden node is still sent to the VED's browser).
  const html = await page.content();
  for (const digits of LAW_FOUR) {
    expect(html, digits).not.toContain(digits);
    expect(await calc.innerText(), digits).not.toContain(digits);
  }
});

test('at 360 px, with both folds open on a long name, the page is still 360 wide', async ({ page }) => {
  expect(batchPath).toMatch(/^\/batches\//);
  await login(page, ACCOUNTANT);
  const lot = await openLot(page);
  await lot.getByTestId('lot-price-history').locator('summary').click();
  await lot.getByTestId('lot-deal-calc').locator('summary').click();
  await expect(lot.getByTestId('calc-answer')).toBeVisible();
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
  expect(w.doc).toBeLessThanOrEqual(w.view);
  // Each summary is a 44 px press target (a thumb, not a cursor).
  const box = (await lot.getByTestId('lot-price-history').locator('summary').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
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
