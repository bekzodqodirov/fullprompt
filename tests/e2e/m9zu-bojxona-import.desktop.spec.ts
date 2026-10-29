import { expect, test } from '@playwright/test';
import { normalizeName } from '@/modules/wms/customs/import-parse';
import { cleanupEarlier, database } from './baza-stats-fixture';

/**
 * The quarterly customs dump, in a browser (docs/VED-IMPORT-AI.md §2).
 *
 * What only a browser can prove: that the admin's upload lands, that the
 * background parse settles the row READY without anybody reloading by hand,
 * that a calculation whose product matches a declaration comes back with its
 * baza filled and wearing the «📥 taxmin» chip, and that the ⋯ picker offers
 * the file's own rows for the VED to choose from.
 *
 * CLEANUP IS A TEST (#183/#508, #57's lie). A ready import is the loudest
 * CONFIGURATION this suite can leave behind: it fills the baza of every
 * coded row with an empty one, on every later save, in every later spec. The
 * last test retypes the price (which releases the provenance) and then
 * removes the batch through its own button.
 */

const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';
const FIXTURE = 'tests/fixtures/customs-import-sample.xlsx';
/** The fixture's first declaration: a per-kg nonwoven at $1.7548/kg. */
const CODE = '5603139000';
const GOODS = 'Нетканый материал из химических нитей в рулонах';

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(ADMIN);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

let leadName = '';
let requestUrl = '';

test.describe.configure({ mode: 'serial' });

// A crashed m9zzz leaves batches dated TODAY, which under C6 outrank this
// spec's fixture (dated in its own past) for ever — swept first.
test.beforeAll(async () => {
  const sql = database();
  try {
    await cleanupEarlier(sql);
  } finally {
    await sql.end();
  }
});

test('the admin uploads the quarter and the parse settles it READY', async ({ page }) => {
  await login(page);
  await page.goto('/admin/bojxona-import');
  await expect(page.getByTestId('customs-import')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('import-file').setInputFiles(FIXTURE);
  await page.getByTestId('import-upload').click();
  await expect(page.getByTestId('import-queued')).toBeVisible({ timeout: 15_000 });

  // The row is the progress bar: the request only stored the bytes, and the
  // screen refreshes itself while anything is still being parsed.
  await expect(page.getByTestId('import-ready').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('import-batch').first()).toContainText('customs-import-sample');
});

test('a coded row with an empty baza comes back priced from the file', async ({ page }) => {
  await login(page);

  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  leadName = `VED import e2e ${Date.now()}`;
  await page.getByTestId('quick-name').fill(leadName);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  await page.goto((await made.getByRole('link').first().getAttribute('href'))!);

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-rastamojka').click();
  await page.getByTestId('calc-goods').fill(`${GOODS}, 100`);
  await page.getByTestId('calc-send').click();
  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  requestUrl = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;

  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });

  // The row states a WEIGHT, so a per-kg declaration can price it; the code
  // is advalor, so the law pins no unit and kilograms are asked for first.
  await page.locator('[data-cell="weightKg"][data-row="0"]').fill('100');
  await page.locator('[data-cell="tnvedCode"][data-row="0"]').fill(CODE);
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-group-row').first()).toContainText(CODE, {
    timeout: 15_000,
  });

  // Nobody typed a price, and the row is not empty: the save says which rows
  // it filled, and the row itself says the number is an estimate.
  await expect(page.getByTestId('calc-save-note')).toContainText('📥');
  await expect(page.getByTestId('calc-baza-import')).toHaveCount(1);
  await expect(page.getByTestId('calc-baza').last()).toHaveValue(/1\.75/);
});

test('the ⋯ offers the file’s own declarations to pick from', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page);
  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('calc-item-menu').last().click();
  await page.getByTestId('calc-import-pick').click();
  const candidates = page.getByTestId('calc-import-candidate');
  await expect(candidates.first()).toBeVisible({ timeout: 15_000 });
  // Every candidate names its price and the unit it is priced in — the VED
  // is choosing a declaration, not a number.
  await expect(candidates.first()).toContainText('$');
  await candidates.first().click();
  await expect(page.getByTestId('calc-unsaved')).toBeVisible();
});

test('cleanup: the price becomes the VED’s and the import is removed', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page);
  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });

  // A number the VED types is theirs — the provenance goes with the price it
  // explained, so nothing is left pointing at the import.
  await page.getByTestId('calc-baza').last().fill('9');
  await page.getByTestId('calc-save-table').click();
  await expect(page.getByTestId('calc-baza-import')).toHaveCount(0, { timeout: 15_000 });

  // The job itself is answered (review tests-completeness-20): an open
  // request — and its timed task — would otherwise outlive this spec on
  // whichever seeded VED the rota picked, for every later spec to inherit.
  {
    const take = page.getByTestId('calc-take');
    if (await take.count()) await take.click();
    await page.getByTestId('calc-finish-open').click();
    await page.getByTestId('calc-answer-amount').fill('100');
    await page.getByTestId('calc-answer-internal').fill('e2e tozalash');
    await page.getByTestId('calc-finish').click();
    await expect(page.getByTestId('calc-answer')).toBeVisible({ timeout: 15_000 });
  }

  await page.goto('/admin/bojxona-import');
  const rows = page.getByTestId('import-batch');
  const before = await rows.count();
  page.once('dialog', (d) => void d.accept());
  await rows.first().getByTestId('import-delete').click();
  await expect(rows).toHaveCount(before - 1, { timeout: 15_000 });

  // …and the lead this walk created goes too.
  await page.goto('/crm?scope=all');
  const card = page
    .getByTestId('funnel-desktop')
    .getByTestId('lead-card')
    .filter({ hasText: leadName })
    .first();
  if ((await card.count()) === 0) return;
  await card.getByTestId('card-select').click();
  const bar = page.getByTestId('bulk-bar');
  const lost = await bar
    .getByTestId('bulk-stage')
    .locator('option[data-kind="lost"]')
    .first()
    .getAttribute('value');
  await bar.getByTestId('bulk-stage').selectOption(lost!);
  await bar.getByTestId('bulk-reason').fill('e2e tozalash');
  await bar.getByTestId('bulk-move').click();
  await expect(bar.getByTestId('bulk-result')).toContainText('1', { timeout: 15_000 });
});

/**
 * Round 2 (docs/SAKKIZ-R2.md §7.4): a row coded only by its HEADING opens the
 * 📥 list on the heading's declarations, each wearing its own code, and a
 * «Tanlash» drafts that code WITH the price — what only a browser can prove
 * is the client draft carrying both to the save.
 *
 * Its OWN batch (minted, never uploaded — the upload is the first test's
 * subject) and its OWN cleanup, in a `finally`: a ready batch is CONFIGURATION
 * (#183), and this one is named `HD<digits>` so nothing else claims it.
 */
test('a heading row picks a declaration from the 📥 list, and the code lands with the price', async ({ page }) => {
  const sql = database();
  const marker = `HD${String(Date.now()).slice(-7)}`;
  const HEADING = '6702';
  const FULL = '6702100000';
  const declared = `Искусственные цветы из пластмассы ${marker}`;
  const lead = `VED heading e2e ${marker}`;
  let batchId = '';
  try {
    const [owner] = await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = ${ADMIN}`;
    const [today] = await sql<{ d: string }[]>`SELECT (now() AT TIME ZONE 'Asia/Tashkent')::date::text AS d`;
    const [batch] = await sql<{ id: string }[]>`
      INSERT INTO customs_import_batches (file_name, uploaded_by, status, period_from, period_to, uploaded_at, row_count)
      VALUES (${`${marker}.xlsx`}, ${owner!.id}, 'ready', ${today!.d}::date - 30, ${today!.d}::date, now(), 1)
      RETURNING id`;
    batchId = batch!.id;
    await sql`
      INSERT INTO customs_import_rows (batch_id, tnved_code, name, name_norm, unit, price_per_unit_usd, origin_country)
      VALUES (${batchId}, ${FULL}, ${declared}, ${normalizeName(declared)}, 'kg', 2.35::numeric, '156-КИТАЙ')`;

    await login(page);
    await page.goto('/crm');
    await page.getByTestId('quick-create').click();
    const pickLead = page.getByTestId('quick-kind-lead');
    if (await pickLead.count()) await pickLead.click();
    await page.getByTestId('quick-name').fill(lead);
    await page.getByTestId('quick-save').click();
    const made = page.getByTestId('quick-made');
    await expect(made).toBeVisible({ timeout: 15_000 });
    await page.goto((await made.getByRole('link').first().getAttribute('href'))!);
    await page.getByTestId('calc-panel').click();
    await page.getByTestId('calc-section-rastamojka').click();
    await page.getByTestId('calc-goods').fill(`${declared}, 10`);
    // The shipment's m³ — the one line's own, once the table says so below.
    await page.getByTestId('calc-volume').fill('1.5');
    await page.getByTestId('calc-send').click();
    await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
    const url = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;

    await page.goto(url);
    await expect(page.getByTestId('calc-table')).toBeVisible({ timeout: 15_000 });
    // The m³ cell every section prints (review P2-2/P2-3): typed, it is the
    // seller's figure and wears no label…
    await expect(page.getByTestId('calc-request-volume')).toBeVisible();
    await expect(page.getByTestId('calc-volume-from-lines')).toHaveCount(0);
    await page.locator('[data-cell="weightKg"][data-row="0"]').fill('10');
    await page.locator('[data-cell="volumeM3"][data-row="0"]').fill('1.5');
    await page.locator('[data-cell="tnvedCode"][data-row="0"]').fill(HEADING);
    await page.getByTestId('calc-save-table').click();
    await expect(page.getByTestId('calc-group-row').first()).toContainText(HEADING, { timeout: 15_000 });
    // …and once it IS the Σ of the lines, on a rastamojka job where the
    // reconcile is blind to it, the cell says so.
    await expect(page.getByTestId('calc-request-volume').getByTestId('calc-volume-from-lines')).toBeVisible();

    // The heading's list: the declaration names ITS code, because picking it
    // picks the code.
    await page.getByTestId('calc-item-menu').last().click();
    await page.getByTestId('calc-import-pick').click();
    const candidate = page.getByTestId('calc-import-candidate').first();
    await expect(candidate).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('calc-import-code').first()).toContainText(FULL);
    await candidate.click();
    await expect(page.getByTestId('calc-unsaved')).toBeVisible();
    await page.getByTestId('calc-save-table').click();
    await expect(page.getByTestId('calc-group-row').first()).toContainText(FULL, { timeout: 15_000 });

    // The database is the oracle: the ten digits and the FILE's price, the
    // file's provenance — and no machine's reason: a person chose this code.
    const rows = await sql<{ tnved_code: string; baza_usd: string; baza_source: string; baza_reason: string | null }[]>`
      SELECT i.tnved_code, i.baza_usd::text AS baza_usd, i.baza_source, i.baza_reason
        FROM calc_request_items i
        JOIN calc_requests r ON r.id = i.request_id
        JOIN leads l ON l.id = r.entity_id AND r.entity_type = 'lead'
       WHERE l.name = ${lead}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tnved_code).toBe(FULL);
    expect(Number(rows[0]!.baza_usd)).toBe(2.35);
    expect(rows[0]!.baza_source).toBe('import');
    expect(rows[0]!.baza_reason).toBeNull();

    // The job is answered, like the walk above it (an open request and its
    // timed task would outlive this spec on whichever VED the rota picked).
    const take = page.getByTestId('calc-take');
    if (await take.count()) await take.click();
    await page.getByTestId('calc-finish-open').click();
    await page.getByTestId('calc-answer-amount').fill('100');
    await page.getByTestId('calc-answer-internal').fill('e2e tozalash');
    await page.getByTestId('calc-finish').click();
    await expect(page.getByTestId('calc-answer')).toBeVisible({ timeout: 15_000 });

    await page.goto('/crm?scope=all');
    const card = page.getByTestId('funnel-desktop').getByTestId('lead-card').filter({ hasText: lead }).first();
    if ((await card.count()) > 0) {
      await card.getByTestId('card-select').click();
      const bar = page.getByTestId('bulk-bar');
      const lost = await bar.getByTestId('bulk-stage').locator('option[data-kind="lost"]').first().getAttribute('value');
      await bar.getByTestId('bulk-stage').selectOption(lost!);
      await bar.getByTestId('bulk-reason').fill('e2e tozalash');
      await bar.getByTestId('bulk-move').click();
      await expect(bar.getByTestId('bulk-result')).toContainText('1', { timeout: 15_000 });
    }
  } finally {
    // The provenance this walk took lets go, then the batch goes (raw: the
    // service refuses a batch something is priced off, on purpose).
    if (batchId) {
      await sql`UPDATE calc_request_items SET import_row_id = NULL
                 WHERE import_row_id IN (SELECT id FROM customs_import_rows WHERE batch_id = ${batchId})`;
      await sql`DELETE FROM customs_import_batches WHERE id = ${batchId}`;
    }
    await sql.end();
  }
});
