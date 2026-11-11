import { expect, test, type Page } from '@playwright/test';
import { cleanup, cleanupEarlier, database, mint, newRun, type Minted } from './lot-tarkibi-fixture';

/**
 * «🤖 Fayldan to'ldirish» in a real browser (docs/TARKIB-TAKLIFLAR.md §3; the
 * owner, 2026-11-11: «Tarkibni mijozning packing-list fayli yoki rasmidan AI
 * o'qib to'ldirsin — 10–20 qatorni qo'lda yozmaslik uchun»).
 *
 * There is no AI key here or in CI, so the READING is a stand-in: the route's
 * answer is fulfilled with a canned proposal — at the CONTEXT, because the
 * service worker answers `/api/*` itself and `page.route` never sees it. The
 * route's own doors, ledger and model call are proven in
 * tests/integration/tarkib-read.integration.test.ts; what only a browser can
 * show is here:
 *
 *  · the button wakes when a document chip is CHOSEN and posts the lot and
 *    that file's id — nothing else;
 *  · the dialog lists the rows, each under the name it will be applied
 *    under, with the Σ of the ticked rows beside the lot's own figures;
 *  · a stray tap on the backdrop, or Escape, does NOT close a paid reading;
 *  · on a phone the sheet fits the screen — the document is as wide as the
 *    viewport and «Qo'llash» is on screen without scrolling the page;
 *  · «Qo'llash» fills the editor's lines and SAVES NOTHING; the editor's own
 *    «Saqlash» stores them; a kept reading is shown again without a second
 *    request, and forgotten once its rows are saved;
 *  · a refusal is a sentence with the day's count beside it, and the button
 *    comes back.
 *
 * The prixod and the truck are this spec's own (lot-tarkibi-fixture.ts — one
 * lot of 100 cartons, 1000 kg, 2.5 m³); the last TEST deletes them and proves
 * nothing carries the marker (round 57's `afterAll` lie).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const VED = '+998900000004';
/** Where every spec here leaves its screenshots (the CI artifact). */
const SHOTS = 'test-results';
const run = newRun();
let minted: Minted | null = null;
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

/** The document's width against the viewport — never `innerWidth`, which grows with Chrome's zoom-out (#1241). */
async function widths(page: Page) {
  return page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
}

const line = (page: Page, i: number) => page.getByTestId('tarkib-line').nth(i);

/**
 * What the model «read»: three goods that add up to the lot exactly, and a
 * fourth that is the lot's OWN good by its Chinese name — which the dialog
 * names as the lot does, never by the translation (the save's
 * `tnved_would_vanish` guard recognises the lot's good by that name).
 */
const proposal = () => ({
  rows: [
    {
      name: '无线键盘',
      nameRu: 'Клавиатура',
      pieces: '500',
      cartons: '50',
      kg: '600.000',
      m3: '1.5000',
      tnved: '8471607000',
      // Ten digits printed on the paper: the cell carries them and says whose code it is.
      notes: [{ code: 'paper_code', params: { value: '8471607000' } }],
      unsure: null,
    },
    {
      name: '鼠标',
      nameRu: 'Мышь',
      pieces: '1000',
      cartons: '30',
      kg: '300.000',
      m3: '0.7500',
      tnved: '',
      notes: [{ code: 'seller_code', params: { value: '847160' } }],
      unsure: 'вес указан на две строки',
    },
    { name: 'Коврик для мыши', nameRu: null, pieces: '', cartons: '20', kg: '100.000', m3: '0.2500', tnved: '', notes: [], unsure: null },
    // The lot's OWN good, with the exporter's code beside it: named as the lot is, and the code NOT carried.
    {
      name: run.lotName,
      nameRu: 'Клавиатура игровая',
      pieces: '10',
      cartons: '',
      kg: '',
      m3: '',
      tnved: '8471607200',
      notes: [{ code: 'paper_code', params: { value: '8471607200' } }],
      unsure: null,
    },
  ],
  weightKind: 'gross',
  fileTotals: { cartons: '100', kg: '1000.000', m3: '2.5000' },
  document: 'packing_list',
  // A warning line, so the dialog's and the notice's lists are drawn in a real browser at least once.
  warnings: [{ code: 'doc_invoice' }],
  notes: null,
  lotsOnReceipt: 1,
});
const TODAY = { used: 3, limit: 50, usd: null, usd30: null, unpriced: null };

test('mint: one lot of 100 cartons on a confirmed prixod', async () => {
  const sql = database();
  try {
    await cleanupEarlier(sql);
    minted = await mint(sql, run);
  } finally {
    await sql.end();
  }
});

test('the VED fills the tarkib from the client’s file on the phone: ticks the lot’s rows, applies, and only «Saqlash» saves', async ({ page }) => {
  // A failed test restarts the worker and resets this module (round 62).
  expect(minted).not.toBeNull();
  const asked: unknown[] = [];
  await page.context().route('**/api/tarkib/read', async (route) => {
    asked.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, proposal: proposal(), today: TODAY } });
  });

  await login(page, VED);
  await page.goto(receiptPath());
  await page.getByTestId('lot-tarkib').getByTestId('lot-tarkib-open').click();
  await expect(page.getByTestId('tarkib-editor')).toBeVisible();

  // No document chosen: the button sleeps and a line says what wakes it.
  const button = page.getByTestId('tarkib-read');
  await expect(button).toBeDisabled();
  await expect(page.getByTestId('tarkib-read-hint')).toBeVisible();

  // The client's packing list, uploaded from the editor onto THIS prixod and
  // chosen by itself — the file that is read is the file the tarkib will cite.
  await page.getByTestId('tarkib-upload').setInputFiles({
    name: 'packing.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
  });
  const chip = page.getByTestId('tarkib-doc').filter({ hasText: 'packing.pdf' });
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  documentId = (await chip.getAttribute('data-id'))!;
  expect(documentId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(button).toBeEnabled();
  await expect(page.getByTestId('tarkib-read-hint')).toHaveCount(0);

  await button.click();
  const dialog = page.getByTestId('tarkib-read-dialog');
  await expect(dialog).toBeVisible();
  // What was posted: the lot and the chosen file — the bytes stay on the server.
  expect(asked).toEqual([{ lotId: minted!.lotId, attachmentId: documentId }]);

  // Four rows, each under the name it will be APPLIED under: the model's
  // Russian wording for another good, the paper's own words where it gave
  // none, and the lot's own name for the lot's own good.
  const rows = dialog.getByTestId('tarkib-read-row');
  await expect(rows).toHaveCount(4);
  await expect(dialog.getByTestId('tarkib-read-name')).toHaveText(['Клавиатура', 'Мышь', 'Коврик для мыши', run.lotName]);
  await expect(rows.nth(0)).toContainText('无线键盘');
  await expect(rows.nth(1)).toContainText('847160');
  await expect(rows.nth(1)).toContainText('вес указан на две строки');
  await expect(rows.nth(3)).not.toContainText('Клавиатура игровая');
  await expect(dialog.getByTestId('tarkib-read-today')).toContainText('3 / 50');
  // The paper's ten digits: carried for another good (with whose code it is), NOT for the lot's own —
  // there the save's guard must still be able to name the code the TNVED memory holds.
  await expect(rows.nth(0).getByTestId('tarkib-read-figures')).toContainText('8471607000');
  await expect(rows.nth(3).getByTestId('tarkib-read-figures')).not.toContainText('8471607200');
  await expect(rows.nth(3).getByTestId('tarkib-read-own-code')).toContainText('8471607200');
  await expect(dialog.getByTestId('tarkib-read-warning')).toHaveCount(1);

  // One lot on the prixod and no more than twenty rows: everything is ticked
  // to begin with — and the fourth row states no cartons, kg or m³, which
  // the sums say instead of hiding.
  await expect(rows.locator('[data-testid="tarkib-read-tick"]:checked')).toHaveCount(4);
  await expect(dialog.getByTestId('tarkib-read-count')).toHaveText('4 / 20');
  const sums = dialog.getByTestId('tarkib-read-sums');
  await expect(sums).toContainText('1000.000 kg');
  await expect(sums.locator('.text-warn')).toHaveCount(3);

  // Unticked, the three that are left add up to the lot exactly: nothing is
  // in the warning colour any more. The paper's own totals stand beside.
  await rows.nth(3).getByTestId('tarkib-read-tick').uncheck();
  await expect(dialog.getByTestId('tarkib-read-count')).toHaveText('3 / 20');
  await expect(sums.locator('.text-warn')).toHaveCount(0);
  await expect(sums.locator('.text-good')).toHaveCount(3);
  await expect(dialog.getByTestId('tarkib-read-paper')).toContainText('2.5000 m³');

  // The phone: the sheet fits the screen (#400 — measured by the document,
  // never `innerWidth`), and «Qo'llash» is on screen without scrolling the page.
  const w = await widths(page);
  expect(w.client).toBe(360);
  expect(w.scroll).toBeLessThanOrEqual(360);
  const apply = dialog.getByTestId('tarkib-read-apply');
  for (const control of [apply, dialog.getByTestId('tarkib-read-close'), dialog.getByTestId('tarkib-read-again')]) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
  }
  const sheet = (await dialog.boundingBox())!;
  expect(sheet.width).toBeLessThanOrEqual(360);
  expect(sheet.y).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/tarkib-read-dialog-360.png` });

  // A stray tap on the backdrop, and Escape, do NOT close a paid reading.
  await page.mouse.click(180, Math.max(4, Math.floor(sheet.y / 2)));
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('tarkib-read-count')).toHaveText('3 / 20');

  // «Qo'llash»: the three ticked rows are the editor's lines — and nothing is saved.
  await apply.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('tarkib-line')).toHaveCount(3);
  await expect(line(page, 0).getByTestId('tarkib-name')).toHaveValue('Клавиатура');
  await expect(line(page, 0).getByTestId('tarkib-pieces')).toHaveValue('500');
  await expect(line(page, 0).getByTestId('tarkib-cartons')).toHaveValue('50');
  await expect(line(page, 0).getByTestId('tarkib-kg')).toHaveValue('600.000');
  await expect(line(page, 0).getByTestId('tarkib-m3')).toHaveValue('1.5000');
  await expect(line(page, 0).getByTestId('tarkib-tnved')).toHaveValue('8471607000');
  await expect(line(page, 1).getByTestId('tarkib-name')).toHaveValue('Мышь');
  // The exporter's six-digit code is a note in the dialog, never the cell.
  await expect(line(page, 1).getByTestId('tarkib-tnved')).toHaveValue('');
  await expect(line(page, 2).getByTestId('tarkib-name')).toHaveValue('Коврик для мыши');
  // A figure the reading did not give is an EMPTY cell — never 0.
  await expect(line(page, 2).getByTestId('tarkib-pieces')).toHaveValue('');
  // The notice above the rows stays until «Saqlash»; the file that was read is still the chosen one.
  await expect(page.getByTestId('tarkib-filled')).toBeVisible();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  // The editor's own remainder: kg, m³ and cartons all balanced, by the paper's figures alone.
  const remainder = page.getByTestId('tarkib-remainder');
  expect(((await remainder.textContent()) ?? '').split('✓').length - 1).toBe(3);
  // Nothing has been written: the card's face shows no tarkib yet — and the TABLE holds none (a count
  // of a client-rendered panel alone would not have seen a save still in flight).
  await expect(page.getByTestId('lot-tarkib').locator('details')).toHaveCount(0);
  const unsaved = database();
  try {
    const [row] = await unsaved`SELECT count(*)::int AS n FROM lot_compositions WHERE lot_id = ${minted!.lotId}`;
    expect(row!.n).toBe(0);
  } finally {
    await unsaved.end();
  }
  expect((await widths(page)).scroll).toBeLessThanOrEqual(360);
  await page.screenshot({ path: `${SHOTS}/tarkib-read-applied-360.png`, fullPage: true });

  // The reading is KEPT: pressed again it is shown again — no second request
  // (a reading takes a minute and one of the day's fifty). The editor now
  // holds typed rows, so it asks: add, or replace.
  await button.click();
  await expect(dialog).toBeVisible();
  expect(asked).toHaveLength(1);
  await expect(dialog.getByTestId('tarkib-read-apply')).toHaveCount(0);
  await expect(dialog.getByTestId('tarkib-read-append')).toBeVisible();
  await expect(dialog.getByTestId('tarkib-read-replace')).toBeVisible();
  // The person's TICKS came back with it: the row unticked before «Qo'llash» is still unticked. They
  // used to be lost with the closed dialog, and the list came back ticked from scratch — a row the
  // person had excluded, one press from being applied.
  await expect(dialog.getByTestId('tarkib-read-count')).toHaveText('3 / 20');
  await expect(dialog.getByTestId('tarkib-read-tick').nth(3)).not.toBeChecked();
  // A kept reading shows no count of the day: that line is for a fresh answer, for the person it was sent to.
  await expect(dialog.getByTestId('tarkib-read-today')).toHaveCount(0);
  // «Qo'shish» of rows already there is refused in words, naming them — nothing is doubled.
  await dialog.getByTestId('tarkib-read-append').click();
  await expect(dialog.getByTestId('tarkib-read-refusal')).toContainText('Клавиатура');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('tarkib-read-close').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('tarkib-line')).toHaveCount(3);

  // «Saqlash» is the one writer: the editor's own parse and sums, as ever.
  await page.getByTestId('tarkib-save').click();
  await expect(page.getByTestId('tarkib-saved')).toBeVisible();
  await expect(page.getByTestId('tarkib-editor')).toHaveCount(0);
  await expect(page.getByTestId('lot-tarkib')).toContainText('Клавиатура · Мышь · Коврик для мыши');
  await expect(page.getByTestId('lot-tarkib').locator(`a[href="/api/attachments/${documentId}"]`)).toHaveCount(1);
  // Saved on a prixod of ONE lot: the reading has done its work and is forgotten.
  expect(await page.evaluate(() => Object.keys(window.sessionStorage).filter((key) => key.startsWith('tarkib-read:')))).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('lot-tarkib')).toContainText('Клавиатура · Мышь · Коврик для мыши');
  await expect(page.locator(`#lot-${minted!.lotId}`).getByTestId('lot-name')).toHaveText(`${run.lotName} (Клавиатура +2)`);
});

test('a refused reading is a sentence with the day’s count beside it — and the button comes back', async ({ page }) => {
  expect(minted).not.toBeNull();
  let answer: Record<string, unknown> = { ok: false, error: 'ai_limit', today: { ...TODAY, used: 50 } };
  let asked = 0;
  await page.context().route('**/api/tarkib/read', async (route) => {
    asked += 1;
    await route.fulfill({ json: answer });
  });
  await login(page, VED);
  await page.goto(receiptPath());
  await page.getByTestId('lot-tarkib').getByTestId('lot-tarkib-open').click();
  // The saved tarkib cites the packing list, so its chip is chosen already.
  const chip = page.getByTestId('tarkib-doc').filter({ hasText: 'packing.pdf' });
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  const button = page.getByTestId('tarkib-read');
  await expect(button).toBeEnabled();

  // The day's limit: said, with the count, and no dialog.
  await button.click();
  const error = page.getByTestId('tarkib-error');
  await expect(error).toBeVisible();
  await expect(error.getByTestId('tarkib-read-today')).toContainText('50 / 50');
  await expect(page.getByTestId('tarkib-read-dialog')).toHaveCount(0);
  await expect(button).toBeEnabled();
  expect(asked).toBe(1);
  expect((await widths(page)).scroll).toBeLessThanOrEqual(360);
  await page.screenshot({ path: `${SHOTS}/tarkib-read-refused-360.png`, fullPage: true });

  // A refusal that never reached the ledger carries no count — and prints none: each code has its own
  // sentence, and two different refusals never read the same.
  answer = { ok: false, error: 'read_too_large' };
  await button.click();
  await expect(error).toBeVisible();
  await expect(error.getByTestId('tarkib-read-today')).toHaveCount(0);
  expect(asked).toBe(2);
  const tooLarge = (await error.textContent()) ?? '';
  answer = { ok: false, error: 'ai_not_configured' };
  await button.click();
  await expect(error).not.toHaveText(tooLarge);
  await expect(button).toBeEnabled();

  // A server that answers with a page instead of JSON (a deploy, a proxy): «failed», and the button is back.
  await page.context().unrouteAll({ behavior: 'ignoreErrors' });
  await page.context().route('**/api/tarkib/read', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad gateway</h1>' }));
  await button.click();
  await expect(error).toBeVisible();
  await expect(button).toBeEnabled();
  // The tarkib the first test saved is untouched by any of it.
  await expect(page.getByTestId('tarkib-line')).toHaveCount(3);
});

test('cleanup: the document goes with its bytes and nothing carries the marker', async ({ page }) => {
  expect(minted).not.toBeNull();
  const sql = database();
  try {
    await sql`DELETE FROM batch_sent_compositions WHERE lot_id = ${minted!.lotId}`;
    await sql`DELETE FROM lot_compositions WHERE lot_id = ${minted!.lotId}`;
    // The stand-in answered every reading, so the ledger holds no row of this lot.
    const [bill] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_calc_passes WHERE lot_id = ${minted!.lotId}`;
    expect(bill!.n).toBe(0);
    await login(page, VED);
    const res = await page.request.delete(`/api/attachments/${documentId}`);
    expect(res.status()).toBe(200);
    expect(await cleanup(sql, run)).toBe(0);
  } finally {
    await sql.end();
  }
});
