import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import {
  KA_OPERATOR,
  LOGIST,
  PASSWORD,
  VED,
  database,
  dropTrucks,
  localeOf,
  mintTruck,
  warehouseId,
} from './yonalish-fixture';

/**
 * «Yo'nalishni o'zgartirish» at 360 px (the reroute round; owner, 2026-09-30,
 * his 1a 2a 3a 4a): a truck on the road is sent to another warehouse of the
 * same country, and the warehouse it was taken from stops being able to land
 * it.
 *
 * 1. The logist on a YW → TAS1 truck of this spec's own: the choice offers
 *    Uzbek warehouses only (containment — integration files leave active UZ
 *    warehouses in CI's one database), the button waits for a reason, the
 *    confirm is accepted, and a SECOND page drawn for TAS1 is refused
 *    «someone changed it just now» with its choice and reason kept.
 * 2. The card says so on every tab: «Rejada: TAS1 → … AND», the route line
 *    «YW → AND», and the history row carries the reason.
 * 3. The KA operator on a YW → KA truck: 200 before, and after the logist
 *    sends it to UCH the card is 404, /unload names UCH, and the phone's
 *    snapshot answers 409 — never a 403 that reads «sign in again».
 * 4. The VED reads the history and is offered no button.
 * 5. The last test deletes the trucks, their events and notifications, and
 *    gives the logist his language back. Audit rows stay (audit_log refuses
 *    DELETE).
 */

test.describe.configure({ mode: 'serial' });

let toTashkent: { id: string; code: string } | null = null;
let toKashgar: { id: string; code: string } | null = null;
let locale: string | null = null;
let restored = false;
const REASON = 'Toshkent-1 to‘lgan, e2e';

async function restore() {
  if (restored) return;
  const sql = database();
  try {
    await dropTrucks(sql, [toTashkent?.id, toKashgar?.id].filter((id): id is string => Boolean(id)));
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

/** The status a GET of `path` answers this session, redirects NOT followed. */
async function statusOf(page: Page, path: string): Promise<number> {
  const res = await page.request.get(path, { maxRedirects: 0 });
  return res.status();
}

/** #1241: the document, never `window.innerWidth`, which grows with the zoom-out. */
async function fitsThePhone(page: Page) {
  const w = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(w.view).toBe(360);
  expect(w.doc).toBeLessThanOrEqual(w.view);
}

/** The Panel's testid sits on its SUMMARY (components/panel.tsx). */
async function openPanel(page: Page) {
  const summary = page.getByTestId('batch-reroute-panel');
  await expect(summary).toBeVisible();
  const details = page.locator('details').filter({ has: summary });
  if ((await details.getAttribute('open')) === null) await summary.click();
  return details;
}

async function reroute(page: Page, targetId: string, reason: string) {
  await page.getByTestId('reroute-target').selectOption(targetId);
  await page.getByTestId('reroute-reason').fill(reason);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('reroute-submit').click();
}

// A safety net only: the cleanup is a TEST below (round 57's lesson), and this
// repeats it with no browser if an earlier test failed and skipped it.
test.afterAll(async () => {
  await restore();
});

test('mint two trucks of this spec’s own and put the logist in Uzbek', async () => {
  const sql = database();
  try {
    locale = await localeOf(sql, LOGIST);
    await sql`UPDATE users SET locale = 'uz' WHERE phone = ${LOGIST}`;
    toTashkent = await mintTruck(sql, 'TAS1');
    toKashgar = await mintTruck(sql, 'KA');
  } finally {
    await sql.end();
  }
});

test('the KA operator opens his truck before the reroute: card, unload and snapshot answer', async ({ page }) => {
  await login(page, KA_OPERATOR);
  expect(await statusOf(page, `/batches/${toKashgar!.id}`)).toBe(200);
  expect(await statusOf(page, `/batches/${toKashgar!.id}/unload`)).toBe(200);
  expect(await statusOf(page, `/api/batches/${toKashgar!.id}/planned`)).toBe(200);
});

test('the logist sends YW → TAS1 to AND; a page drawn for TAS1 is refused and keeps what was typed', async ({
  page,
}) => {
  await login(page, LOGIST);
  const stale = await page.context().newPage();
  await stale.goto(`/batches/${toTashkent!.id}/mashina`);
  await page.goto(`/batches/${toTashkent!.id}/mashina`);
  await openPanel(page);

  // Uzbek warehouses only, by containment; every offered id is a UZ row.
  const options = page.getByTestId('reroute-target').locator('option:not([value=""])');
  const labels = await options.allTextContents();
  const codes = labels.map((label) => label.split(' · ')[0]!.trim());
  expect(codes).toEqual(expect.arrayContaining(['AND', 'TAS2']));
  for (const foreign of ['TAS1', 'YW', 'GZ', 'UCH', 'KA']) expect(codes).not.toContain(foreign);
  const ids = await options.evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
  const sql = database();
  let andId: string;
  let tas2Id: string;
  try {
    const rows = await sql<{ country: string }[]>`
      SELECT upper(trim(country)) AS country FROM warehouses WHERE id = ANY(${ids}::uuid[])`;
    expect(rows).toHaveLength(ids.length);
    for (const row of rows) expect(row.country).toBe('UZ');
    andId = await warehouseId(sql, 'AND');
    tas2Id = await warehouseId(sql, 'TAS2');
  } finally {
    await sql.end();
  }

  // The button waits for a reason of three letters.
  const submit = page.getByTestId('reroute-submit');
  await page.getByTestId('reroute-target').selectOption(andId);
  await expect(submit).toBeDisabled();
  await page.getByTestId('reroute-reason').fill('ab');
  await expect(submit).toBeDisabled();
  await reroute(page, andId, REASON);
  await expect(page.getByTestId('reroute-done')).toContainText('AND', { timeout: 15_000 });
  await fitsThePhone(page);

  // The second page still believes the truck goes to TAS1: its press is
  // refused, never chained, and the choice and the reason stay in the boxes.
  await openPanel(stale);
  await reroute(stale, tas2Id, 'eskirgan sahifa');
  await expect(stale.getByTestId('reroute-refusal')).toBeVisible({ timeout: 15_000 });
  await expect(stale.getByTestId('reroute-target')).toHaveValue(tas2Id);
  await expect(stale.getByTestId('reroute-reason')).toHaveValue('eskirgan sahifa');
  await expect(stale.getByTestId('reroute-done')).toHaveCount(0);
  await stale.screenshot({ path: 'test-results/yonalish-refusal-360.png', fullPage: true });
  await stale.close();

  const check = database();
  try {
    const [row] = await check<{ code: string }[]>`
      SELECT w.code FROM batches b JOIN warehouses w ON w.id = b.dest_warehouse_id WHERE b.id = ${toTashkent!.id}`;
    expect(row!.code).toBe('AND');
  } finally {
    await check.end();
  }
});

test('the card says so on every tab: «Rejada», the route line and the reason', async ({ page }) => {
  await login(page, LOGIST);
  for (const tab of ['', '/mashina']) {
    await page.goto(`/batches/${toTashkent!.id}${tab}`);
    await expect(page.getByTestId('batch-rerouted')).toContainText('Rejada: TAS1 → yo‘nalish o‘zgartirildi: AND');
    await expect(page.getByTestId('batch-head')).toContainText('YW → AND');
    await fitsThePhone(page);
  }
  await openPanel(page);
  const history = page.getByTestId('reroute-history');
  await expect(history.locator('li')).toHaveCount(1);
  await expect(history).toContainText(REASON);
  await expect(history).toContainText('AND');
  await expect(history).toContainText('TAS1');
  await page.screenshot({ path: 'test-results/yonalish-mashina-360.png', fullPage: true });
});

test('the KA operator loses the truck sent to UCH: 404 card, a sentence on /unload, 409 snapshot', async ({
  page,
}) => {
  await login(page, LOGIST);
  await page.goto(`/batches/${toKashgar!.id}/mashina`);
  await openPanel(page);
  const sql = database();
  let uchId: string;
  try {
    uchId = await warehouseId(sql, 'UCH');
  } finally {
    await sql.end();
  }
  await reroute(page, uchId, 'Qashqar yopiq, e2e');
  await expect(page.getByTestId('reroute-done')).toContainText('UCH', { timeout: 15_000 });

  await login(page, KA_OPERATOR);
  expect(await statusOf(page, `/batches/${toKashgar!.id}`)).toBe(404);
  const snapshot = await page.request.get(`/api/batches/${toKashgar!.id}/planned`, { maxRedirects: 0 });
  expect(snapshot.status()).toBe(409);
  expect(await snapshot.json()).toEqual({ error: 'batch_rerouted', to: 'UCH' });
  await page.goto(`/batches/${toKashgar!.id}/unload`);
  await expect(page.getByTestId('unload-rerouted')).toContainText('UCH');
  await fitsThePhone(page);
  await page.screenshot({ path: 'test-results/yonalish-unload-360.png', fullPage: true });
});

test('the VED reads the history and is offered no button', async ({ page }) => {
  await login(page, VED);
  await page.goto(`/batches/${toTashkent!.id}/mashina`);
  await openPanel(page);
  await expect(page.getByTestId('reroute-history')).toContainText(REASON);
  await expect(page.getByTestId('reroute-submit')).toHaveCount(0);
  await expect(page.getByTestId('reroute-form')).toHaveCount(0);
});

test('the trucks, their events and notifications are gone, and the logist’s language is back', async () => {
  const ids = [toTashkent!.id, toKashgar!.id];
  await restore();
  const sql = database();
  try {
    expect(await sql`SELECT 1 FROM batches WHERE id = ANY(${ids}::uuid[])`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM events WHERE entity_id = ANY(${ids}::uuid[])`).toHaveLength(0);
    expect(await localeOf(sql, LOGIST)).toBe(locale);
  } finally {
    await sql.end();
  }
});
