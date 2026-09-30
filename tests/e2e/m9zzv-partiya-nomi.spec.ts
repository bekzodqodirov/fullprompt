import { expect, test, type Page } from '@playwright/test';
import { cleanup, cleanupEarlier, database, mint, newRun } from './partiya-nomi-fixture';

/**
 * Renaming a truck ON THE ROAD (the owner's 1a / 2a / 3a, 2026-09-30 —
 * reverses DECISIONS #122), in a real browser at 360 × 800.
 *
 * What only a browser can show: the ✏️ opens a panel that fits the phone, a
 * Cyrillic look-alike is named WHILE typing and no dialog asks about a name
 * the server would refuse, the confirm reads the NORMALISED name that will be
 * stored, the header takes the new name with «Oldingi nomi» beneath it, ⌘K
 * finds the truck by the old name, and people outside the door see no pencil
 * — the accountant not even the who/why log. The rules underneath are proven
 * in tests/integration/batch-rename.integration.test.ts.
 *
 * The truck is this spec's own (partiya-nomi-fixture.ts) and the last TEST
 * deletes it and proves nothing carries the marker (round 57's `afterAll` lie).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const LOGIST = '+998900000003';
const YW_OPERATOR = '+998900000006';
const ACCOUNTANT = '+998900000010';
const run = newRun();
let truckPath = '';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('mint: a truck of this run, on the road, one carton aboard', async () => {
  const sql = database();
  try {
    await cleanupEarlier(sql);
    const id = await mint(sql, run);
    truckPath = `/batches/${id}`;
  } finally {
    await sql.end();
  }
});

test('the logist renames it on the road: Cyrillic named live, the confirm shows what is stored', async ({ page }) => {
  // A failed test restarts the worker and resets this module (round 62).
  expect(truckPath).toMatch(/^\/batches\//);
  await login(page, LOGIST);
  await page.goto(truckPath);
  const head = page.getByTestId('batch-head');
  await expect(head.locator('h1')).toHaveText(run.oldCode);

  await page.getByTestId('edit-batch-code').click();
  await expect(page.getByTestId('batch-rename-panel')).toBeVisible();
  // The panel fits the phone: a page wider than the screen is one mobile
  // Chrome zooms out, and every tap target moves (#400) — measured by the
  // document, never `innerWidth`, which grows with the zoom (#1241).
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.client).toBe(360);
  expect(widths.scroll).toBeLessThanOrEqual(360);
  const save = page.getByTestId('batch-rename-save');
  expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  let dialogs = 0;
  let message = '';
  page.on('dialog', (dialog) => {
    dialogs += 1;
    message = dialog.message();
    void dialog.accept();
  });

  await page.getByTestId('batch-rename-reason').fill('agent hujjatida boshqa raqam');
  // «КА» typed on a Russian layout: identical on screen, named at once.
  const cyrillic = `КА-7${run.marker.slice(2)}`;
  await page.getByTestId('batch-code-input').fill(cyrillic);
  await expect(page.getByTestId('batch-rename-error')).toContainText('К, А, Е, Т');
  await save.click();
  await expect(page.getByTestId('batch-rename-error')).toBeVisible();
  expect(dialogs, 'no dialog may ask about a name the server refuses').toBe(0);

  await page.getByTestId('batch-code-input').fill(run.newCode.toLowerCase());
  await expect(page.getByTestId('batch-rename-error')).toHaveCount(0);
  await save.click();
  await expect(head.locator('h1')).toHaveText(run.newCode, { timeout: 15_000 });
  expect(dialogs).toBe(1);
  // The dialog confirmed exactly what was stored, not what was typed.
  expect(message).toContain(run.newCode);
  expect(message).toContain(run.oldCode);
  await expect(page.getByTestId('batch-former-codes')).toContainText(run.oldCode);
  await expect(page.getByTestId('batch-rename-log')).toHaveCount(1);
});

test('⌘K finds it by the old name; the archive does not (it is still on the road)', async ({ page }) => {
  expect(truckPath).toMatch(/^\/batches\//);
  await login(page, LOGIST);
  await page.goto('/stock');
  await page.locator('header a[href="/search"]').click();
  await expect(page.getByTestId('search-palette')).toBeVisible();
  await page.getByTestId('palette-input').fill(run.oldCode);
  const hit = page.getByTestId('palette-hit').filter({ hasText: run.newCode });
  await expect(hit).toHaveCount(1, { timeout: 10_000 });
  // The bold part is the CURRENT name; the quiet part says why it matched.
  await expect(hit).toContainText(run.oldCode);

  await page.goto(`/batches?archive=1&q=${encodeURIComponent(run.oldCode)}`);
  await expect(page.getByTestId('batch-archive-row')).toHaveCount(0);
});

test('outside the door: no pencil — and the accountant sees the old name but not who changed it', async ({ page }) => {
  expect(truckPath).toMatch(/^\/batches\//);
  await login(page, YW_OPERATOR);
  await page.goto(truckPath);
  await expect(page.getByTestId('batch-head').locator('h1')).toHaveText(run.newCode);
  await expect(page.getByTestId('edit-batch-code')).toHaveCount(0);
  await expect(page.getByTestId('batch-former-codes')).toContainText(run.oldCode);

  await login(page, ACCOUNTANT);
  await page.goto(truckPath);
  await expect(page.getByTestId('batch-head').locator('h1')).toHaveText(run.newCode);
  await expect(page.getByTestId('edit-batch-code')).toHaveCount(0);
  await expect(page.getByTestId('batch-former-codes')).toContainText(run.oldCode);
  await expect(page.getByTestId('batch-rename-log')).toHaveCount(0);
});

test('cleanup: the truck, its carton and its client are gone', async () => {
  const sql = database();
  try {
    const left = await cleanup(sql, run);
    expect(left).toEqual({ receipts: 0, batches: 0, clients: 0, boxes: 0 });
  } finally {
    await sql.end();
  }
});
