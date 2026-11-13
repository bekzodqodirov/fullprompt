import { expect, test, type Locator, type Page } from '@playwright/test';
import { KARTA_TOTAL, cleanKarta, kartaMarking, mintKarta, type KartaRun } from './prixod-karta-fixture';

/**
 * The prixod card on a DESKTOP (docs/PRIXOD-KARTA.md §7) — what the office
 * and the VED see.
 *
 *  1. the ties sit ABOVE the cargo in one card, and a select in it is at
 *     most half the card wide (it was four cards, each a 900 px select);
 *  2. files and costs stand side by side — and STACK at a 768 px window,
 *     where the sidebar has already taken 224 px (the pairs switch at `lg`,
 *     never `md`: at 768 an `md` pair gave each half 248 px, narrower than
 *     a phone);
 *  3. an ownerless prixod's fifty-character marking stays inside its column
 *     and off the «Jami» beside it;
 *  4. cleanup, a final TEST.
 */

const OWNER = '+998900000001';
const DEMO_PASSWORD = 'demo1234';
const RUN: KartaRun = { prefix: `PD${String(Date.now()).slice(-6)}` };
let ids: { claimedId: string; ownerlessId: string; lotAId: string } | null = null;

test.describe.configure({ mode: 'serial' });

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(DEMO_PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function box(target: Locator) {
  await expect(target).toBeVisible();
  const rect = await target.boundingBox();
  expect(rect, 'the element has a box').not.toBeNull();
  return rect!;
}

async function fitsTheScreen(page: Page) {
  const { client, scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(scroll, `document ${scroll}px in a ${client}px window`).toBeLessThanOrEqual(client);
}

test('mint: a claimed prixod of two lots and an ownerless one with a fifty-character marking', async () => {
  ids = await mintKarta(RUN);
  expect(ids.claimedId).not.toBe('');
});

test('at 1280 the ties are one card above the cargo, and a select in it is at most half the card', async ({ page }) => {
  expect(ids).not.toBeNull();
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, OWNER);
  await page.goto(`/receipts/${ids!.claimedId}`);

  const summary = await box(page.getByTestId('receipt-summary'));
  const links = await box(page.getByTestId('receipt-links'));
  const lots = await box(page.getByTestId('receipt-lots'));
  expect(summary.y + summary.height).toBeLessThanOrEqual(links.y);
  expect(links.y + links.height).toBeLessThanOrEqual(lots.y);

  // The summary is three columns: «Jami» stands BESIDE the client, not under.
  const total = page.getByTestId('receipt-total');
  await expect(total).toContainText(`${KARTA_TOTAL.boxes} 📦 · ${KARTA_TOTAL.kg} kg · ${KARTA_TOTAL.m3} m³`);
  const totalBox = await box(total);
  const dateBox = await box(page.getByTestId('receipt-received-date'));
  expect(totalBox.x).toBeGreaterThan(summary.x + summary.width / 4);
  expect(dateBox.x).toBeGreaterThan(totalBox.x + 50);

  // Every control that changes a tie: the owner gets at least the deal's.
  const selects = page.getByTestId('receipt-links').locator('select');
  expect(await selects.count()).toBeGreaterThan(0);
  for (const select of await selects.all()) {
    expect((await box(select)).width, 'a tie’s select').toBeLessThanOrEqual(links.width / 2);
  }
  // «Saqlash» is not drawn until an answer differs (#422).
  await expect(page.getByTestId('receipt-deal-pick')).toBeVisible();
  await expect(page.getByTestId('receipt-deal-save')).toHaveCount(0);

  // The lot card keeps the page's width: the tarkib editor's table needs it.
  const lot = await box(page.locator(`#lot-${ids!.lotAId}`));
  expect(lot.width).toBeGreaterThanOrEqual(712);
  await fitsTheScreen(page);
});

test('files and costs stand side by side at 1280 and stack at 768', async ({ page }) => {
  expect(ids).not.toBeNull();
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, OWNER);
  await page.goto(`/receipts/${ids!.claimedId}`);
  const files = page.getByTestId('receipt-files');
  const costs = page.getByTestId('receipt-costs');
  const wideFiles = await box(files);
  const wideCosts = await box(costs);
  expect(Math.abs(wideFiles.y - wideCosts.y)).toBeLessThanOrEqual(1);
  expect(wideFiles.x + wideFiles.width).toBeLessThanOrEqual(wideCosts.x);
  expect(wideFiles.width).toBeGreaterThanOrEqual(320);

  // 768: the sidebar is there and the content column is 512 px — a pair
  // would give each half 248. Everything stacks instead.
  await page.setViewportSize({ width: 768, height: 1024 });
  const narrowFiles = await box(files);
  const narrowCosts = await box(costs);
  expect(narrowFiles.y + narrowFiles.height).toBeLessThanOrEqual(narrowCosts.y);
  expect(narrowFiles.width).toBeGreaterThanOrEqual(320);
  const total = await box(page.getByTestId('receipt-total'));
  const date = await box(page.getByTestId('receipt-received-date'));
  expect(total.y + total.height, 'the summary is lines again').toBeLessThanOrEqual(date.y + 1);
  await fitsTheScreen(page);
});

test('an ownerless prixod’s fifty-character marking stays in its column, off «Jami»', async ({ page }) => {
  expect(ids).not.toBeNull();
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, OWNER);
  await page.goto(`/receipts/${ids!.ownerlessId}`);
  const summary = await box(page.getByTestId('receipt-summary'));
  const marking = await box(page.getByText(kartaMarking(RUN), { exact: true }));
  const total = await box(page.getByTestId('receipt-total'));
  // Inside the card, and ending before the column beside it begins.
  expect(marking.x).toBeGreaterThanOrEqual(summary.x);
  expect(marking.x + marking.width).toBeLessThanOrEqual(total.x);
  await expect(page.getByTestId('receipt-owner')).toBeVisible();
  await fitsTheScreen(page);
});

test('cleanup: the two prixods and their client are gone', async () => {
  expect(await cleanKarta(RUN)).toBe(0);
});
