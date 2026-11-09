import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  LONG_GOODS,
  cleanNarxBitim,
  leftovers,
  priceBehindTheScreen,
  pricesOn,
  refile,
  retireTruck,
  seedNarxBitim,
  type NarxBitimSeed,
} from '../fixtures/narx-bitim';

/**
 * The truck's «Narx» tab at 360 px for a client with TWELVE deals on one
 * truck and some cargo with none (the owner, 2026-11-08, his 1a-3a: «1
 * mashinada 1 clientda 10 15 ta prixoda va har birida bitim bolsa narx
 * berishda faqat 1 dona bitim tanlaydigan bolib qolgan»; docs/NARX-VA-RAQAM.md
 * §1 + §3.1). One row per deal and «Bitimsiz», one «Saqlash».
 *
 * What only a browser can prove: that the accountant's rows arrive pre-filled
 * with each deal's own part and the VED's empty, with no quote anywhere in his
 * page; that a save with blank rows writes only the filled ones and keeps the
 * emptied rows empty; that a row whose deal is already priced here asks
 * «qo'shimcha hisob» for THAT row and a deal with nothing here is never called
 * an extra bill (the false line this round removes); that a page drawn before
 * a prixod was re-filed — or before somebody else priced the truck — is
 * refused and redrawn with the typed figure kept on its own deal; that the
 * refusal sentence survives the redraw turning the table into the single
 * form; and that all of it fits 360 px with a 44-character unbroken goods
 * name. The rules are proven in `truck-price-table` / `truck-price-deal`
 * (integration) and `truck-deal-parts` / `truck-price-prefill` (unit).
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

// A failed test skips every later one in serial mode, the UI cancel included:
// the seed and the truck must not become the next spec's input (#154).
test.afterAll(async () => {
  try {
    if (seeded) await cleanNarxBitim(seeded);
  } finally {
    if (batchId) await retireTruck(batchId);
  }
});

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

const row = (card: Locator, key: string) => card.locator(`[data-testid="pricing-table-row"][data-deal="${key}"]`);
const box = (card: Locator, key: string) => row(card, key).getByTestId('pricing-table-amount');
const save = (card: Locator) => card.getByTestId('pricing-table-save');
const deal = (i: number) => seeded!.deals[i]!;

/**
 * Every row on the screen emptied, then the given ones typed — what a person
 * does before a partial save. Only the rows DRAWN: a re-filed deal's row is
 * gone from the page, and a row nobody fills keeps no figure to post.
 */
async function onlyRows(card: Locator, typed: Record<string, string>) {
  const rows = card.getByTestId('pricing-table-row');
  const keys = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-deal') ?? ''));
  for (const key of keys) await box(card, key).fill(typed[key] ?? '');
}

const width = (page: Page) =>
  page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));

test('a truck out of YW, and on it one client with twelve deals and a deal-less prixod', async ({ page }) => {
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

test('the table: a row per deal and «Bitimsiz», the accountant’s rows pre-filled with each deal’s own part — no select, nothing sent', async ({ page }) => {
  expect(seeded).not.toBeNull();
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  // The single-deal form and its select are gone for this client.
  await expect(card.getByTestId('truck-deal-select')).toHaveCount(0);
  await expect(card.getByTestId('pricing-form')).toHaveCount(0);
  const rows = card.getByTestId('pricing-table-row');
  await expect(rows).toHaveCount(13);
  // In the order the select used: by code, «Bitimsiz» last.
  await expect(rows.first()).toHaveAttribute('data-deal', deal(0).id);
  await expect(rows.last()).toHaveAttribute('data-deal', 'none');
  // Each row named like every deal picker names one — the goods and the
  // share right after the code, the cargo spelled like the lot rows.
  await expect(row(card, deal(2).id).getByTestId('pricing-table-label')).toContainText(
    `${deal(2).code} · Monitor · 4 % · 3 m³ · 300 kg`,
  );
  // Quote × this truck's share, rounded UP: 6543.21 × 2/3, 1234.56 × 1/2,
  // 7777.33 × 3/4 = 5832.9975.
  await expect(box(card, deal(1).id)).toHaveValue('4362.14');
  await expect(box(card, deal(0).id)).toHaveValue('617.28');
  await expect(box(card, deal(2).id)).toHaveValue('5833.00');
  // «Bitimsiz» has no quote and is never pre-filled.
  await expect(box(card, 'none')).toHaveValue('');
  // A dollar figure never stands in a so'm box: the untouched pre-fill goes,
  // and comes back with the dollar. (The options carry no value attribute —
  // their text is the value.)
  const currency = card.getByTestId('pricing-table').locator('select[name="currency"]');
  if ((await currency.locator('option', { hasText: /^UZS$/ }).count()) > 0) {
    await currency.selectOption('UZS');
    await expect(box(card, deal(1).id)).toHaveValue('');
    await expect(row(card, deal(1).id).getByTestId('pricing-table-why')).toHaveAttribute('data-why', 'currency');
    await currency.selectOption('USD');
    await expect(box(card, deal(1).id)).toHaveValue('4362.14');
  }
  // The owner's sight draws the most per deal (the deal block above the
  // table): it fits the phone too, the 44-character name included (#400).
  const w = await width(page);
  expect(w.view).toBe(360);
  expect(w.doc).toBeLessThanOrEqual(w.view);
  expect(await pricesOn(batchId, seeded!.clientId)).toHaveLength(0);
});

test('a save with blank rows writes only the filled one (his 3a) — and nothing asks about a deal with nothing here', async ({ page }) => {
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  await onlyRows(card, { [deal(1).id]: '4362.14' });
  await save(card).click();
  // Nothing to ask: inside 5 %, no price here, no «davomi» — the old «Bu narx
  // qo'shimcha hisob bo'ladi» about the next deal's part is gone.
  await expect.poll(async () => (await pricesOn(batchId, seeded!.clientId)).map((r) => r.dealId), { timeout: 15_000 }).toEqual([
    deal(1).id,
  ]);
  await expect(card.getByTestId('pricing-deviation')).toHaveCount(0);
  // The rows emptied on purpose stay empty — never pre-filled back for the
  // next press to write (judge P1-UX-3); the written row cleared.
  await expect(box(card, deal(0).id)).toHaveValue('');
  await expect(box(card, deal(1).id)).toHaveValue('');
  // What stands for the priced deal, and ONE loud line for every blank one.
  await expect(row(card, deal(1).id).getByTestId('pricing-table-stands')).toContainText('$4362.14');
  const missing = card.getByTestId('pricing-priced-here-missing');
  await expect(missing).toHaveCount(1);
  await expect(missing).toHaveAttribute('data-loud', 'true');
  await expect(missing).toContainText(deal(0).code);
  await expect(missing).not.toContainText(deal(1).code);
});

test('a row whose deal is priced here asks «qo‘shimcha hisob» for THAT row only — a deal with nothing here is never called an extra bill', async ({ page }) => {
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  // A fresh page: the priced deal sorts last among the deals, and nothing
  // pre-fills it again.
  await expect(card.getByTestId('pricing-table-row').nth(11)).toHaveAttribute('data-deal', deal(1).id);
  await expect(box(card, deal(1).id)).toHaveValue('');
  await onlyRows(card, { [deal(0).id]: '617.28', [deal(1).id]: '4362.14' });
  await save(card).click();
  const alert = card.getByTestId('pricing-deviation');
  await expect(alert).toBeVisible();
  await expect(alert.getByTestId('pricing-table-total')).toContainText('4979.42 USD');
  const extra = alert.locator('[data-testid="pricing-table-ask"][data-kind="extra"]');
  await expect(extra).toHaveCount(1);
  await expect(extra).toContainText(deal(1).code);
  await expect(extra).toContainText('$4362.14');
  // Deal 0 has nothing here and sits on its own part: no line names it.
  await expect(alert.getByTestId('pricing-table-ask').filter({ hasText: deal(0).code })).toHaveCount(0);
  expect(await pricesOn(batchId, seeded!.clientId)).toHaveLength(1);
  // Taken back, nothing is written; without the extra row the press goes
  // straight through.
  await alert.getByRole('button').last().click();
  await expect(alert).toHaveCount(0);
  expect(await pricesOn(batchId, seeded!.clientId)).toHaveLength(1);
  await box(card, deal(1).id).fill('');
  await save(card).click();
  await expect.poll(async () => (await pricesOn(batchId, seeded!.clientId)).map((r) => r.dealId), { timeout: 15_000 }).toEqual([
    deal(1).id,
    deal(0).id,
  ]);
});

test('the VED: the same rows, nothing pre-filled, no quote in the page — and it fits 360 px with a 44-character name', async ({ page }) => {
  await login(page, VED);
  const card = await openCard(page);
  await expect(card.getByTestId('pricing-table-row')).toHaveCount(13);
  const html = await page.content();
  for (const d of seeded!.deals) expect(html, d.quote).not.toContain(d.quote);
  for (const figure of ['5833.00', '617.28', '4362.14']) expect(html, figure).not.toContain(`value="${figure}"`);
  await expect(box(card, deal(2).id)).toHaveValue('');
  // The long name wraps in its row; the page stays the phone's width (#400).
  await expect(row(card, deal(3).id).getByTestId('pricing-table-label')).toContainText(LONG_GOODS);
  const w = await width(page);
  expect(w.view).toBe(360);
  expect(w.doc).toBeLessThanOrEqual(w.view);
  // «Saqlash» and its alert are reachable at the foot of thirteen rows — the
  // VED types into a priced deal's row, so the alert asks.
  await box(card, deal(1).id).fill('10');
  await save(card).scrollIntoViewIfNeeded();
  await expect(save(card)).toBeVisible();
  await save(card).click();
  const alert = card.getByTestId('pricing-deviation');
  await alert.scrollIntoViewIfNeeded();
  await expect(alert.getByTestId('pricing-deviation-confirm')).toBeInViewport();
  const after = await width(page);
  expect(after.doc).toBeLessThanOrEqual(after.view);
  await alert.getByRole('button').last().click();
  expect(await pricesOn(batchId, seeded!.clientId)).toHaveLength(2);
});

test('a price written behind the screen is `prices_changed` — refused, redrawn, the typed figure kept on its own row', async ({ page }) => {
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  await onlyRows(card, { [deal(4).id]: '50' });
  // Another tab prices deal 5 while this page is open.
  await priceBehindTheScreen(batchId, seeded!.clientId, deal(5).id, '25.00');
  await save(card).click();
  // Deal 4 is far under its part: the alert asks first.
  await card.getByTestId('pricing-deviation').getByTestId('pricing-deviation-confirm').click();
  await expect(card.getByTestId('pricing-form-error')).toHaveAttribute('data-error', 'prices_changed', { timeout: 15_000 });
  // Redrawn: deal 5's row now says what stands, and the figure typed for
  // deal 4 is still on deal 4.
  await expect(row(card, deal(5).id).getByTestId('pricing-table-stands')).toContainText('$25.00', { timeout: 15_000 });
  await expect(box(card, deal(4).id)).toHaveValue('50');
  expect(await pricesOn(batchId, seeded!.clientId)).toHaveLength(3);
});

test('a page drawn before a prixod was re-filed is refused and redrawn — the row of the deal that left is gone, the other figure stays', async ({ page }) => {
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  // TYPED, not the pre-fill: an untouched row would show the redrawn page's
  // own pre-fill (deal 2 carries 10 m³ after the re-file).
  await onlyRows(card, { [deal(2).id]: '5833', [deal(6).id]: '1' });
  // Deal 6's prixod moves onto deal 2 while the page is open.
  await refile(deal(6).receiptId, deal(2).id);
  await save(card).click();
  // Deal 6's 1 is far under its part — the alert asks; confirm it.
  await card.getByTestId('pricing-deviation').getByTestId('pricing-deviation-confirm').click();
  await expect(card.getByTestId('pricing-form-error')).toHaveAttribute('data-error', 'deals_changed', { timeout: 15_000 });
  await expect(row(card, deal(6).id)).toHaveCount(0, { timeout: 15_000 });
  // The figure stays on the deal it was typed for — never moved to another row.
  await expect(box(card, deal(2).id)).toHaveValue('5833');
  expect(await pricesOn(batchId, seeded!.clientId)).toHaveLength(3);
});

test('a page drawn before the truck became one deal’s is refused and redrawn as the single form — the sentence survives the flip', async ({ page }) => {
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  await onlyRows(card, { [deal(2).id]: '5833' });
  // Every prixod of his here moves onto deal 2 while the page is open: one
  // deal beside deal-less cargo is nobody's question (R3a).
  for (const d of seeded!.deals) if (d.id !== deal(2).id) await refile(d.receiptId, deal(2).id);
  await save(card).click();
  // 5833 is far under deal 2's part as drawn (10 m³ of it): the alert asks.
  await card.getByTestId('pricing-deviation').getByTestId('pricing-deviation-confirm').click();
  await expect(card.getByTestId('pricing-form-error')).toHaveAttribute('data-error', 'deals_changed', { timeout: 15_000 });
  await expect(card.getByTestId('pricing-table')).toHaveCount(0, { timeout: 15_000 });
  await expect(card.getByTestId('pricing-form')).toBeVisible();
  // The wrapper kept the refusal across the remount (judge P1-UX-5).
  await expect(card.getByTestId('pricing-form-error')).toHaveAttribute('data-error', 'deals_changed');
  expect(await pricesOn(batchId, seeded!.clientId)).toHaveLength(3);
});

test('the single form: a further price for a client already priced here asks — by itself', async ({ page }) => {
  await login(page, ACCOUNTANT);
  const card = await openCard(page);
  await card.getByTestId('pricing-form').locator('input[name="amount"]').fill('100');
  await card.getByTestId('pricing-form').locator('button[type="submit"]').click();
  const alert = card.getByTestId('pricing-deviation');
  await expect(alert.getByTestId('pricing-priced-here-ask')).toBeVisible();
  // Deal-less cargo aboard: no whole-cargo figure to compare with.
  await expect(alert.getByTestId('pricing-deviation-pct')).toHaveCount(0);
  await alert.getByRole('button').last().click();
  expect(await pricesOn(batchId, seeded!.clientId)).toHaveLength(3);
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
