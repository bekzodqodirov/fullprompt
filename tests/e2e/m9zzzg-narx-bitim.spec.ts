import { expect, test, type Locator, type Page } from '@playwright/test';
import { cleanNarxBitim, leftovers, pricesOn, refile, seedNarxBitim, type NarxBitimSeed } from '../fixtures/narx-bitim';

/**
 * His Q8 «c» (2026-10-27: «logist o'zi tanlaydi»), on the truck's «Narx» tab
 * at 360 px: one client, two of his deals on one truck.
 *
 * What only a browser can prove: that the price cannot be saved before a deal
 * is chosen (the select's own `required`, before any request), that every
 * press on such a truck asks once and names the deal's part, that the second
 * deal's price is asked about as an extra bill, that a page drawn before a
 * prixod was re-filed is refused and redrawn rather than answered, that the
 * VED is asked the same question with none of the deals' quotes in the page,
 * and that all of it fits 360 px. The rule itself is proven in
 * `truck-price-deal` (integration) and `pricing-view` (unit).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const OWNER = '+998900000001';
const VED = '+998900000004';
const ACCOUNTANT = '+998900000010';
const run = Date.now().toString().slice(-6);
let batchPath = '';
let batchId = '';
let seeded: NarxBitimSeed | null = null;

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function openCard(page: Page): Promise<Locator> {
  await page.goto(`${batchPath}/pricing`);
  const card = page.getByTestId('pricing-client').filter({ hasText: seeded!.clientCode });
  await expect(card).toHaveCount(1);
  return card;
}

const submit = (card: Locator) => card.getByTestId('pricing-form').locator('button[type="submit"]');

test('a truck out of YW, and on it one client with two deals', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/batches');
  await page.selectOption('select[name="originId"]', { label: 'YW' });
  await page.selectOption('select[name="destId"]', { label: 'TAS1' });
  await page.getByTestId('create-quick-batch').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
  batchPath = new URL(page.url()).pathname;
  batchId = batchPath.split('/').pop()!;
  seeded = await seedNarxBitim(batchId, run);
});

test('the price waits for a choice: the deals only (no «bitimsiz» — every carton has a deal), and no press goes out', async ({ page }) => {
  expect(seeded).not.toBeNull();
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  const select = card.getByTestId('truck-deal-select');
  await expect(select).toBeVisible();
  // The placeholder and the two deals; «bitimsiz» would be option (a).
  await expect(select.locator('option')).toHaveCount(3);
  await expect(select.locator('option[value="none"]')).toHaveCount(0);
  for (const deal of seeded!.deals) await expect(select.locator(`option[value="${deal.id}"]`)).toContainText(deal.code);

  await card.locator('input[name="amount"]').fill('500');
  await submit(card).click();
  // The browser refuses the press itself: nothing asked, nothing sent.
  expect(await select.evaluate((el) => (el as HTMLSelectElement).validity.valueMissing)).toBe(true);
  await expect(card.getByTestId('pricing-deviation')).toHaveCount(0);
  expect(await pricesOn(batchId, seeded!.clientId)).toHaveLength(0);
});

test('choosing the second deal writes the price to it, after one question that names its part', async ({ page }) => {
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  const [first, second] = seeded!.deals;
  await card.getByTestId('truck-deal-select').selectOption(second!.id);
  await expect(card.getByTestId('truck-deal-line')).toContainText(second!.code);
  await card.locator('input[name="amount"]').fill('500');
  await submit(card).click();
  const alert = card.getByTestId('pricing-deviation');
  await expect(alert).toBeVisible();
  await expect(alert.getByTestId('pricing-deal-ask')).toContainText(second!.code);
  // The accountant's 5 % check compares with THAT deal's part here: 6543.21 × 2/3.
  await expect(alert).toContainText('4362.14');
  // The control for the VED's half below: the quotes ARE in the owner-side page.
  expect(await page.content()).toContain('6543.21');
  await alert.getByTestId('pricing-deviation-confirm').click();
  await expect(submit(card)).toHaveText('✅', { timeout: 15_000 });

  expect((await pricesOn(batchId, seeded!.clientId)).map((row) => row.dealId)).toEqual([second!.id]);
  // Where it went, and which of his deals here still has no price.
  const here = card.getByTestId('pricing-priced-here');
  await expect(here.getByTestId('pricing-priced-here-row')).toContainText(second!.code);
  await expect(here.getByTestId('pricing-priced-here-missing')).toContainText(first!.code);
  // The next price is chosen again, never carried over.
  expect(await card.getByTestId('truck-deal-select').inputValue()).toBe('');
});

test('the first deal’s price is asked about as an extra bill on this truck', async ({ page }) => {
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  const [first, second] = seeded!.deals;
  await card.getByTestId('truck-deal-select').selectOption(first!.id);
  await card.locator('input[name="amount"]').fill('300');
  await submit(card).click();
  const alert = card.getByTestId('pricing-deviation');
  await expect(alert.getByTestId('pricing-priced-here-ask')).toContainText(`$500.00 → ${second!.code}`);
  await alert.getByTestId('pricing-deviation-confirm').click();
  await expect(submit(card)).toHaveText('✅', { timeout: 15_000 });
  expect((await pricesOn(batchId, seeded!.clientId)).map((row) => row.dealId)).toEqual([second!.id, first!.id]);
  await expect(card.getByTestId('pricing-priced-here-missing')).toHaveCount(0);
});

test('the VED is asked the same question, with none of the deals’ quotes in the page — and it fits 360 px', async ({ page }) => {
  await login(page, VED);
  const card = await openCard(page);
  await expect(card.getByTestId('truck-deal-select').locator('option')).toHaveCount(3);
  const html = await page.content();
  for (const deal of seeded!.deals) expect(html, deal.quote).not.toContain(deal.quote);
  expect(html).not.toContain('4362.14');
  await card.getByTestId('truck-deal-select').selectOption(seeded!.deals[0]!.id);
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
  expect(w.view).toBe(360);
  expect(w.doc).toBeLessThanOrEqual(w.view);
});

test('a page drawn before a prixod was re-filed is refused and redrawn — never answered for the person', async ({ page }) => {
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  const [first, second] = seeded!.deals;
  await card.getByTestId('truck-deal-select').selectOption(first!.id);
  // The first deal's prixod moves onto the second while the page is open.
  await refile(first!.receiptId, second!.id);
  await card.locator('input[name="amount"]').fill('10');
  await submit(card).click();
  await card.getByTestId('pricing-deviation').getByTestId('pricing-deviation-confirm').click();
  await expect(card.getByTestId('pricing-form-error')).toHaveAttribute('data-error', 'deals_changed', { timeout: 15_000 });
  // Redrawn: the truck carries one deal of his now, so nobody is asked.
  await expect(card.getByTestId('truck-deal-select')).toHaveCount(0, { timeout: 15_000 });
  await expect(card.getByTestId('pricing-to-deal')).toContainText(second!.code);
  expect(await pricesOn(batchId, seeded!.clientId)).toHaveLength(2);
});

test('cleanup: the seed and its prices are gone and the truck is cancelled', async ({ page }) => {
  expect(batchPath).toMatch(/^\/batches\//);
  if (seeded) {
    await cleanNarxBitim(seeded);
    expect(await leftovers(seeded)).toBe(0);
  }
  await login(page, OWNER);
  await page.goto(batchPath);
  await page.getByTestId('cancel-batch').click();
  await page.locator('#cancel-reason').fill(`narx bitim sinov ${run}`);
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('cancel-batch-confirm').click();
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0, { timeout: 15_000 });
});
