import { expect, test, type Page } from '@playwright/test';
import {
  CODE,
  cleanupEarlier,
  database,
  leadNameOf,
  left,
  mint,
  newRun,
  releaseOwn,
  usage,
  type Minted,
} from './baza-stats-fixture';

/**
 * «Narxlar statistikasi» in the 📥 dialog, in a browser (his C1-C6).
 *
 * What only a browser can prove: that the strip paints beside the list,
 * that a quartile chip NAMES a declaration without drafting anything (C3),
 * that «Tanlash» drafts exactly that row through the list's own door, that
 * the statistics fold away while the search is used, and that the phone
 * gets every number and no way to pick.
 *
 * The name sorts after `m9zzy-…`, so it runs LAST in the desktop project —
 * after m9zu's own upload/delete walk. CLEANUP IS A TEST (#183/#508): two
 * READY batches dated up to today are, while alive, the batch every save in
 * the suite reads.
 */

const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';
const SHOTS = process.env.SHOTS_DIR ?? 'test-results';

async function login(page: Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(ADMIN);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const run = newRun();
let minted: Minted | null = null;
let leadName = '';
let requestUrl = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const sql = database();
  try {
    await cleanupEarlier(sql);
    minted = await mint(sql, run);
  } finally {
    await sql.end();
  }
});

test('the quarter that answers is marked, the strip names the real declaration, and only «Tanlash» drafts it', async ({
  page,
}) => {
  expect(minted).not.toBeNull();
  await login(page);

  // C6: «newest» is no longer simply the top row of the upload log.
  await page.goto('/admin/bojxona-import');
  const row = page.getByTestId('import-batch').filter({ hasText: `${run.marker}.xlsx` });
  await expect(row.getByTestId('import-answering')).toBeVisible({ timeout: 15_000 });

  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  leadName = leadNameOf(run.marker);
  await page.getByTestId('quick-name').fill(leadName);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  await page.goto((await made.getByRole('link').first().getAttribute('href'))!);

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-rastamojka').click();
  await page.getByTestId('calc-goods').fill('Искусственные цветы, 100');
  await page.getByTestId('calc-send').click();
  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  requestUrl = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;

  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-cell="weightKg"][data-row="0"]').fill('100');
  await page.locator('[data-cell="tnvedCode"][data-row="0"]').fill(CODE);
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-group-row').first()).toContainText(CODE, { timeout: 15_000 });

  // The save's own auto-fill lands on a name-matched row, never on a
  // quartile — so a 2.40 at the end can only have come from «Tanlash».
  const baza = page.getByTestId('calc-baza').last();
  await expect(baza).not.toHaveValue(/2\.4/);

  await page.getByTestId('calc-item-menu').last().click();
  await page.getByTestId('calc-import-pick').click();
  const stats = page.getByTestId('calc-import-stats');
  await expect(stats).toBeVisible({ timeout: 15_000 });

  // The kg tab: THIS unit's counts (D2) — seven from China, two from Turkey.
  const pressed = page.locator('[data-testid="calc-import-unit-chip"][aria-pressed="true"]');
  await expect(pressed).toContainText('7');
  const origin = page.getByTestId('calc-import-origin');
  await expect(origin).toContainText('7');
  await expect(origin).toContainText('2');
  await expect(stats.getByTestId('calc-import-unit-mismatch')).toHaveCount(0);

  // The dona tab says its own numbers, then back.
  await page.locator('[data-testid="calc-import-unit-chip"][aria-pressed="false"]').first().click();
  await expect(origin).toContainText('6');
  await expect(origin).toContainText('0');
  await page.locator('[data-testid="calc-import-unit-chip"][aria-pressed="false"]').first().click();
  await expect(pressed).toContainText('7');

  const all = page.getByTestId('calc-import-row-all');
  await expect(all.getByTestId('calc-import-pct-25')).toContainText('1.40');
  await expect(all.getByTestId('calc-import-pct-50')).toContainText('2.40');
  await expect(all.getByTestId('calc-import-pct-75')).toContainText('3.10');
  await expect(page.getByTestId('calc-import-prev')).toContainText('2.1');
  await expect(page.getByTestId('calc-import-row-named')).toContainText('4');

  // C3: a tap NAMES the declaration and drafts nothing.
  await all.getByTestId('calc-import-pct-50').click();
  const exemplar = page.getByTestId('calc-import-exemplar');
  await expect(exemplar).toContainText('Прочие изделия из пластмасс');
  await expect(exemplar).toContainText(/\d{4}-\d{2}-\d{2}/);
  await expect(page.getByTestId('calc-unsaved')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/baza-stats-1280.png` });

  // Only «Tanlash» does — through the list's own door.
  await page.getByTestId('calc-import-exemplar-pick').click();
  await expect(page.getByTestId('calc-import-dialog')).toBeHidden();
  await expect(page.getByTestId('calc-unsaved')).toBeVisible();
  await page.getByTestId('calc-save-table').click();
  await expect(baza).toHaveValue(/2\.4/, { timeout: 15_000 });
  await expect(page.getByTestId('calc-baza-import')).toHaveCount(1);

  // While the search holds text the statistics fold to one line, so the
  // results are on the screen and not under four hundred pixels of chart.
  // (The row's ⋯ fold is local state and may still be open from the pick.)
  if (!(await page.getByTestId('calc-import-pick').isVisible())) {
    await page.getByTestId('calc-item-menu').last().click();
  }
  await page.getByTestId('calc-import-pick').click();
  await expect(stats).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('calc-import-search').fill('пласт');
  await expect(page.getByTestId('calc-import-stats-summary')).toBeVisible();
  const first = page.getByTestId('calc-import-candidate').first();
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeLessThan(900);
  await page.getByTestId('calc-import-cancel').click();
});

test('the phone sees every number and cannot pick', async ({ browser }) => {
  expect(requestUrl).not.toBe('');
  // A bare context inherits no baseURL (round 57's `newPage()` lie).
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
  });
  try {
    const page = await ctx.newPage();
    await login(page);
    await page.goto(requestUrl);
    await page.getByTestId('calc-phone-stats').first().click();
    const dialog = page.getByTestId('calc-import-dialog');
    await expect(dialog.getByTestId('calc-import-stats')).toBeVisible({ timeout: 15_000 });
    await dialog.getByTestId('calc-import-row-all').getByTestId('calc-import-pct-50').click();
    await expect(dialog.getByTestId('calc-import-exemplar')).toBeVisible();
    await expect(dialog.getByTestId('calc-import-exemplar-pick')).toHaveCount(0);
    await expect(dialog.getByTestId('calc-import-exemplar-viewonly')).toBeVisible();
    // The list is shown and cannot be pressed.
    await expect(dialog.getByTestId('calc-import-candidate').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('button[data-testid="calc-import-candidate"]')).toHaveCount(0);
    await expect(dialog.getByTestId('calc-import-viewonly')).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(360);
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    await page.screenshot({ path: `${SHOTS}/baza-stats-360.png` });
  } finally {
    await ctx.close();
  }
});

test('cleanup: the price becomes the VED’s, the job is answered, the batches go', async ({ page }) => {
  expect(minted).not.toBeNull();
  expect(requestUrl).not.toBe('');
  await login(page);
  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });

  // A number the VED types is theirs — the provenance goes with the price.
  await page.getByTestId('calc-baza').last().fill('9');
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-baza-import')).toHaveCount(0, { timeout: 15_000 });

  {
    const take = page.getByTestId('calc-take');
    if (await take.count()) await take.click();
    await page.getByTestId('calc-finish-open').click();
    await page.getByTestId('calc-answer-amount').fill('100');
    await page.getByTestId('calc-answer-internal').fill('e2e tozalash');
    await page.getByTestId('calc-finish').click();
    await expect(page.getByTestId('calc-answer')).toBeVisible({ timeout: 15_000 });
  }

  const sql = database();
  try {
    const ids = [minted!.currentId, minted!.previousId];
    for (const id of ids) {
      // Only THIS run's request may let go of its provenance here.
      if ((await usage(sql, id)) > 0) await releaseOwn(sql, run.marker, id);
      // Still priced off it: a FOREIGN row took a price from the spec's batch.
      // Deleting would silently strip its provenance — fail instead.
      expect(await usage(sql, id), `a foreign row is priced off ${id}`).toBe(0);
    }
    await sql`DELETE FROM customs_import_batches WHERE id IN ${sql(ids)}`;
    expect(await left(sql, run)).toBe(0);
  } finally {
    await sql.end();
  }

  // …and the lead this walk created goes too.
  await page.goto('/crm?scope=all');
  const card = page.getByTestId('funnel-desktop').getByTestId('lead-card').filter({ hasText: leadName }).first();
  if ((await card.count()) === 0) return;
  await card.getByTestId('card-select').click();
  const bar = page.getByTestId('bulk-bar');
  const lost = await bar.getByTestId('bulk-stage').locator('option[data-kind="lost"]').first().getAttribute('value');
  await bar.getByTestId('bulk-stage').selectOption(lost!);
  await bar.getByTestId('bulk-reason').fill('e2e tozalash');
  await bar.getByTestId('bulk-move').click();
  await expect(bar.getByTestId('bulk-result')).toContainText('1', { timeout: 15_000 });
});
