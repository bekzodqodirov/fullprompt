import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import { SELLER_PHONE, cleanupAll, database, leaveSellerFiles, mint, mintSibling, newRun } from './prixod-xabari-fixture';
import { landsOnBlock, login } from './prixod-xabari-landing';

/**
 * «🔗 Bitim biriktirish» — where the seller's Telegram button lands, in a
 * browser (the owner, 2026-11-11: «bitim qoshishni bosganda usha prixodni
 * ichiga kirib bitim qayi bitimligini tanlash imkoni bolsin»;
 * docs/PRIXOD-XABARI.md §C.7).
 *
 * What only a browser can prove: `/receipts/<id>#bitim` opens a long card AT
 * its deal block, on a phone, under the sticky bar; a client with no deal is
 * offered «+ Yangi bitim ochish», and the deal opened from there is BORN with
 * the prixod on it — the seller is back on the cargo, not left on a new deal
 * with the prixod still on none; a seller takes back a file THEY sent (the
 * bot's «📎 Fayl qo‘shish» puts files here) and nobody else's; the VED, who
 * may re-file cargo but not open a deal, is not offered the link.
 *
 * The message, its recipients and the file collection are the integration
 * files' — the Telegram half has no e2e: CI has no bot.
 *
 * Sorts after m9zzzh-* («h» < «i»). Its OWN client, prixod and deal
 * (prixod-xabari-fixture.ts), deleted by a cleanup TEST (#523).
 */

test.describe.configure({ mode: 'serial' });

const VED = '+998900000004';
const OWNER = '+998900000001';

const run = newRun();
let receiptId = '';
let clientId = '';
let number = '';
/** The second client the correction tests move the prixod to (`mintSibling`). */
let sibling = { clientId: '', code: '' };

async function fits(page: Page) {
  const w = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(w.scroll).toBeLessThanOrEqual(w.client);
}

test('mint the client, its prixod and the two files', async () => {
  const sql = database();
  try {
    await cleanupAll(sql);
    ({ receiptId, clientId, number } = await mint(sql, run));
  } finally {
    await sql.end();
  }
  expect(receiptId).not.toBe('');
});

test('the button’s address opens the card AT the deal block, and offers a new deal to a client that has none', async ({ page }) => {
  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${receiptId}#bitim`);
  await landsOnBlock(page);
  await expect(page.getByTestId('receipt-deal-pick')).toBeVisible();
  await expect(page.getByTestId('receipt-deal-new')).toBeVisible();
  await fits(page);

  // The scroll margin itself, shown where the page is long enough to show
  // it: on a screen so short that a whole screen of card is left under the
  // block (a keyboard open, a small phone) its top sits just UNDER the sticky
  // bar — never behind it, which is what a bare anchor does.
  await page.setViewportSize({ width: 360, height: 420 });
  await page.goto('/');
  await page.goto(`/receipts/${receiptId}#bitim`);
  await landsOnBlock(page, 'under the bar');
});

test('«+ Yangi bitim ochish»: the deal is born with the prixod on it, and the seller is back on the cargo', async ({ page }) => {
  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${receiptId}#bitim`);
  await page.getByTestId('receipt-deal-new').click();
  await expect(page).toHaveURL(new RegExp(`/bitimlar/new\\?client=${clientId}&prixod=${receiptId}$`));
  await expect(page.getByTestId('deal-form-receipt')).toContainText(number);
  await page.locator('input[name="title"]').fill(`Xabar bitimi ${run.marker}`);
  await page.getByTestId('deal-form').locator('button[type="submit"]').click();
  // A query, not a fragment: a server action's redirect drops `#bitim`, so
  // the block brings itself into view — which is what is asserted.
  await expect(page).toHaveURL(new RegExp(`/receipts/${receiptId}\\?bitim=1$`));
  const block = page.getByTestId('receipt-deal-block');
  await expect(block.locator('a[href^="/bitimlar/"]').first()).toHaveText(/^B-\d+$/);
  await landsOnBlock(page);
  // A prixod that has its deal is not offered another.
  await expect(page.getByTestId('receipt-deal-new')).toHaveCount(0);
  await fits(page);

  const sql = database();
  try {
    const rows = await sql<{ code: string; client_id: string }[]>`
      SELECT d.code, d.client_id FROM receipts r JOIN deals d ON d.id = r.deal_id WHERE r.id = ${receiptId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client_id).toBe(clientId);
  } finally {
    await sql.end();
  }
});

test('a seller takes back the file THEY put on the prixod — and nobody else’s', async ({ page }) => {
  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${receiptId}`);
  const mine = page.locator(`a[title="seller-${run.marker}.pdf"]`);
  const office = page.locator(`a[title="office-${run.marker}.pdf"]`);
  await expect(mine).toBeVisible();
  await expect(office).toBeVisible();
  // One ✕ in the files panel: the seller holds no `receipts.edit`, so the
  // office's file carries none — and neither does an upload tile.
  await expect(mine.locator('xpath=..').getByRole('button', { name: '✕' })).toHaveCount(1);
  await expect(office.locator('xpath=..').getByRole('button', { name: '✕' })).toHaveCount(0);
  await mine.locator('xpath=..').getByRole('button', { name: '✕' }).click();
  await expect(mine).toHaveCount(0);
  await expect(office).toBeVisible();
  await page.reload();
  await expect(page.locator(`a[title="seller-${run.marker}.pdf"]`)).toHaveCount(0);
  await expect(page.locator(`a[title="office-${run.marker}.pdf"]`)).toBeVisible();

  // The LAST file. A seller cannot attach from the card, so the «Fayllar»
  // card is drawn for them only while there is something to list
  // (docs/PRIXOD-KARTA.md §7.1) — taking the last file back must take the
  // card with it, not leave its heading over nothing until the next visit.
  const sql = database();
  let last = '';
  try {
    last = (await leaveSellerFiles(sql, run, receiptId, 1))[0]!;
  } finally {
    await sql.end();
  }
  await page.reload();
  const only = page.locator(`a[title="${last}"]`);
  await expect(only).toBeVisible();
  await expect(page.getByTestId('receipt-files')).toHaveCount(1);
  await only.locator('xpath=..').getByRole('button', { name: '✕' }).click();
  await expect(page.getByTestId('receipt-files')).toHaveCount(0);
});

test('the VED may re-file the cargo but not open a deal: the block, without the link', async ({ page }) => {
  const sql = database();
  try {
    // Back to «no deal», so the link WOULD be drawn for whoever may use it.
    await sql`UPDATE receipts SET deal_id = NULL WHERE id = ${receiptId}`;
  } finally {
    await sql.end();
  }
  await login(page, VED);
  await page.goto(`/receipts/${receiptId}#bitim`);
  await expect(page.getByTestId('receipt-deal-block')).toBeVisible();
  await expect(page.getByTestId('receipt-deal-new')).toHaveCount(0);
});

test('a new-deal form OLDER than the prixod’s deal: the save is refused in words, and nothing is minted or moved', async ({ page }) => {
  // 14:05 the seller opens «+ Yangi bitim ochish»; 14:06 a colleague files the
  // prixod on the client's existing deal; 14:20 the seller presses «Saqlash».
  // Before the fix the form's deal was created and the prixod MOVED onto it —
  // off the deal somebody had just chosen, its confirmed calculation link
  // erased — with nobody choosing that.
  await login(page, SELLER_PHONE);
  await page.goto(`/bitimlar/new?client=${clientId}&prixod=${receiptId}`);
  await expect(page.getByTestId('deal-form-receipt')).toContainText(number);

  const sql = database();
  let chosen = '';
  try {
    const rows = await sql<{ id: string }[]>`SELECT id FROM deals WHERE client_id = ${clientId}`;
    expect(rows).toHaveLength(1);
    chosen = rows[0]!.id;
    await sql`UPDATE receipts SET deal_id = ${chosen} WHERE id = ${receiptId}`;
  } finally {
    await sql.end();
  }

  await page.locator('input[name="title"]').fill(`Eskirgan forma ${run.marker}`);
  await page.getByTestId('deal-form').locator('button[type="submit"]').click();
  // Refused where the person is, in words — not a new deal's card, not an error page.
  await expect(page.getByTestId('deal-form').getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/bitimlar/new\\?client=${clientId}&prixod=${receiptId}$`));

  const check = database();
  try {
    const deals = await check<{ id: string }[]>`SELECT id FROM deals WHERE client_id = ${clientId}`;
    expect(deals.map((row) => row.id)).toEqual([chosen]);
    const [row] = await check<{ deal_id: string | null }[]>`SELECT deal_id FROM receipts WHERE id = ${receiptId}`;
    expect(row!.deal_id).toBe(chosen);
    await check`UPDATE receipts SET deal_id = NULL WHERE id = ${receiptId}`;
  } finally {
    await check.end();
  }
});

test('a VOIDED prixod: the block its button still opens says so itself, and offers no new deal', async ({ page }) => {
  // A wrong prixod is voided and received again; the seller holds two
  // messages, and «🔗 Bitim biriktirish» under the first opens THIS card at
  // its deal block — with the status chip and the reason scrolled under the bar.
  const sql = database();
  try {
    const [owner] = await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
    await sql`UPDATE receipts SET status = 'voided', voided_at = now(), voided_by = ${owner!.id}, void_reason = 'e2e', deal_id = NULL
               WHERE id = ${receiptId}`;
  } finally {
    await sql.end();
  }
  try {
    await login(page, SELLER_PHONE);
    await page.goto(`/receipts/${receiptId}#bitim`);
    await expect(page.getByTestId('receipt-deal-block')).toBeVisible();
    await expect(page.getByTestId('receipt-deal-voided')).toBeVisible();
    await expect(page.getByTestId('receipt-deal-new')).toHaveCount(0);
    await fits(page);
  } finally {
    const back = database();
    try {
      await back`UPDATE receipts SET status = 'confirmed', voided_at = NULL, voided_by = NULL, void_reason = NULL WHERE id = ${receiptId}`;
    } finally {
      await back.end();
    }
  }
});

test('a prixod a client correction left on ANOTHER client’s deal: the card does not call it linked, and a new deal replaces it', async ({ page }) => {
  // What `assignReceiptClient` leaves behind: the client moves, `deal_id`
  // stays on the old client's job. The seller's «Prixod keldi» message reads
  // such a prixod as having NO deal (the client's own, `ownDealOf`) — the
  // block its button opens must say the same thing.
  const sql = database();
  let foreign: { id: string; code: string };
  try {
    const rows = await sql<{ id: string; code: string }[]>`SELECT id, code FROM deals WHERE client_id = ${clientId}`;
    expect(rows).toHaveLength(1);
    foreign = rows[0]!;
    sibling = await mintSibling(sql, run);
    await sql`UPDATE receipts SET client_id = ${sibling.clientId}, deal_id = ${foreign.id} WHERE id = ${receiptId}`;
  } finally {
    await sql.end();
  }

  await login(page, SELLER_PHONE);
  await page.goto(`/receipts/${receiptId}#bitim`);
  const block = page.getByTestId('receipt-deal-block');
  await expect(block).toBeVisible();
  // Named, in one muted line — and NOT printed as the prixod's deal.
  await expect(page.getByTestId('receipt-deal-foreign')).toContainText(foreign.code);
  await expect(block.locator(`a[href="/bitimlar/${foreign.id}"]`)).toHaveCount(0);
  // The picker offers this client's deals only: the old client's job is no choice.
  await expect(page.getByTestId('receipt-deal-pick').locator(`option[value="${foreign.id}"]`)).toHaveCount(0);
  // «No deal of its own» = the new-deal link is offered, as on a bare prixod.
  await expect(page.getByTestId('receipt-deal-new')).toBeVisible();
  // …and «Saqlash» stands although nothing has been chosen: the select opens
  // on its empty option, which here is an answer — «take it off that deal».
  await expect(page.getByTestId('receipt-deal-pick')).toHaveValue('');
  await expect(page.getByTestId('receipt-deal-save')).toBeVisible();
  await fits(page);

  await page.getByTestId('receipt-deal-new').click();
  await expect(page).toHaveURL(new RegExp(`/bitimlar/new\\?client=${sibling.clientId}&prixod=${receiptId}$`));
  // The form knows which prixod it is for — the page did not drop it because
  // the prixod «already has a deal».
  await expect(page.getByTestId('deal-form-receipt')).toContainText(number);
  await page.locator('input[name="title"]').fill(`Tuzatilgan bitim ${run.marker}`);
  await page.getByTestId('deal-form').locator('button[type="submit"]').click();
  await expect(page).toHaveURL(new RegExp(`/receipts/${receiptId}\\?bitim=1$`));
  await expect(page.getByTestId('receipt-deal-foreign')).toHaveCount(0);
  const mine = page.getByTestId('receipt-deal-block').locator('a[href^="/bitimlar/"]').first();
  await expect(mine).toHaveText(/^B-\d+$/);
  await expect(mine).not.toHaveText(foreign.code);

  const check = database();
  try {
    const rows = await check<{ client_id: string }[]>`
      SELECT d.client_id FROM receipts r JOIN deals d ON d.id = r.deal_id WHERE r.id = ${receiptId}`;
    expect(rows.map((row) => row.client_id)).toEqual([sibling.clientId]);
  } finally {
    await check.end();
  }
});

test('a reader who may NOT open a deal takes the prixod OFF another client’s deal — the empty option is a save while it stands', async ({ page }) => {
  // The test above left the prixod with the sibling, on the sibling's new
  // deal. Give it back to the first client: that deal is now ANOTHER
  // client's. For the VED — who may re-file cargo and may not open a deal —
  // the cell used to hold nothing that did anything: no «+ Yangi bitim
  // ochish», and no «Saqlash» either, because the select opens on «— uzish»
  // and main's idiom draws the button only once the answer DIFFERS.
  const sql = database();
  let foreignId = '';
  try {
    const [row] = await sql<{ deal_id: string | null }[]>`SELECT deal_id FROM receipts WHERE id = ${receiptId}`;
    expect(row!.deal_id).not.toBeNull();
    foreignId = row!.deal_id!;
    await sql`UPDATE receipts SET client_id = ${clientId} WHERE id = ${receiptId}`;
  } finally {
    await sql.end();
  }

  await login(page, VED);
  await page.goto(`/receipts/${receiptId}#bitim`);
  await expect(page.getByTestId('receipt-deal-foreign')).toBeVisible();
  await expect(page.getByTestId('receipt-deal-new')).toHaveCount(0);
  await expect(page.getByTestId('receipt-deal-pick')).toHaveValue('');
  await fits(page);
  await page.getByTestId('receipt-deal-save').click();
  await expect(page.getByTestId('receipt-deal-foreign')).toHaveCount(0);
  // Back to the ties' own idiom: nothing differs, no button.
  await expect(page.getByTestId('receipt-deal-save')).toHaveCount(0);

  const check = database();
  try {
    const [after] = await check<{ deal_id: string | null }[]>`SELECT deal_id FROM receipts WHERE id = ${receiptId}`;
    expect(after!.deal_id).toBeNull();
    // The other client's deal is untouched — only the prixod left it.
    expect(await check`SELECT id FROM deals WHERE id = ${foreignId}`).toHaveLength(1);
  } finally {
    await check.end();
  }
});

test('a client corrected ON the card: the deal cell starts again from what is stored, and «Saqlash» takes the prixod off the old deal', async ({ page }) => {
  // The foreign state's ONE origin is this card's own «Boshqa amallar»: the
  // correction revalidates without remounting the cell, and the cell kept
  // the deal it had chosen before — so «Saqlash» over «— Uzish» sent the OLD
  // deal back, the save «succeeded», and the prixod stayed where it was with
  // nothing said (the merged card's review, XF-1). The two tests above build
  // the state by SQL and a fresh load, which is exactly why they could not see it.
  const sql = database();
  let own: { id: string; code: string };
  try {
    const rows = await sql<{ id: string; code: string }[]>`SELECT id, code FROM deals WHERE client_id = ${clientId}`;
    expect(rows).toHaveLength(1);
    own = rows[0]!;
    await sql`UPDATE receipts SET client_id = ${clientId}, deal_id = ${own.id} WHERE id = ${receiptId}`;
  } finally {
    await sql.end();
  }

  // The owner: may correct the client and may file cargo on a deal.
  await login(page, OWNER);
  await page.goto(`/receipts/${receiptId}`);
  const block = page.getByTestId('receipt-deal-block');
  await expect(block.locator(`a[href="/bitimlar/${own.id}"]`)).toBeVisible();
  await expect(page.getByTestId('receipt-deal-save')).toHaveCount(0);

  await page.getByTestId('receipt-more').click();
  const assign = page.getByTestId('receipt-assign');
  await assign.locator('input').fill(sibling.code);
  await assign.getByRole('button', { name: new RegExp(sibling.code) }).click();
  await assign.locator('button[type="submit"]').click();

  // The same mounted card, revalidated: the deal is the OLD client's now.
  await expect(page.getByTestId('receipt-deal-foreign')).toContainText(own.code);
  await expect(page.getByTestId('receipt-deal-pick')).toHaveValue('');
  await page.getByTestId('receipt-deal-save').click();
  await expect(page.getByTestId('receipt-deal-foreign')).toHaveCount(0);
  await expect(page.getByTestId('receipt-deal-save')).toHaveCount(0);

  const check = database();
  try {
    const [row] = await check<{ client_id: string; deal_id: string | null }[]>`
      SELECT client_id, deal_id FROM receipts WHERE id = ${receiptId}`;
    expect(row!.client_id).toBe(sibling.clientId);
    expect(row!.deal_id).toBeNull();
  } finally {
    await check.end();
  }
});

test('two of the seller’s files taken back before the first answer: the «Fayllar» card still goes with the last', async ({ page }) => {
  // The bot's «📎 Fayl qo‘shish» puts several files at once, and on a slow
  // line from China both ✕ are pressed before the first delete answers. Each
  // press used to judge «was that the last?» from the list ITS render held —
  // both saw the other file still there, so nobody asked the page again and
  // the card stayed a heading over nothing (the merged card's review, XF-3).
  const sql = database();
  let names: string[] = [];
  try {
    names = await leaveSellerFiles(sql, run, receiptId, 2);
  } finally {
    await sql.end();
  }
  await login(page, SELLER_PHONE);
  // The context's route, not the page's: the service worker sends what the page asks.
  await page.context().route('**/api/attachments/*', async (route) => {
    if (route.request().method() === 'DELETE') await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  try {
    await page.goto(`/receipts/${receiptId}`);
    const files = names.map((name) => page.locator(`a[title="${name}"]`));
    for (const file of files) await expect(file).toBeVisible();
    await expect(page.getByTestId('receipt-files')).toHaveCount(1);
    // Both presses inside the first delete's 1.5 s.
    for (const file of files) await file.locator('xpath=..').getByRole('button', { name: '✕' }).click();
    for (const file of files) await expect(file).toHaveCount(0);
    await expect(page.getByTestId('receipt-files')).toHaveCount(0);
  } finally {
    await page.context().unrouteAll({ behavior: 'ignoreErrors' });
  }
});

test('cleanup — nothing of this spec is left for the next one', async () => {
  const sql = database();
  try {
    expect(await cleanupAll(sql)).toEqual({ clients: 0, receipts: 0, deals: 0 });
  } finally {
    await sql.end();
  }
});
