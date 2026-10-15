import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { cleanupAll, database, mint, newRun, PASSWORD } from './qarz-izoh-fixture';

/**
 * A debtor's cargo released with a MANDATORY comment (0126 — the owner's
 * D2 «sklad mudiri so'ramasdan beraversin», D4a, D6a), in a real browser on
 * the phone project (360 px):
 *
 *  1. the spec's own TAS1 warehouse manager opens /issue: the debt banner
 *     carries the tick INSIDE it (the page flow) and no «Ruxsat so'rash»; the
 *     fixed bar says why «Topshirish» is grey until the tick has its reason,
 *     and the line takes him to the tick (DEBT-2);
 *     the tick asks WHY, «Topshirish» waits for a non-blank reason, a 60-character
 *     unbroken token does not widen the phone, and the act downloads (that the
 *     act does NOT carry the reason is the source fence's job — the act draws
 *     CJK glyph ids, so a byte search would be vacuous);
 *  2. the accountant reads the reason on «Qarzga berilgan yuklar»;
 *  3. the admin reads it on the client card's lenta; a seller who is not the
 *     client's opens the same card and the reason is not there (the money
 *     door, in pixels);
 *  4. cleanup, a final TEST (round 57's `afterAll` lie): every run's rows go,
 *     the minted manager is DEACTIVATED.
 *
 * NOT serial, on purpose (m9zzs's reason): a failure must not skip the
 * cleanup. Each test resolves its rows from the database by the marker's
 * shape, never from a variable a dead worker held (#523).
 */

const ACCOUNTANT = '+998900000010';
const ADMIN = '+998900000002';
const SELLER = '+998900000009'; // Dilnoza — not this client's seller
const DEMO_PASSWORD = 'demo1234';
const TOKEN = `QIZOH${'0123456789'.repeat(5)}ABCDE`; // 60 characters, no break opportunity
const NOTE = `ertaga to‘laydi e2e ${TOKEN}`;
const KIND_TICK = (JSON.parse(readFileSync('messages/ru.json', 'utf8')) as { qarz: { releases: { kindTick: string } } })
  .qarz.releases.kindTick;

async function login(page: Page, phone: string, password: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** The document is exactly the phone: no overflow, and no zoom-out (#400, e2e-width-oracle). */
async function fitsThePhone(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(client).toBe(360);
  expect(scroll).toBeLessThanOrEqual(client);
}

/**
 * THIS run's released client — what steps 2 and 3 are about (the review's
 * DEBT-5). Released by a still-ACTIVE «QI manager» (step 1 deactivates every
 * earlier run's manager before it mints its own, and the cleanup test is
 * last), with this spec's exact reason, minted in the last half hour: an
 * earlier run's leftover on a long-lived database cannot answer for this
 * one. Resolved from the database, never from a variable — a worker that
 * died in step 1 is gone (#523).
 */
async function releasedRun(): Promise<{ clientId: string; code: string }> {
  const sql = database();
  try {
    const [row] = await sql<{ id: string; client_code: string }[]>`
      SELECT c.id, c.client_code FROM clients c
       WHERE c.client_code ~ '^QI[0-9]{6}$' AND c.name = 'Qarz izoh ' || c.client_code
         AND c.created_at > now() - interval '30 minutes'
         AND EXISTS (SELECT 1 FROM handovers h JOIN users u ON u.id = h.created_by
                      WHERE h.client_id = c.id AND h.debt_note = ${NOTE}
                        AND u.full_name LIKE 'QI manager %' AND u.active)
       ORDER BY c.created_at DESC LIMIT 1`;
    expect(row, 'step 1 released a QI client on debt').toBeDefined();
    return { clientId: row!.id, code: row!.client_code };
  } finally {
    await sql.end();
  }
}

test('the warehouse manager releases a debtor’s cargo at his own counter — with a reason, never without', async ({ page }) => {
  const run = newRun();
  const sql = database();
  try {
    await cleanupAll(sql);
    await mint(sql, run);
  } finally {
    await sql.end();
  }

  await login(page, run.managerPhone, PASSWORD);
  await page.goto('/issue');
  // TAS1 is his only warehouse.
  await expect(page.getByTestId('issue-wh')).toHaveValue(/.+/);
  const searchSettled = page.waitForResponse((r) => r.url().includes('/api/clients/search'));
  await page.locator('#issueClientQuery').fill(run.marker);
  await searchSettled;
  await page.getByRole('button', { name: new RegExp(run.marker) }).first().click();

  const firstLot = page.locator('#issuable-boxes > div').first();
  await expect(firstLot).toBeVisible({ timeout: 10_000 });
  await firstLot.locator('button').first().click();
  await page.getByTestId('receiver-name').fill('Haydovchi Olim');
  await page.getByTestId('receiver-phone').fill('+998907776655');

  // D1 → D2 in pixels: the tick, and no request to make.
  const tick = page.getByTestId('issue-debt-ok');
  await expect(tick).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('ask-approval')).toHaveCount(0);
  const confirm = page.getByTestId('confirm-issue');
  await expect(confirm).toBeDisabled();

  // DEBT-2: the bar says WHY «Topshirish» is grey — beside the button, after
  // the person has scrolled past the banner — and the line takes him back.
  const hint = page.getByTestId('issue-debt-hint');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(hint).toBeVisible();
  const hintBox = (await hint.boundingBox())!;
  const barWithHint = (await page.locator('.pb-safe.fixed').boundingBox())!;
  const confirmWithHint = (await confirm.boundingBox())!;
  expect(hintBox.y).toBeGreaterThanOrEqual(barWithHint.y);
  expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(confirmWithHint.y);
  // The line the bar grew by is paid for: the last lot still ends above it.
  const lotsWithHint = (await page.locator('#issuable-boxes').boundingBox())!;
  expect(lotsWithHint.y + lotsWithHint.height).toBeLessThanOrEqual(barWithHint.y);
  await fitsThePhone(page);
  await hint.click();
  await expect(tick).toBeFocused();
  await expect(tick).toBeInViewport();

  await tick.check();
  const note = page.getByTestId('issue-debt-note');
  await expect(note).toBeVisible();
  // A USED tick waits for its reason — a blank one is no reason, and the
  // bar keeps saying so.
  await expect(confirm).toBeDisabled();
  await expect(hint).toBeVisible();
  await note.fill('   ');
  await expect(confirm).toBeDisabled();
  await expect(hint).toBeVisible();
  await note.fill(NOTE);
  await expect(confirm).toBeEnabled();
  await expect(hint).toHaveCount(0);

  await fitsThePhone(page);
  // «Topshirish» is inside the viewport, and nothing in the page flow hides
  // under the fixed bar once the page is scrolled to its end.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const button = (await confirm.boundingBox())!;
  expect(button.y + button.height).toBeLessThanOrEqual(800);
  const bar = (await page.locator('.pb-safe.fixed').boundingBox())!;
  const lastLot = (await page.locator('#issuable-boxes').boundingBox())!;
  expect(lastLot.y + lastLot.height).toBeLessThanOrEqual(bar.y);
  // The tick and its reason sit in the page flow, clear of the fixed bar.
  await note.scrollIntoViewIfNeeded();
  const noteNow = (await note.boundingBox())!;
  const barNow = (await page.locator('.pb-safe.fixed').boundingBox())!;
  expect(noteNow.y + noteNow.height).toBeLessThanOrEqual(barNow.y);

  await confirm.click();
  await expect(page.getByTestId('act-link')).toBeVisible({ timeout: 15_000 });
  // THIS run's handover carries THIS reason, whole (DEBT-5) — what steps 2
  // and 3 then find on the register and the lenta.
  const db = database();
  try {
    const stored = await db<{ debt_note: string | null }[]>`
      SELECT h.debt_note FROM handovers h JOIN clients c ON c.id = h.client_id WHERE c.client_code = ${run.marker}`;
    expect(stored.map((row) => row.debt_note)).toEqual([NOTE]);
  } finally {
    await db.end();
  }
  const actHref = await page.getByTestId('act-link').getAttribute('href');
  const act = await page.request.get(actHref!);
  expect(act.status()).toBe(200);
  expect((await act.body()).subarray(0, 4).toString()).toBe('%PDF');
});

test('the accountant reads the reason on «Qarzga berilgan yuklar», and the phone is not widened', async ({ page }) => {
  const { code } = await releasedRun();
  await login(page, ACCOUNTANT, DEMO_PASSWORD);
  await page.goto('/finance/qarzga-berilgan?hammasi=1');
  const row = page.getByTestId('release-row').filter({ hasText: code });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('release-note')).toContainText('ertaga to‘laydi e2e');
  await expect(row.getByTestId('release-kind')).toHaveText(KIND_TICK);
  await fitsThePhone(page);
});

test('the admin reads it on the client card’s lenta; a seller who is not the client’s does not', async ({ page }) => {
  const { clientId } = await releasedRun();
  await login(page, ADMIN, DEMO_PASSWORD);
  await page.goto(`/admin/clients/${clientId}`);
  const reason = page.getByTestId('feed-handover').getByTestId('feed-debt-note');
  await expect(reason).toBeVisible({ timeout: 15_000 });
  await expect(reason).toContainText('ertaga to‘laydi e2e');
  await fitsThePhone(page);

  await login(page, SELLER, DEMO_PASSWORD);
  const opened = await page.goto(`/admin/clients/${clientId}`);
  expect(opened?.status()).toBe(200);
  // The card renders for her (her `clients.view_own`) — the lenta's handover
  // line is there, so the absence below is about the money door and not
  // about a lenta that never loaded.
  await expect(page.getByTestId('feed-handover').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('feed-debt-note')).toHaveCount(0);
});

test('cleanup: every run’s rows go and the minted manager is deactivated', async () => {
  const sql = database();
  try {
    const left = await cleanupAll(sql);
    expect(left).toEqual({ issuable: 0, activeManagers: 0 });
  } finally {
    await sql.end();
  }
});
