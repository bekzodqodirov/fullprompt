import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import { database, dropTruck, mintTruck, putQueueBack, readQueue, type QueueRow } from './chegara-fixture';

/**
 * «Chegara navbatlari» on /trucks, at 360 px (the Horgos round; owner,
 * 2026-09-29, answer 14: «ochered kamaysa tez otb ketadiku»).
 *
 * 1. The logist types Horgos «3»–«4» and reads it back with his own name.
 * 2. A refusal («5»–«2») keeps what he typed and says why.
 * 3. The VED reads the same number and is offered no fold.
 * 4. The seller is sent home: /trucks is the batch readers' page.
 * 5. The Mashina tab's pins on a truck of this spec's OWN, at 360 px in
 *    Russian and in Uzbek — the reason `whitespace-nowrap` left the buttons:
 *    every pin inside the screen, the document no wider than the phone.
 * 6. The last test puts the table back EXACTLY as it found it — a typed wait
 *    is configuration that moves every Horgos date a later spec computes
 *    (#183), and «no row» and «a reset row» are different histories — and
 *    returns the logist's language and deletes the truck. The audit rows the
 *    presses wrote stay (audit_log refuses DELETE).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const LOGIST = '+998900000003';
const VED = '+998900000004';
const SELLER = '+998900000009';

let snapshot: QueueRow[] | null = null;
let locale: string | null = null;
let truckId: string | null = null;
let restored = false;

/** The queues, the logist's language and this spec's own truck — all given back. */
async function restore() {
  if (restored) return;
  const sql = database();
  try {
    await sql.begin(async (tx) => {
      if (snapshot) await putQueueBack(tx, snapshot);
      if (locale !== null) await tx`UPDATE users SET locale = ${locale} WHERE phone = ${LOGIST}`;
    });
    if (truckId) await dropTruck(sql, truckId);
    restored = true;
  } finally {
    await sql.end();
  }
}

async function queueNow(): Promise<QueueRow[]> {
  const sql = database();
  try {
    return await readQueue(sql);
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

async function noSideScroll(page: Page) {
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
  expect(w.doc).toBeLessThanOrEqual(w.view);
}

async function openFold(page: Page, post: string) {
  const fold = page.getByTestId(`queue-edit-${post}`);
  if ((await fold.getAttribute('open')) === null) await fold.locator('summary').click();
  await expect(page.getByTestId(`queue-min-${post}`)).toBeVisible();
}

// A safety net only: the restore is a TEST below (round 57's lesson), and
// this repeats it with no browser if an earlier test failed and skipped it.
test.afterAll(async () => {
  await restore();
});

test('snapshot the queues and the logist’s language, mint a truck to Tashkent', async () => {
  const sql = database();
  try {
    snapshot = await readQueue(sql);
    const [row] = await sql<{ locale: string }[]>`SELECT locale FROM users WHERE phone = ${LOGIST}`;
    locale = row!.locale;
    truckId = await mintTruck(sql, LOGIST);
  } finally {
    await sql.end();
  }
});

test('the logist types Horgos «3»–«4» and reads it back with his name', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto('/trucks');
  await expect(page.getByTestId('border-queue')).toBeVisible();
  await expect(page.getByTestId('queue-meaning')).toBeVisible();
  await openFold(page, 'khorgos');
  await page.getByTestId('queue-min-khorgos').fill('3');
  await page.getByTestId('queue-max-khorgos').fill('4');
  await page.getByTestId('queue-save-khorgos').click();
  await expect(page.getByTestId('queue-value-khorgos')).toContainText(/3–4/, { timeout: 15_000 });
  await expect(page.getByTestId('queue-by-khorgos')).toContainText('Logist Demo');
  // Stored in hours, as the schedule counts them.
  const row = (await queueNow()).find((r) => r.post === 'khorgos')!;
  expect([row.min_hours, row.max_hours]).toEqual([72, 96]);
  await noSideScroll(page);
  await openFold(page, 'khorgos');
  await page.screenshot({ path: 'test-results/chegara-navbat-360.png', fullPage: true });
});

test('a refusal keeps what was typed and says why', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto('/trucks');
  await openFold(page, 'khorgos');
  await page.getByTestId('queue-min-khorgos').fill('5');
  await page.getByTestId('queue-max-khorgos').fill('2');
  await page.getByTestId('queue-save-khorgos').click();
  await expect(page.getByTestId('queue-error-khorgos')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('queue-min-khorgos')).toHaveValue('5');
  await expect(page.getByTestId('queue-max-khorgos')).toHaveValue('2');
  // Nothing was written: the number he saved before stands.
  const row = (await queueNow()).find((r) => r.post === 'khorgos')!;
  expect([row.min_hours, row.max_hours]).toEqual([72, 96]);
});

test('the VED reads the same number and is offered no fold', async ({ page }) => {
  await login(page, VED);
  await page.goto('/trucks');
  await expect(page.getByTestId('queue-value-khorgos')).toContainText(/3–4/);
  await expect(page.getByTestId('queue-edit-khorgos')).toHaveCount(0);
  await expect(page.getByTestId('queue-edit-yallama')).toHaveCount(0);
});

test('the seller is sent home — /trucks is the batch readers’ page', async ({ page }) => {
  await login(page, SELLER);
  await page.goto('/trucks');
  await expect(page).toHaveURL('/');
});

test('the Mashina pins at 360 px, in Russian and in Uzbek: every one inside the phone', async ({ page }) => {
  for (const lang of ['ru', 'uz'] as const) {
    const sql = database();
    try {
      await sql`UPDATE users SET locale = ${lang} WHERE phone = ${LOGIST}`;
    } finally {
      await sql.end();
    }
    await login(page, LOGIST);
    await page.goto(`/batches/${truckId}/mashina`);
    // The testid sits on the Panel's SUMMARY (components/panel.tsx), so the
    // buttons are looked for in the <details> that summary heads.
    const panel = page.locator('details').filter({ has: page.getByTestId('batch-where-panel') });
    await expect(panel).toBeVisible();
    // Yiwu → Tashkent carries three pins: the border, Kyrgyzstan, Uzbekistan.
    const pins = panel.locator('form button[type="submit"]');
    await expect(pins).toHaveCount(3);
    const view = page.viewportSize()!;
    for (let i = 0; i < 3; i += 1) {
      const box = (await pins.nth(i).boundingBox())!;
      expect(box.x, `${lang} pin ${i}`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${lang} pin ${i}`).toBeLessThanOrEqual(view.width);
    }
    await noSideScroll(page);
    await page.screenshot({ path: `test-results/chegara-mashina-pins-360-${lang}.png`, fullPage: true });
  }
});

test('the queues, the language and the truck are put back exactly as they were found', async () => {
  await restore();
  expect(await queueNow()).toEqual(snapshot);
  const sql = database();
  try {
    const [row] = await sql<{ locale: string }[]>`SELECT locale FROM users WHERE phone = ${LOGIST}`;
    expect(row!.locale).toBe(locale);
    expect(await sql`SELECT 1 FROM batches WHERE id = ${truckId}`).toHaveLength(0);
  } finally {
    await sql.end();
  }
});
