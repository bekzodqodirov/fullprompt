import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import { database, dropTruck, mintTruck, putQueueBack, readQueue, type QueueRow } from './chegara-fixture';

/**
 * «Chegara navbatlari» at 1280×900, in Russian and in Uzbek, with the edit
 * fold open — the screenshots the round is looked at through — and the
 * Mashina tab's pins on a truck of this spec's own, bound for Tashkent.
 *
 * Two pieces of configuration are borrowed and returned EXACTLY (#183): the
 * border_queue table (a typed wait moves every Horgos date) and the logist's
 * own language (the screen's language is the person's, not a cookie) — and
 * the truck it mints is deleted. The returns are the last TEST, and repeated
 * in afterAll with no browser in case an earlier test failed and skipped it.
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const LOGIST = '+998900000003';

let queue: QueueRow[] | null = null;
let locale: string | null = null;
let truckId: string | null = null;
let restored = false;

async function restore() {
  if (restored || queue === null) return;
  const sql = database();
  try {
    await sql.begin(async (tx) => {
      await putQueueBack(tx, queue!);
      if (locale !== null) await tx`UPDATE users SET locale = ${locale} WHERE phone = ${LOGIST}`;
    });
    if (truckId) await dropTruck(sql, truckId);
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

async function widthFits(page: Page) {
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(w.doc).toBeLessThanOrEqual(w.view);
}

test.afterAll(async () => {
  await restore();
});

test('borrow the queues and the logist’s language, mint a truck to Tashkent', async () => {
  const sql = database();
  try {
    queue = await readQueue(sql);
    const [row] = await sql<{ locale: string }[]>`SELECT locale FROM users WHERE phone = ${LOGIST}`;
    locale = row!.locale;
    truckId = await mintTruck(sql, LOGIST);
  } finally {
    await sql.end();
  }
});

test('the panel at 1280×900 in Russian and in Uzbek, the fold open', async ({ page }) => {
  for (const lang of ['ru', 'uz'] as const) {
    const sql = database();
    try {
      await sql`UPDATE users SET locale = ${lang} WHERE phone = ${LOGIST}`;
    } finally {
      await sql.end();
    }
    await login(page, LOGIST);
    await page.goto('/trucks');
    await expect(page.getByTestId('border-queue')).toBeVisible();
    await page.getByTestId('queue-edit-yallama').locator('summary').click();
    await expect(page.getByTestId('queue-min-yallama')).toBeVisible();
    await widthFits(page);
    await page.screenshot({ path: `test-results/chegara-navbat-1280-${lang}.png`, fullPage: true });
  }
});

test('the Mashina tab offers a truck bound for Tashkent the pins of its own road', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto(`/batches/${truckId}/mashina`);
  // The testid sits on the Panel's SUMMARY (components/panel.tsx), so the
  // buttons are looked for in the <details> that summary heads.
  const panel = page.locator('details').filter({ has: page.getByTestId('batch-where-panel') });
  await expect(panel).toBeVisible();
  await expect(panel.locator('form button[type="submit"]')).toHaveCount(3);
  await widthFits(page);
  await page.screenshot({ path: 'test-results/chegara-mashina-pins-1280.png', fullPage: true });
});

test('the queues, the language and the truck are returned exactly', async () => {
  await restore();
  const sql = database();
  try {
    expect(await readQueue(sql)).toEqual(queue);
    const [row] = await sql<{ locale: string }[]>`SELECT locale FROM users WHERE phone = ${LOGIST}`;
    expect(row!.locale).toBe(locale);
    expect(await sql`SELECT 1 FROM batches WHERE id = ${truckId}`).toHaveLength(0);
  } finally {
    await sql.end();
  }
});
