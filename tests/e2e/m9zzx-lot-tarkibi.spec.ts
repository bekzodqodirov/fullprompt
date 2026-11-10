import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import { cleanup, cleanupEarlier, database, memoryRows, mint, newRun, type Minted } from './lot-tarkibi-fixture';
import { readInvoiceSheet } from '../fixtures/invoice-sheet';

/**
 * Lot tarkibi in a real browser (docs/LOT-TARKIBI.md §11.4): the owner's case
 * — 100 cartons received as «klaviatura» that the client's papers say are 50
 * keyboards + 50 mice — stated by the VED on a phone, read back on the
 * truck's Bojxona tab and in the customs invoice, frozen by the «hujjat
 * yuborildi» tick, and refused to the warehouse.
 *
 * What only a browser can show: the live remainder counts per measure, the
 * sticky bar is on screen while a cell has focus, a refused save keeps every
 * typed value (#171), the tarkib saves with NO document (optional since
 * 2026-11-10 — docs/TARKIB-TUZATISH.md §2) and one can be uploaded from the
 * editor afterwards, the card's lot header then reads «Клавиатура +1» (§3),
 * and on the Bojxona tab typing the mouse's code leaves the keyboard's line
 * EMPTY (the judge's blocker R1: a `lotId` key wrote both). Since 2026-11-10
 * every tarkib line has its 🤖 and the bulk button counts lines (§5 — there
 * is no AI key here or in CI, so what a browser proves is the button, its
 * count and the honest refusal), and «Invoys» ASKS before it merges two
 * names under one code (§6): the dialog, the merged position, the stickers
 * in red when the lot stays apart.
 * The rules underneath are proven in
 * tests/integration/lot-composition.integration.test.ts.
 *
 * The prixod and the truck are this spec's own (lot-tarkibi-fixture.ts); the
 * last TEST deletes them and proves nothing carries the marker and the TNVED
 * memory rows are as found (round 57's `afterAll` lie).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const VED = '+998900000004';
const LOGIST = '+998900000003';
const YW_OPERATOR = '+998900000006';
/** Where every spec here leaves its screenshots (the CI artifact). */
const SHOTS = 'test-results';
const run = newRun();
let minted: Minted | null = null;
let memoryAtMint: string[] = [];
let documentId = '';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const receiptPath = () => `/receipts/${minted!.receiptId}`;
const tnvedPath = () => `/batches/${minted!.truckId}/tnved`;

async function widths(page: Page) {
  return page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
}

/** The customs invoice's table rows, parsed the way customs reads them — by header (a column was added after «№»). */
async function invoice(page: Page, query = '') {
  const res = await page.request.get(`/api/batches/${minted!.truckId}/invoice${query}`);
  expect(res.status()).toBe(200);
  const { rows } = await readInvoiceSheet(await res.body());
  return rows.map((r) => ({
    product: r.product,
    code: r.code,
    unit: r.unit,
    places: r.places,
    brutto: r.brutto,
    note: r.note,
    marks: r.marks,
    redMarks: r.redMarks,
  }));
}

const line = (page: Page, i: number) => page.getByTestId('tarkib-line').nth(i);

/** The invoice the BROWSER was handed — the file behind a download event, read by header. */
async function downloaded(file: Download) {
  const { rows } = await readInvoiceSheet(readFileSync((await file.path())!));
  return rows.map((r) => ({
    product: r.product,
    code: r.code,
    unit: r.unit,
    quantity: r.quantity,
    places: r.places,
    brutto: r.brutto,
    marks: r.marks,
    redMarks: r.redMarks,
  }));
}

test('mint: the owner’s case, 100 cartons of «键盘» on a truck on the road', async () => {
  const sql = database();
  try {
    await cleanupEarlier(sql);
    minted = await mint(sql, run);
    memoryAtMint = await memoryRows(sql, run);
  } finally {
    await sql.end();
  }
});

test('the VED composes on the phone: no document demanded, the remainder per measure, a refusal that keeps every value', async ({ page }) => {
  // A failed test restarts the worker and resets this module (round 62).
  expect(minted).not.toBeNull();
  await login(page, VED);
  await page.goto(receiptPath());
  // The owner's 1a: the VED states a composition and never renames the lot —
  // the lot form (`receipts.edit`, the logist's ✏️ below) is not drawn for him.
  const lotCard = page.locator(`#lot-${minted!.lotId}`);
  await expect(lotCard).toBeVisible();
  await expect(lotCard.getByRole('button', { name: /✏️/ })).toHaveCount(0);
  const panel = page.getByTestId('lot-tarkib');
  await panel.getByTestId('lot-tarkib-open').click();
  await expect(page.getByTestId('tarkib-editor')).toBeVisible();

  // Before any tarkib the card calls the lot by its own name alone.
  await expect(lotCard.getByTestId('lot-name')).toHaveText(run.lotName);

  // ONE row to begin with (his 2026-10-27: a tarkib may be one good) — no
  // alohida/aralash to choose and no carton cell until there is a second
  // good, and «Bitta tovar» offers to fill the row from the lot.
  await expect(page.getByTestId('tarkib-line')).toHaveCount(1);
  await expect(page.getByTestId('tarkib-mode-separate')).toHaveCount(0);
  await expect(page.getByTestId('tarkib-one-good')).toBeVisible();
  await page.getByTestId('tarkib-add-line').click();
  await expect(page.getByTestId('tarkib-line')).toHaveCount(2);
  await expect(page.getByTestId('tarkib-mode-separate')).toBeVisible();
  await expect(page.getByTestId('tarkib-one-good')).toHaveCount(0);

  await line(page, 0).getByTestId('tarkib-name').fill('Клавиатура');
  await line(page, 0).getByTestId('tarkib-pieces').fill('500');
  await line(page, 0).getByTestId('tarkib-cartons').fill('50');
  await line(page, 1).getByTestId('tarkib-name').fill('Мышь');
  await line(page, 1).getByTestId('tarkib-pieces').fill('1000');
  await line(page, 1).getByTestId('tarkib-cartons').fill('50');
  // What the lists will call the lot from now on (items 3-4), said BEFORE the
  // save: the first good and how many more.
  await expect(page.getByTestId('tarkib-shown-name')).toContainText('Клавиатура +1');
  // «Jami dona» is the TOTAL — the per-carton figure says so out loud.
  await expect(line(page, 0).getByTestId('tarkib-per-carton')).toContainText('= 10 ');

  await page.getByTestId('tarkib-prefill').click();
  await expect(line(page, 0).getByTestId('tarkib-kg')).toHaveValue('500.000');
  await expect(line(page, 1).getByTestId('tarkib-kg')).toHaveValue('500.000');
  await expect(line(page, 0).getByTestId('tarkib-m3')).toHaveValue('1.2500');
  await expect(line(page, 1).getByTestId('tarkib-m3')).toHaveValue('1.2500');

  await line(page, 0).getByTestId('tarkib-kg').fill('600');
  const remainder = page.getByTestId('tarkib-remainder');
  await expect(remainder).toContainText('+100.000');
  await expect(remainder).toContainText('m³ ✓');

  // Refused — the kilos do not add up — and every typed value stays (#171).
  await page.getByTestId('tarkib-save').click();
  await expect(page.getByTestId('tarkib-error')).toBeVisible();
  await expect(line(page, 1).getByTestId('tarkib-name')).toHaveValue('Мышь');
  await expect(line(page, 0).getByTestId('tarkib-kg')).toHaveValue('600');
  await expect(line(page, 1).getByTestId('tarkib-kg')).toHaveValue('500.000');

  // «=» balances ONE field of one row: kg, and the m³ stays as it was.
  await line(page, 1).getByTestId('tarkib-fill-kg').click();
  await expect(line(page, 1).getByTestId('tarkib-kg')).toHaveValue('400.000');
  await expect(line(page, 1).getByTestId('tarkib-m3')).toHaveValue('1.2500');
  await expect(remainder).not.toContainText('+');
  expect(((await remainder.textContent()) ?? '').split('✓').length - 1).toBe(3);

  // The phone: nothing wider than the screen (#400, measured by the
  // document — never `innerWidth`, #1241), cells a thumb can use, and the
  // remainder + «Saqlash» on screen while a cell has focus.
  const w = await widths(page);
  expect(w.client).toBe(360);
  expect(w.scroll).toBeLessThanOrEqual(360);
  for (const id of ['tarkib-kg', 'tarkib-m3']) {
    for (const box of await page.getByTestId(id).all()) {
      expect((await box.boundingBox())!.width).toBeGreaterThanOrEqual(120);
    }
  }
  await line(page, 0).getByTestId('tarkib-kg').focus();
  for (const id of ['tarkib-remainder', 'tarkib-save']) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
  }
  await page.screenshot({ path: `${SHOTS}/lot-receipt-editor-360.png`, fullPage: true });

  // NO document is asked for (the owner, 2026-11-10: «tarkib qo'shganda
  // tasdiq so'rash rasm file»): no chip chosen, and it saves. The editor
  // closes, the face lists both goods and cites no file.
  await expect(page.getByTestId('tarkib-doc')).toHaveCount(0);
  await page.getByTestId('tarkib-save').click();
  await expect(page.getByTestId('tarkib-saved')).toBeVisible();
  await expect(page.getByTestId('tarkib-editor')).toHaveCount(0);
  await expect(page.getByTestId('lot-tarkib')).toContainText('Клавиатура · Мышь');
  await expect(page.getByTestId('lot-tarkib').locator('a[href^="/api/attachments/"]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('lot-tarkib')).toContainText('Клавиатура · Мышь');
  // …and the card's lot header reads the tarkib's name where the Russian
  // name stands (items 3-4): the first good and how many more.
  await expect(lotCard.getByTestId('lot-name')).toHaveText(`${run.lotName} (Клавиатура +1)`);

  // The client's packing list can still be filed — uploaded from the editor
  // onto THIS prixod, chosen by itself, and cited by the next save.
  await panel.getByTestId('lot-tarkib-open').click();
  await expect(page.getByTestId('tarkib-editor')).toBeVisible();
  await page.getByTestId('tarkib-upload').setInputFiles({
    name: 'packing.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
  });
  const chip = page.getByTestId('tarkib-doc').filter({ hasText: 'packing.pdf' });
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  documentId = (await chip.getAttribute('data-id'))!;
  expect(documentId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByTestId('tarkib-save').click();
  await expect(page.getByTestId('tarkib-saved')).toBeVisible();
  await expect(page.getByTestId('lot-tarkib').locator(`a[href="/api/attachments/${documentId}"]`)).toHaveCount(1);
});

test('the Bojxona tab: two line rows, the mouse’s code never lands on the keyboard', async ({ page }) => {
  expect(minted).not.toBeNull();
  await login(page, VED);
  await page.goto(tnvedPath());
  const rows = page.getByTestId('tnved-tarkib-row');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('tnved-row').filter({ hasText: run.lotName })).toHaveCount(0);
  const keyboard = rows.filter({ hasText: 'Клавиатура' });
  const mouse = rows.filter({ hasText: 'Мышь' });

  // Item 5: a tarkib line has its 🤖, and the bulk button counts the lines —
  // a truck of composed lots used to have no AI at all. With no key the
  // press is refused IN WORDS and the walk stops at the first shut door
  // instead of pressing it once per row; with one, the answer lands under
  // the row. Either way nothing is written and the button comes back.
  await expect(rows.getByTestId('tnved-tarkib-ai')).toHaveCount(2);
  await expect(page.getByTestId('tnved-ai-all')).toContainText('(2)');
  await mouse.getByTestId('tnved-tarkib-ai').click();
  await expect(page.getByTestId('tnved-error').or(mouse.getByTestId('tnved-ai-note'))).toBeVisible();
  await expect(mouse.getByTestId('tnved-tarkib-ai')).toBeEnabled();
  if (await page.getByTestId('tnved-error').isVisible()) {
    await expect(mouse.getByTestId('tnved-tarkib-code')).toHaveValue('');
    await page.getByTestId('tnved-ai-all').click();
    await expect(page.getByTestId('tnved-ai-all')).toBeEnabled();
    await expect(page.getByTestId('tnved-ai-all')).toContainText('(2)');
    await expect(keyboard.getByTestId('tnved-tarkib-code')).toHaveValue('');
  }
  // The invoice button beside the editor knows nothing is typed yet…
  await expect(page.locator('[data-tnved-unsaved]')).toHaveAttribute('data-tnved-unsaved', '0');

  await mouse.getByTestId('tnved-tarkib-code').fill('8471607000');
  await expect(page.locator('[data-tnved-unsaved]')).toHaveAttribute('data-tnved-unsaved', '1');
  // R1, the blocker: per-row state keyed by the lot wrote this into BOTH.
  await expect(keyboard.getByTestId('tnved-tarkib-code')).toHaveValue('');
  await page.screenshot({ path: `${SHOTS}/lot-tnved-tab-360.png`, fullPage: true });
  expect((await widths(page)).scroll).toBeLessThanOrEqual(360);
  await page.getByTestId('tnved-save').click();
  // The ✅ outlives the editor's re-seed (its key carries the revisions).
  await expect(page.getByTestId('tnved-saved')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('tnved-tarkib-row').filter({ hasText: 'Мышь' }).getByTestId('tnved-tarkib-code')).toHaveValue(
    '8471607000',
  );
  await expect(page.getByTestId('tnved-tarkib-row').filter({ hasText: 'Клавиатура' }).getByTestId('tnved-tarkib-code')).toHaveValue('');

  // The prixod's own papers, folded, on the truck's tab.
  await page.getByTestId('receipt-docs').click();
  await expect(page.locator('a[title="packing.pdf"]')).toBeVisible();
});

test('the customs invoice prints the two goods, each with its own weight, places and code', async ({ page }) => {
  expect(minted).not.toBeNull();
  await login(page, VED);
  const rows = await invoice(page);
  expect(rows.map((r) => [r.product, r.brutto, r.places, r.unit, r.code])).toEqual([
    ['Клавиатура', 600, 50, 'шт', ''],
    ['Мышь', 400, 50, 'шт', '8471607000'],
  ]);
  expect(rows.every((r) => r.note === null)).toBe(true);
  // The new column after «№» names the lot behind each row, and both are RED:
  // one lot's cartons stand on two rows, so opening a carton of «…-A» may
  // show either good (item 6).
  const label = `${run.marker}-A`;
  expect(rows.map((r) => [r.marks, r.redMarks])).toEqual([
    [label, [label]],
    [label, [label]],
  ]);
});

test('«Invoys» asks before it merges: one code, two names → the dialog; merged, ONE position; apart, the stickers in red', async ({ page }) => {
  expect(minted).not.toBeNull();
  await login(page, VED);
  await page.goto(tnvedPath());
  const button = page.getByTestId('invoice-download');
  const dialog = page.getByTestId('invoice-dialog');
  const label = `${run.marker}-A`;

  // The list cannot be read (a deploy recreating the server, a dead link):
  // NOTHING is followed. A download is a navigation of this tab, and the
  // file's address would fail for the same reason — the Bojxona screen and
  // every unsaved code on it would be replaced by an error page. The route
  // is held at the CONTEXT: the service worker answers `/api/*`.
  const stall = '**/api/batches/*/invoice/groups';
  await page.context().route(stall, (route) => route.abort());
  const strayDownloads: string[] = [];
  const onDownload = (d: Download) => strayDownloads.push(d.url());
  page.on('download', onDownload);
  await button.click();
  await expect(page.getByTestId('invoice-list-failed')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${tnvedPath()}$`));
  await expect(page.getByTestId('tnved-tarkib-row')).toHaveCount(2);
  expect(strayDownloads).toEqual([]);
  page.off('download', onDownload);
  await page.context().unroute(stall);

  // Nothing to ask (the keyboard has no code yet): the file comes at once.
  let file = page.waitForEvent('download');
  await button.click();
  expect((await downloaded(await file)).map((r) => r.product)).toEqual(['Клавиатура', 'Мышь']);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('invoice-list-failed')).toHaveCount(0);

  // The keyboard gets the mouse's code — TYPED, not saved. The invoice is
  // made from the SAVED codes, so the press says one code is not saved and
  // has no group to ask about yet.
  const keyboard = page.getByTestId('tnved-tarkib-row').filter({ hasText: 'Клавиатура' });
  await keyboard.getByTestId('tnved-tarkib-code').fill('8471607000');
  await button.click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('invoice-unsaved')).toBeVisible();
  await expect(page.getByTestId('invoice-group')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByTestId('tnved-save').click();
  await expect(page.getByTestId('tnved-saved')).toBeVisible();

  // Saved: two names under one code — the question, both names shown with
  // their stickers, and «Alohida» until a person says otherwise.
  await button.click();
  await expect(dialog).toBeVisible();
  const group = page.getByTestId('invoice-group');
  await expect(group).toHaveCount(1);
  await expect(group).toHaveAttribute('data-merge', 'no');
  await expect(group).toContainText('8471607000');
  await expect(group).toContainText('Клавиатура');
  await expect(group).toContainText('Мышь');
  await expect(group).toContainText(label);
  await expect(page.getByTestId('invoice-unsaved')).toHaveCount(0);
  // The phone: the sheet is inside the screen, its button a thumb can reach.
  const sheet = (await dialog.boundingBox())!;
  expect(sheet.x).toBeGreaterThanOrEqual(0);
  expect(sheet.x + sheet.width).toBeLessThanOrEqual(360);
  const get = (await page.getByTestId('invoice-get').boundingBox())!;
  expect(get.y + get.height).toBeLessThanOrEqual(800);
  expect((await widths(page)).scroll).toBeLessThanOrEqual(360);

  // «Qo'shish»: the dialog says what the ONE position will read, and the file is that.
  await group.getByTestId('invoice-merge-yes').click();
  await expect(group).toHaveAttribute('data-merge', 'yes');
  await expect(page.getByTestId('invoice-merged-as')).toContainText('Клавиатура, Мышь');
  await page.screenshot({ path: `${SHOTS}/invoice-dialog-360.png` });
  // The answer travels in the file's ADDRESS — the one the signed download
  // link is minted for — so Telegram's in-app browser gets the merged file too.
  const asked = page.waitForRequest((r) => r.url().endsWith('/api/dl') && r.method() === 'POST');
  file = page.waitForEvent('download');
  await page.getByTestId('invoice-get').click();
  expect((await asked).postDataJSON().path).toMatch(/\/invoice\?merge=8471607000\.[0-9a-f]{8}$/);
  expect(await downloaded(await file)).toEqual([
    {
      product: 'Клавиатура, Мышь',
      code: '8471607000',
      unit: 'шт',
      quantity: 1500,
      places: 100,
      brutto: 1000,
      // The whole lot is in ONE position now: its sticker is not a warning.
      marks: label,
      redMarks: [],
    },
  ]);
  await expect(dialog).toHaveCount(0);

  // The device remembers the answer for this truck; «Alohida» takes it back
  // and the two rows return, each with the lot's sticker in red.
  await button.click();
  await expect(group).toHaveAttribute('data-merge', 'yes');
  await group.getByTestId('invoice-merge-no').click();
  file = page.waitForEvent('download');
  await page.getByTestId('invoice-get').click();
  expect((await downloaded(await file)).map((r) => [r.product, r.quantity, r.redMarks])).toEqual([
    ['Клавиатура', 500, [label]],
    ['Мышь', 1000, [label]],
  ]);
  // A bare address — a bookmark, the print sheet, another device — never merges.
  expect((await invoice(page)).map((r) => r.product)).toEqual(['Клавиатура', 'Мышь']);

  // The list moves under an OPEN dialog (a colleague saves another code for
  // the keyboard): «Invoysni olish» reads it again, shows what is true now
  // and asks again — it never hands over a file that ignores the answer.
  await button.click();
  await expect(group).toHaveCount(1);
  await group.getByTestId('invoice-merge-yes').click();
  const sql = database();
  page.on('download', onDownload);
  try {
    await sql`UPDATE lot_composition_lines SET tnved_code = '8471300000' WHERE lot_id = ${minted!.lotId} AND name = 'Клавиатура'`;
    await page.getByTestId('invoice-get').click();
    await expect(page.getByTestId('invoice-moved')).toBeVisible();
    await expect(page.getByTestId('invoice-group')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(strayDownloads).toEqual([]);
  } finally {
    await sql`UPDATE lot_composition_lines SET tnved_code = '8471607000' WHERE lot_id = ${minted!.lotId} AND name = 'Клавиатура'`;
    await sql.end();
    page.off('download', onDownload);
  }
});

test('the freeze: the sent truck keeps its papers; un-ticked, it reads the correction', async ({ page }) => {
  expect(minted).not.toBeNull();
  await login(page, VED);
  await page.goto(tnvedPath());
  await expect(page.getByTestId('tnved-tarkib-ai')).toHaveCount(2);
  await page.getByTestId('tnved-sent-toggle').click();
  await expect(page.getByTestId('tnved-sent-toggle')).toContainText('✅');
  // A ticked truck prints its frozen copy: its lines are read-only, and a
  // code the 🤖 suggested could never be saved — so it is not offered.
  await expect(page.getByTestId('tnved-tarkib-row')).toHaveCount(2);
  await expect(page.getByTestId('tnved-tarkib-ai')).toHaveCount(0);

  await page.goto(receiptPath());
  await expect(page.getByTestId('tarkib-frozen')).toContainText(run.truckCode);
  await page.getByTestId('lot-tarkib-open').click();
  await line(page, 0).getByTestId('tarkib-kg').fill('550');
  await line(page, 1).getByTestId('tarkib-kg').fill('450');
  await page.getByTestId('tarkib-save').click();
  await expect(page.getByTestId('tarkib-saved')).toContainText(run.truckCode);
  expect((await invoice(page)).map((r) => r.brutto)).toEqual([600, 400]);

  await page.goto(tnvedPath());
  await page.getByTestId('tnved-sent-toggle').click();
  await expect(page.getByTestId('tnved-sent-toggle')).not.toContainText('✅');
  expect((await invoice(page)).map((r) => r.brutto)).toEqual([550, 450]);
});

test('not a warehouse door: the operator reads, the logist writes and is warned on the lot form', async ({ page }) => {
  expect(minted).not.toBeNull();
  await login(page, YW_OPERATOR);
  await page.goto(receiptPath());
  await expect(page.getByTestId('lot-tarkib')).toContainText('Клавиатура · Мышь');
  await expect(page.getByTestId('lot-tarkib-open')).toHaveCount(0);

  await login(page, LOGIST);
  await page.goto(receiptPath());
  await expect(page.getByTestId('lot-tarkib-open')).toBeVisible();
  await page.locator(`#lot-${minted!.lotId}`).getByRole('button', { name: /✏️/ }).first().click();
  await expect(page.getByTestId('lot-edit-tarkib-warning')).toBeVisible();
  // The form's Russian box is the warehouse's own word; the line under it
  // says which name the lists print instead.
  await expect(page.getByTestId('lot-edit-shown-name')).toContainText('Клавиатура +1');
});

test('a 768 tablet and a 1280 desktop: the editor fits, the screenshots are taken', async ({ page, browser }) => {
  expect(minted).not.toBeNull();
  await login(page, VED);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(receiptPath());
  await page.getByTestId('lot-tarkib-open').click();
  await expect(page.getByTestId('tarkib-editor')).toBeVisible();
  const w = await widths(page);
  expect(w.client).toBe(w.scroll);

  const desktop = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    isMobile: false,
    hasTouch: false,
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
  });
  const d = await desktop.newPage();
  try {
    await login(d, VED);
    await d.goto(receiptPath());
    await d.getByTestId('lot-tarkib-open').click();
    await expect(d.getByTestId('tarkib-editor')).toBeVisible();
    const dw = await widths(d);
    expect(dw.client).toBe(1280);
    expect(dw.scroll).toBeLessThanOrEqual(1280);
    await d.screenshot({ path: `${SHOTS}/lot-receipt-editor-1280.png`, fullPage: true });
    await d.goto(tnvedPath());
    await expect(d.getByTestId('tnved-tarkib-row')).toHaveCount(2);
    expect((await widths(d)).scroll).toBeLessThanOrEqual(1280);
    await d.screenshot({ path: `${SHOTS}/lot-tnved-tab-1280.png`, fullPage: true });
  } finally {
    await desktop.close();
  }
});

test('cleanup: the document goes with its bytes, nothing carries the marker, the memory is as found', async ({ page }) => {
  expect(minted).not.toBeNull();
  const sql = database();
  try {
    await sql`DELETE FROM batch_sent_compositions WHERE lot_id = ${minted!.lotId}`;
    await sql`DELETE FROM lot_compositions WHERE lot_id = ${minted!.lotId}`;
    await login(page, VED);
    const res = await page.request.delete(`/api/attachments/${documentId}`);
    expect(res.status()).toBe(200);
    expect(await cleanup(sql, run)).toBe(0);
    expect(await memoryRows(sql, run)).toEqual(memoryAtMint);
  } finally {
    await sql.end();
  }
});
