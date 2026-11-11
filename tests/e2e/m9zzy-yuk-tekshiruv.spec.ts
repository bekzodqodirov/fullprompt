import ExcelJS from 'exceljs';
import { expect, test, type Page } from '@playwright/test';
import { chatOf, cleanup, cleanupEarlier, database, mint, newRun, type Minted } from './yuk-tekshiruv-fixture';

/**
 * «Yuk ma'lumoti tekshirildi» in a real browser (docs/YUK-TEKSHIRUV.md): the
 * owner's worklist — the logist opens Ostatka on «❓ Tekshirilmagan», taps the
 * chip on a row, rings the client from the prixod card, presses «✅ To'g'ri»,
 * and one tap brings him back to the list without the row. Then the plan
 * editor's filter that never touches the plan, the XLSX that is the screen,
 * a rename that turns the ✅ into ⚠, and the warehouse that reads but cannot
 * tick. The rules underneath are proven in
 * tests/integration/lot-check.integration.test.ts.
 *
 * The prixod is this spec's own (yuk-tekshiruv-fixture.ts); the last TEST
 * deletes it and proves nothing carries the marker (round 57's `afterAll` lie).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const LOGIST = '+998900000003';
const YW_OPERATOR = '+998900000006';
const SHOTS = 'test-results';
const run = newRun();
let minted: Minted | null = null;

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const code = () => `${run.marker}-A`;
/** The stock table's row for this spec's lot (the code cell starts with it). */
const stockRow = (page: Page) => page.locator('table tbody tr', { hasText: code() });

async function widths(page: Page) {
  return page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
}

test('mint: 10 cartons of «klaviatura» on the shelf in a Chinese warehouse', async () => {
  const sql = database();
  try {
    await cleanupEarlier(sql);
    minted = await mint(sql, run);
  } finally {
    await sql.end();
  }
});

test('the worklist: ❓ on the row, the chip opens the lot, ✅ To\'g\'ri, one tap back and the row is gone', async ({ page }) => {
  await login(page, LOGIST);
  // The home row is the door to exactly this filter.
  await expect(page.getByTestId('logist-flow-unchecked')).toHaveAttribute('href', '/stock?tek=yoq');

  await page.goto(`/stock?q=${run.marker}&tek=yoq`);
  await expect(page.getByTestId('stock-check-no')).toHaveAttribute('aria-current', 'true');
  const row = stockRow(page);
  await expect(row).toHaveCount(1);
  const chip = row.getByTestId('lot-check-chip');
  await expect(chip).toHaveAttribute('data-state', 'none');
  // The chip is a sibling of the code's link, never inside it (an <a> in an <a>).
  expect(await chip.evaluate((el) => el.parentElement?.closest('a') === null)).toBe(true);
  const { client, scroll } = await widths(page);
  expect(scroll).toBeLessThanOrEqual(client);
  await page.screenshot({ path: `${SHOTS}/yuk-tekshiruv-stock-360.png`, fullPage: true });

  await chip.click();
  await expect(page).toHaveURL(new RegExp(`/receipts/${minted!.receiptId}\\?qaytish=`));
  const panel = page.locator(`#lot-${minted!.lotId}`).getByTestId('lot-check');
  await expect(panel).toHaveAttribute('data-state', 'none');
  await expect(panel.getByTestId('lot-check-face-none')).toBeVisible();
  // The client's phone, to ring (📞) or write (💬).
  await expect(panel.getByTestId('lot-check-phones')).toContainText('+998901112233');
  await expect(panel.getByTestId('lot-check-phones').locator('a[href^="https://t.me/+998901112233"]')).toHaveCount(1);
  await panel.getByTestId('lot-check-note').fill('mijoz telefonda tasdiqladi');
  await panel.getByTestId('lot-check-yes').click();
  await expect(panel.getByTestId('lot-check-face-person')).toBeVisible();
  await expect(panel.getByTestId('lot-check-face-person')).toContainText('mijoz telefonda tasdiqladi');
  await expect(panel).toHaveAttribute('data-state', 'checked');
  const card = await widths(page);
  expect(card.scroll).toBeLessThanOrEqual(card.client);
  await page.screenshot({ path: `${SHOTS}/yuk-tekshiruv-card-360.png`, fullPage: true });

  // One tap back to the filtered list — and the row is no longer on it.
  await page.getByRole('link', { name: /^←/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`/stock\\?.*tek=yoq`));
  await expect(stockRow(page)).toHaveCount(0);
});

test('✅ Tekshirilgan lists it; the filter survives 🔍 and a sort click; the XLSX is the screen', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto(`/stock?q=${run.marker}&tek=ha`);
  await expect(stockRow(page).getByTestId('lot-check-chip')).toHaveAttribute('data-state', 'checked');
  await page.locator('form[method="get"] button[type="submit"]').click();
  await expect(page).toHaveURL(/tek=ha/);
  await page.locator('thead th a').first().click();
  await expect(page).toHaveURL(/tek=ha/);
  await expect(stockRow(page)).toHaveCount(1);

  const res = await page.request.get(`/api/reports/stock?q=${run.marker}&tek=ha`);
  expect(res.status()).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await res.body()) as unknown as ExcelJS.Buffer);
  const sheet = wb.worksheets[0]!;
  const header = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
  const at = header.findIndex((h) => /Проверка|Tekshiruv|Checked|核对/.test(h));
  expect(at).toBeGreaterThan(0);
  expect(String(sheet.getRow(2).getCell(at).value)).toContain('✅');
  expect(sheet.rowCount).toBe(2);
});

test('the plan editor: the filter narrows what is DRAWN, a ticked row it hides is still planned', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto('/plans/new');
  await page.getByTestId('plan-origin').selectOption({ label: 'YW' });
  const row = page.locator('#plan-stock-table tbody tr', { hasText: code() });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('lot-check-chip')).toHaveAttribute('data-state', 'checked');

  await page.getByTestId('plan-check-filter-yes').click();
  await expect(row).toHaveCount(1);
  await row.locator('input').fill('10');
  await expect(page.getByText('Σ 10 📦')).toBeVisible();
  await page.getByTestId('plan-check-filter-no').click();
  await expect(row).toHaveCount(0);
  await expect(page.getByTestId('plan-check-hidden')).toBeVisible();
  await expect(page.getByText('Σ 10 📦')).toBeVisible();
  await page.getByTestId('plan-check-filter-all').click();
  await expect(row).toHaveCount(1);
});

test('a rename after the check: ⚠ on the list and on the card, naming what moved; the logist takes it back', async ({ page }) => {
  const sql = database();
  try {
    await sql`UPDATE receipt_lots SET product_name_ru = 'Мышь' WHERE id = ${minted!.lotId}`;
  } finally {
    await sql.end();
  }
  await login(page, LOGIST);
  await page.goto(`/stock?q=${run.marker}&tek=yoq`);
  await expect(stockRow(page).getByTestId('lot-check-chip')).toHaveAttribute('data-state', 'stale');
  await page.goto(`/receipts/${minted!.receiptId}`);
  const panel = page.locator(`#lot-${minted!.lotId}`).getByTestId('lot-check');
  await expect(panel.getByTestId('lot-check-face-stale')).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByTestId('lot-check-undo').click();
  await expect(panel).toHaveAttribute('data-state', 'none');
});

/*
 * The CLIENT's own ✅ / ❌ (0144, docs/TARKIB-TAKLIFLAR.md §4). No browser can
 * press a Telegram button, so the answers are written the way the bot writes
 * them (the rule itself is client-confirm.integration's and the bot's own
 * suite's); what only a browser can show is the CARD: the question's block,
 * a ❌ that leads in red with no green line left under it, and the ways out.
 */
test('«Mijozdan so‘rash»: no Telegram — a sentence; linked — the button queues the question and the card says so', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto(`/receipts/${minted!.receiptId}`);
  const block = page.getByTestId('client-ask');
  await expect(block).toBeVisible();
  // The client has no Telegram linked: said in words, and no button to press in vain.
  await expect(block.getByTestId('client-ask-nochat')).toBeVisible();
  await expect(block.getByTestId('client-ask-send')).toHaveCount(0);

  const sql = database();
  try {
    await sql`
      INSERT INTO client_telegram_links (id, client_id, telegram_chat_id, status, linked_at)
      SELECT gen_random_uuid(), id, ${chatOf(run)}::bigint, 'linked', now() FROM clients WHERE client_code = ${run.marker}`;
  } finally {
    await sql.end();
  }
  await page.reload();
  await expect(block.getByTestId('client-ask-nochat')).toHaveCount(0);
  page.once('dialog', (dialog) => void dialog.accept());
  await block.getByTestId('client-ask-send').click();
  // The test server has no bot token, so the question waits in the queue — and the card says exactly that,
  // ONCE: the status line the action's own revalidation brings is the «queued» (said twice before).
  const status = block.getByTestId('client-ask-status');
  await expect(status).toHaveAttribute('data-state', /pending|sending/);
  await expect(status).toHaveAttribute('data-wait', 'soon');
  await expect(block.getByTestId('client-ask-done')).toHaveCount(0);
  await expect(block.getByTestId('client-ask-send')).toBeDisabled();
  // A second press while it waits is refused in words, never a second message.
  const w = await widths(page);
  expect(w.scroll).toBeLessThanOrEqual(w.client);
  await page.screenshot({ path: `${SHOTS}/yuk-tekshiruv-mijozdan-sorash.png`, fullPage: true });

  // A question that has been due for half an hour and is still here cannot be sent at all (this very
  // server: no token) — «a minute or two» was read for hours with nothing to press.
  const later = database();
  try {
    await later`UPDATE client_notices SET send_after = now() - interval '30 minutes' WHERE kind = 'lot_ask' AND ref_id = ${minted!.receiptId}`;
    await page.reload();
    await expect(status).toHaveAttribute('data-wait', 'stuck');
    await expect(status).toHaveClass(/text-warn/);
    // …and one that went out is dated on the OFFICE clock, like the History under it: the prixod stands
    // in a Chinese warehouse (three hours ahead), where 14:05 Tashkent used to read 17:05.
    await later`
      UPDATE client_notices SET status = 'sent', attempts = 1, sent_at = '2026-11-11 09:05:00+00'
       WHERE kind = 'lot_ask' AND ref_id = ${minted!.receiptId}`;
    await page.reload();
    await expect(status).toHaveAttribute('data-state', 'sent');
    await expect(status).toContainText('14:05');
    await expect(status).not.toContainText('17:05');
  } finally {
    await later.end();
  }
});

test('the client’s ❌ leads in red and leaves NO green line; «E’tirozni yopish» brings the colleague’s tick back; the client’s ✅ is green by itself', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto(`/receipts/${minted!.receiptId}`);
  const panel = page.locator(`#lot-${minted!.lotId}`).getByTestId('lot-check');
  // A colleague ticks first…
  await panel.getByTestId('lot-check-yes').click();
  await expect(panel.getByTestId('lot-check-face-person')).toBeVisible();
  // …and then the client presses «❌ Xato bor» in Telegram (written as the bot writes it).
  const answer = async (verdict: 'yes' | 'no') => {
    const sql = database();
    try {
      await sql`
        INSERT INTO lot_client_confirms (lot_id, verdict, shown_zh, shown_ru, shown_count, shown_client_id, chat_id, answered_at)
        SELECT l.id, ${verdict}, l.product_name_zh, l.product_name_ru, l.box_count, r.client_id, ${chatOf(run)}::bigint, clock_timestamp()
          FROM receipt_lots l JOIN receipts r ON r.id = l.receipt_id WHERE l.id = ${minted!.lotId}
        ON CONFLICT (lot_id) DO UPDATE SET verdict = EXCLUDED.verdict, answered_at = EXCLUDED.answered_at`;
    } finally {
      await sql.end();
    }
  };
  await answer('no');
  await page.reload();
  await expect(panel).toHaveAttribute('data-state', 'none');
  await expect(panel.getByTestId('lot-check-face-client-no')).toBeVisible();
  // The colleague's earlier tick is history now — drawn muted, never green beside the dispute.
  await expect(panel.getByTestId('lot-check-face-person-held')).toBeVisible();
  await expect(panel.getByTestId('lot-check-face-person')).toHaveCount(0);
  await expect(panel.locator('.text-good')).toHaveCount(0);
  // …and the lists agree: the row is back on the ❓ worklist.
  await page.goto(`/stock?q=${run.marker}&tek=yoq`);
  await expect(stockRow(page).getByTestId('lot-check-chip')).toHaveAttribute('data-state', 'none');
  await page.goto(`/receipts/${minted!.receiptId}`);
  await page.screenshot({ path: `${SHOTS}/yuk-tekshiruv-mijoz-etiroz.png`, fullPage: true });
  const w = await widths(page);
  expect(w.scroll).toBeLessThanOrEqual(w.client);

  // Way out: the person who has talked to the client closes the dispute — the tick vouches again.
  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByTestId('lot-check-dispute-close').click();
  await expect(panel.getByTestId('lot-check-face-client-no')).toHaveCount(0);
  await expect(panel.getByTestId('lot-check-face-person')).toBeVisible();
  await expect(panel).toHaveAttribute('data-state', 'checked');

  // The client's own ✅ needs no colleague at all: the tick is taken back, the client confirms, the lot is ✅.
  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByTestId('lot-check-undo').click();
  await expect(panel).toHaveAttribute('data-state', 'none');
  await answer('yes');
  await page.reload();
  await expect(panel).toHaveAttribute('data-state', 'checked');
  await expect(panel.getByTestId('lot-check-face-client-yes')).toBeVisible();
  await page.goto(`/stock?q=${run.marker}&tek=ha`);
  await expect(stockRow(page).getByTestId('lot-check-chip')).toHaveAttribute('data-state', 'checked');
  // Leave the lot as the next test expects it: nobody's answer on it.
  const sql = database();
  try {
    await sql`DELETE FROM lot_client_confirms WHERE lot_id = ${minted!.lotId}`;
  } finally {
    await sql.end();
  }
});

test('the warehouse reads the face and cannot tick', async ({ page }) => {
  await login(page, YW_OPERATOR);
  await page.goto(`/receipts/${minted!.receiptId}`);
  const panel = page.locator(`#lot-${minted!.lotId}`).getByTestId('lot-check');
  await expect(panel.getByTestId('lot-check-face-none')).toBeVisible();
  await expect(panel.getByTestId('lot-check-yes')).toHaveCount(0);
  await expect(panel.getByTestId('lot-check-phones')).toHaveCount(0);
});

test('cleanup: nothing carries the marker', async () => {
  const sql = database();
  try {
    expect(await cleanup(sql, run)).toBe(0);
  } finally {
    await sql.end();
  }
});
