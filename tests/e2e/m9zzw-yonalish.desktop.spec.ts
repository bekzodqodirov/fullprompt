import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import { LOGIST, PASSWORD, database, dropTrucks, localeOf, mintTruck, warehouseId } from './yonalish-fixture';

/**
 * «Yo'nalishni o'zgartirish» at 1280×900 — the screenshots the round is
 * looked at through: the panel open with a refusal shown, then with its
 * history, and the card's «Rejada» line on the Tarkib tab.
 *
 * One truck of this spec's own (YW → TAS2 → AND, so it never meets the
 * mobile spec's YW → TAS1). The logist's language and the truck, its events
 * and notifications are given back by the LAST test and again in afterAll.
 */

test.describe.configure({ mode: 'serial' });

let truck: { id: string; code: string } | null = null;
let locale: string | null = null;
let restored = false;
const REASON = 'Toshkent-2 ta’mirda, e2e';

async function restore() {
  if (restored) return;
  const sql = database();
  try {
    if (truck) await dropTrucks(sql, [truck.id]);
    if (locale !== null) await sql`UPDATE users SET locale = ${locale} WHERE phone = ${LOGIST}`;
    restored = true;
  } finally {
    await sql.end();
  }
}

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** #1241: the document against the CONFIGURED viewport, never `innerWidth`. */
async function fitsTheScreen(page: Page) {
  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(doc).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function openPanel(page: Page) {
  const summary = page.getByTestId('batch-reroute-panel');
  await expect(summary).toBeVisible();
  const details = page.locator('details').filter({ has: summary });
  if ((await details.getAttribute('open')) === null) await summary.click();
}

async function reroute(page: Page, targetId: string, reason: string) {
  await page.getByTestId('reroute-target').selectOption(targetId);
  await page.getByTestId('reroute-reason').fill(reason);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('reroute-submit').click();
}

test.afterAll(async () => {
  await restore();
});

test('mint a YW → TAS2 truck and put the logist in Uzbek', async () => {
  const sql = database();
  try {
    locale = await localeOf(sql, LOGIST);
    await sql`UPDATE users SET locale = 'uz' WHERE phone = ${LOGIST}`;
    truck = await mintTruck(sql, 'TAS2');
  } finally {
    await sql.end();
  }
});

test('the reroute at 1280: a stale page refused with its inputs kept, then the story', async ({ page }) => {
  const sql = database();
  let andId: string;
  let tas1Id: string;
  try {
    andId = await warehouseId(sql, 'AND');
    tas1Id = await warehouseId(sql, 'TAS1');
  } finally {
    await sql.end();
  }
  await login(page, LOGIST);
  const stale = await page.context().newPage();
  await stale.goto(`/batches/${truck!.id}/mashina`);
  await page.goto(`/batches/${truck!.id}/mashina`);
  await openPanel(page);
  await reroute(page, andId, REASON);
  await expect(page.getByTestId('reroute-done')).toContainText('AND', { timeout: 15_000 });

  await openPanel(stale);
  await reroute(stale, tas1Id, 'eskirgan sahifa');
  await expect(stale.getByTestId('reroute-refusal')).toBeVisible({ timeout: 15_000 });
  await expect(stale.getByTestId('reroute-reason')).toHaveValue('eskirgan sahifa');
  await fitsTheScreen(stale);
  await stale.screenshot({ path: 'test-results/yonalish-refusal-1280.png', fullPage: true });
  await stale.close();

  await page.goto(`/batches/${truck!.id}/mashina`);
  await openPanel(page);
  await expect(page.getByTestId('reroute-history')).toContainText(REASON);
  await expect(page.getByTestId('batch-rerouted')).toContainText('Rejada: TAS2 → yo‘nalish o‘zgartirildi: AND');
  await fitsTheScreen(page);
  await page.screenshot({ path: 'test-results/yonalish-mashina-1280.png', fullPage: true });

  await page.goto(`/batches/${truck!.id}`);
  await expect(page.getByTestId('batch-rerouted')).toContainText('TAS2');
  await expect(page.getByTestId('batch-head')).toContainText('YW → AND');
  await fitsTheScreen(page);
  await page.screenshot({ path: 'test-results/yonalish-tarkib-1280.png', fullPage: true });
});

test('the truck, its events and notifications are gone, and the logist’s language is back', async () => {
  const id = truck!.id;
  await restore();
  const sql = database();
  try {
    expect(await sql`SELECT 1 FROM batches WHERE id = ${id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM events WHERE entity_id = ${id}`).toHaveLength(0);
    expect(await localeOf(sql, LOGIST)).toBe(locale);
  } finally {
    await sql.end();
  }
});
