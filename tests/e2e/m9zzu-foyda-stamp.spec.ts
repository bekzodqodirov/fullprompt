import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { BOOK, OWNER, cleanup, cleanupEarlier, database, mint, newMarker } from './stamp-profit-fixture';

/**
 * 4a in the browser (his «a) yuk kelgan kundagi sotuvchiga»): the seller
 * report's MONEY follows the prixod's stamp, not the client book.
 *
 * The spec mints a period of its own — October 2018 — with a client whose card
 * names Dilnoza and whose cargo, received in SEPTEMBER, is stamped Admin Demo
 * (2 m³) and Dilnoza (1 m³); a truck price over both and a card price (see
 * stamp-profit-fixture.ts). On the old code Admin Demo could carry no money
 * in that period at all — every cent went to the book — so a non-zero Admin
 * Demo revenue cell is 4a, and impossible before it.
 *
 * Assertions are testids and WORDS (read out of all four bundles, since the
 * viewer's language is the viewer's); the one figure asserted is that a cell
 * is NOT «$0.00». The last test deletes everything the spec minted and proves
 * nothing carries its marker (no afterAll — round 57's lesson, #183/#154).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const PERIOD = '/reports/sotuvchilar?dan=2018-10-01&gacha=2018-10-31';
const marker = newMarker();

type Bundle = { dashboard: { staffProfit: { note: string } }; sellerReport: { moneyByStamp: string } };
const bundles: Bundle[] = ['ru', 'uz', 'zh-CN', 'en'].map(
  (locale) => JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Bundle,
);
const anyOf = (pick: (b: Bundle) => string) =>
  new RegExp(bundles.map((b) => pick(b).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** The page must fit its viewport — a wider document makes a phone zoom the whole page out (#400). */
async function fitsViewport(page: Page) {
  const { doc, view } = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(doc).toBeLessThanOrEqual(view);
}

test('mint a period of our own', async () => {
  const sql = database();
  try {
    await cleanupEarlier(sql);
    await mint(sql, marker);
  } finally {
    await sql.end();
  }
});

test('the owner reads the stamp sentence and both figures', async ({ page }) => {
  await login(page, OWNER);
  for (const size of [
    { width: 360, height: 800 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(PERIOD);
    await expect(page.getByTestId('seller-attribution')).toContainText(anyOf((b) => b.sellerReport.moneyByStamp));
    const table = page.getByTestId('seller-table');
    await expect(table).toBeVisible();
    // The stamp holder of a client whose book is Dilnoza, with no cargo of
    // Admin Demo received in the period: money that only the stamp can bring —
    // his 2 m³ of the $90 truck price (2:1 by m³), measured by the fixture
    // probe. The book would have put all $130 on Dilnoza and $0 here.
    const admin = table.locator('tbody tr', { hasText: 'Admin Demo' });
    await expect(admin).toHaveCount(1);
    await expect(admin.getByTestId('seller-revenue')).toHaveText('$60.00');
    await expect(page.getByTestId('seller-split')).toBeVisible();
    await expect(page.getByTestId('seller-unlinked')).toBeVisible();
    await fitsViewport(page);
  }
});

test('the seller reads her own card, which carries no profit and no figures', async ({ page }) => {
  await login(page, BOOK);
  await page.goto(PERIOD);
  await expect(page.getByTestId('seller-own')).toBeVisible();
  // Her own line about her own sum — never the whole table's sentence.
  await expect(page.getByTestId('seller-attribution-own')).toBeVisible();
  await expect(page.getByTestId('seller-attribution')).toHaveCount(0);
  await expect(page.getByTestId('seller-table')).toHaveCount(0);
  await expect(page.getByTestId('seller-split')).toHaveCount(0);
  await expect(page.getByTestId('seller-unlinked')).toHaveCount(0);
  await fitsViewport(page);
});

test('the dashboard card says where the profit goes, and its link opens the card’s period', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/dashboard');
  const card = page.getByTestId('dash-staff-profit');
  await expect(card).toBeVisible();
  await expect(card).toContainText(anyOf((b) => b.dashboard.staffProfit.note));
  const link = page.getByTestId('dash-staff-profit-report');
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/reports\/sotuvchilar\?dan=\d{4}-\d{2}-\d{2}&gacha=\d{4}-\d{2}-\d{2}$/);
  const [, dan, gacha] = /dan=(\d{4}-\d{2}-\d{2})&gacha=(\d{4}-\d{2}-\d{2})/.exec(href!)!;
  await link.click();
  await expect(page).toHaveURL(/\/reports\/sotuvchilar\?dan=/);
  const form = page.getByTestId('seller-period');
  await expect(form.locator('input[name="dan"]')).toHaveValue(dan!);
  await expect(form.locator('input[name="gacha"]')).toHaveValue(gacha!);
});

test('cleanup: nothing the spec minted is left behind', async () => {
  const sql = database();
  try {
    expect(await cleanup(sql, marker)).toEqual({ charges: 0, receipts: 0, batches: 0, clients: 0 });
  } finally {
    await sql.end();
  }
});
