import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * «Chegara navbatlari» on /trucks, at 360 px (the Horgos round; owner,
 * 2026-09-29, answer 14: «ochered kamaysa tez otb ketadiku»).
 *
 * 1. The logist types Horgos «3»–«4» and reads it back with his own name.
 * 2. A refusal («5»–«2») keeps what he typed and says why.
 * 3. The VED reads the same number and is offered no fold.
 * 4. The seller is sent home: /trucks is the batch readers' page.
 * 5. The last test puts the table back EXACTLY as it found it — a typed wait
 *    is configuration that moves every Horgos date a later spec computes
 *    (#183), and «no row» and «a reset row» are different histories. The
 *    audit rows the presses wrote stay (audit_log refuses DELETE).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const LOGIST = '+998900000003';
const VED = '+998900000004';
const SELLER = '+998900000009';

type QueueRow = {
  id: string;
  post: string;
  min_hours: number | null;
  max_hours: number | null;
  note: string | null;
  updated_by: string | null;
  updated_at: string;
};

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to snapshot and restore this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

async function readQueue(): Promise<QueueRow[]> {
  const sql = database();
  try {
    return await sql<QueueRow[]>`
      SELECT id, post, min_hours, max_hours, note, updated_by, updated_at::text AS updated_at
      FROM border_queue ORDER BY post`;
  } finally {
    await sql.end();
  }
}

let snapshot: QueueRow[] | null = null;
let restored = false;

async function restore() {
  if (!snapshot || restored) return;
  const sql = database();
  try {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM border_queue`;
      for (const r of snapshot!) {
        await tx`
          INSERT INTO border_queue (id, post, min_hours, max_hours, note, updated_by, updated_at)
          VALUES (${r.id}, ${r.post}, ${r.min_hours}, ${r.max_hours}, ${r.note}, ${r.updated_by},
                  ${r.updated_at}::timestamptz)`;
      }
    });
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

async function noSideScroll(page: Page) {
  const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
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

test('snapshot the queues before touching them', async () => {
  snapshot = await readQueue();
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
  const row = (await readQueue()).find((r) => r.post === 'khorgos')!;
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
  const row = (await readQueue()).find((r) => r.post === 'khorgos')!;
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

test('the queues are put back exactly as they were found', async () => {
  await restore();
  expect(await readQueue()).toEqual(snapshot);
});
