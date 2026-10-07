import { expect, test, type Page } from '@playwright/test';
import {
  VIEW_ALL_PASSWORD,
  cleanup,
  cleanupEarlier,
  database,
  hiddenWord,
  mint,
  newRun,
  viewAllPhone,
  type Minted,
} from './ved-bitim-fixture';

/**
 * The VED on the deal card, in a real browser — the owner's 17a with G1-G4 a
 * (2026-10-07). He reads the card, writes a text note on a calc deal's lenta,
 * and works its POSITIONS (TNVED) and its PRIXODS; the terms — stage, owner,
 * quote, discount, opening a deal, asking for a calculation — are the
 * seller's. His board is his work set, read-only. The rules underneath are
 * proven in tests/integration/deal-ved.integration.test.ts; the page's gates
 * are parsed in tests/unit/deal-terms-wire.test.ts.
 *
 * The deals are this spec's own (ved-bitim-fixture.ts), owned by the demo
 * seller, so nothing the VED sees comes through ownership; the last TEST
 * deletes them and proves nothing carries the marker (round 57's `afterAll`
 * lie).
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const VED = '+998900000004';
const OWNER = '+998900000001';
const SHOTS = process.env.VED_BITIM_SHOTS ?? 'test-results';
const run = newRun();
let minted: Minted | null = null;

async function login(page: Page, phone: string, password = PASSWORD) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const phoneBoard = (page: Page) => page.getByTestId('funnel-mobile');

test('mint: three deals of the demo seller and a prixod on none', async () => {
  const sql = database();
  try {
    await cleanupEarlier(sql);
    minted = await mint(sql, run);
  } finally {
    await sql.end();
  }
});

test('the VED’s board is his work set, read-only (G3 a)', async ({ page }) => {
  await login(page, VED);
  await page.goto(`/bitimlar?q=${run.marker}`);
  const board = phoneBoard(page);
  // A (calc request) and B (a position with no TNVED) — never C.
  await expect(board.getByTestId('deal-card')).toHaveCount(2);
  await expect(board.getByTestId('deal-card').filter({ hasText: `${run.marker}-A` })).toHaveCount(1);
  await expect(board.getByTestId('deal-card').filter({ hasText: `${run.marker}-C` })).toHaveCount(0);
  // No door that would bounce: no «+», no move, no tick, no empty footer.
  await expect(page.getByTestId('new-deal')).toHaveCount(0);
  for (const id of ['move-next', 'move-other', 'card-select', 'card-actions']) {
    await expect(board.getByTestId(id), id).toHaveCount(0);
  }
  // The chip tells him which cards his home row counted.
  const cardB = board.getByTestId('deal-card').filter({ hasText: `${run.marker}-B` });
  await expect(cardB.getByTestId('deal-tnved-missing')).toBeVisible();
  const cardA = board.getByTestId('deal-card').filter({ hasText: `${run.marker}-A` });
  await expect(cardA.getByTestId('deal-tnved-missing')).toHaveCount(0);
  // The slice announces itself, untruncated.
  const title = page.locator('h1').first();
  await expect(title).toHaveText(/VED|ВЭД/);
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(width).toBe(360);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll).toBeLessThanOrEqual(360);
  await page.screenshot({ path: `${SHOTS}/ved-bitim-board-360.png`, fullPage: true });
});

test('his slice has no «whose», and its lenta filter reads only lentas he can open', async ({ page }) => {
  // DEAL17-2: the VED hat with view_all and no seller grant (the fixture's
  // own person). A URL asking for «Hammasi» AND a colleague is a forged post
  // on his board: the slice ignores both, so nothing may claim them.
  await login(page, viewAllPhone(run.marker), VIEW_ALL_PASSWORD);
  await page.goto(`/bitimlar?q=${run.marker}&scope=all&hodim=${minted!.sellerId}`);
  const board = phoneBoard(page);
  await expect(board.getByTestId('deal-card')).toHaveCount(2);
  // The chips row IS drawn — the search chip — so the absences are not vacuous.
  await expect(page.getByTestId('bf-chip-q')).toBeVisible();
  for (const id of ['bf-chip-scope', 'bf-chip-hodim', 'board-hodim']) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }
  // Nor the Meniki/Hammasi radios (they sit in the closed panel's DOM).
  await expect(page.locator('input[name="scope"]')).toHaveCount(0);
  const { client, scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(client).toBe(360);
  expect(scroll).toBeLessThanOrEqual(client);
  await page.screenshot({ path: `${SHOTS}/ved-bitim-whose-360.png`, fullPage: true });
  // The sheet itself: search, dates, ranges, lenta — and no «whose» block.
  await page.getByTestId('board-filters-toggle').click();
  await expect(page.getByTestId('bf-apply')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ved-bitim-whose-sheet-360.png` });

  // DEAL17-1: B's lenta carries the word, and B has no calc request — its
  // lenta is not his (15a), so his board's lenta filter answers nothing.
  const sql = database();
  try {
    const [premise] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM crm_activities
       WHERE entity_type = 'deal' AND entity_id = ${minted!.dealB} AND note LIKE ${`%${hiddenWord(run.marker)}%`}`;
    expect(premise!.n).toBe(1);
  } finally {
    await sql.end();
  }
  await page.goto(`/bitimlar?q=${run.marker}&lenta=${hiddenWord(run.marker)}`);
  await expect(page.getByTestId('bf-chip-lenta')).toBeVisible();
  await expect(board.getByTestId('deal-card')).toHaveCount(0);
});

test('⌘K finds the same slice his board draws — before he codes B off it', async ({ page }) => {
  await login(page, VED);
  await page.goto('/bugun');
  await page.locator('header a[href="/search"]').click();
  await expect(page.getByTestId('search-palette')).toBeVisible();
  await page.getByTestId('palette-input').fill(run.marker);
  // A deal hit's label is «client · title · stage»; the titles are the
  // fixture's own, so a lot `…-A` or a box `…-1` cannot answer for a deal.
  const deal = (suffix: string) =>
    page.getByTestId('palette-hit').filter({ hasText: `VED bitim ${suffix} ·` });
  await expect(deal('A')).toHaveCount(1, { timeout: 10_000 });
  await expect(deal('B')).toHaveCount(1);
  await expect(deal('C')).toHaveCount(0);
});

test('«+ Yangi» offers him no deal, and /bitimlar/new sends him back (G4 a)', async ({ page }) => {
  await login(page, VED);
  await page.getByTestId('quick-create').click();
  // The panel is OPEN (his task door is there) before asserting an absence.
  await expect(page.getByTestId('quick-act-task')).toBeVisible();
  await expect(page.getByTestId('quick-act-deal')).toHaveCount(0);
  await page.goto('/bitimlar/new');
  await expect(page).toHaveURL(/\/bitimlar(\?.*)?$/);
});

test('deal B: no terms, but the positions and the prixod are his', async ({ page }) => {
  await login(page, VED);
  await page.goto(`/bitimlar/${minted!.dealB}`);
  await expect(page.getByTestId('deal-terms-readonly')).toBeVisible();
  for (const id of ['deal-edit-panel', 'deal-discount-panel', 'new-task', 'calc-send']) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }
  // The readonly sentence sits inside the compare card, not floating loose.
  await expect(page.getByTestId('deal-compare').getByTestId('deal-terms-readonly')).toBeVisible();
  const { client, scroll } = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(client).toBe(360);
  expect(scroll).toBeLessThanOrEqual(client);
  await page.screenshot({ path: `${SHOTS}/ved-bitim-card-360.png`, fullPage: true });

  // Positions: the panel is a closed <details> — open it, then type.
  await page.getByTestId('deal-lines-panel').click();
  const tnved = page.locator('input[name="lineTnved"]').first();
  await expect(tnved).toBeVisible();
  await tnved.fill('8471600000');
  await page.getByTestId('save-lines').click();
  // Not the button's ✅: the form is keyed by its line ids and a save
  // replaces them, so the revalidation remounts it and the ✅ never paints.
  // The oracle is the stored code, then the re-rendered box showing it.
  await expect
    .poll(
      async () => {
        const sql = database();
        try {
          const [line] = await sql<{ tnved_code: string | null }[]>`
            SELECT tnved_code FROM deal_lines WHERE deal_id = ${minted!.dealB}`;
          return line?.tnved_code ?? null;
        } finally {
          await sql.end();
        }
      },
      { timeout: 15_000 },
    )
    .toBe('8471600000');
  await expect(page.locator('input[name="lineTnved"]').first()).toHaveValue('8471600000');

  // The prixod: by VALUE — the option's label is «number · goods · m³ · kg».
  await page.getByTestId('link-receipt-pick').selectOption(minted!.receiptId);
  await page.getByTestId('link-receipt-save').click();
  await expect(page.locator(`a[href="/receipts/${minted!.receiptId}"]`)).toBeVisible({ timeout: 15_000 });

  const sql = database();
  try {
    const [line] = await sql<{ tnved_code: string | null }[]>`
      SELECT tnved_code FROM deal_lines WHERE deal_id = ${minted!.dealB}`;
    expect(line!.tnved_code).toBe('8471600000');
    const [receipt] = await sql<{ deal_id: string | null }[]>`
      SELECT deal_id FROM receipts WHERE id = ${minted!.receiptId}`;
    expect(receipt!.deal_id).toBe(minted!.dealB);
    // G1 a: the link is audited under HIS name.
    const [audit] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log a JOIN users u ON u.id = a.actor_id
       WHERE a.entity_type = 'receipt' AND a.entity_id = ${minted!.receiptId} AND u.phone = ${VED}
         AND a.after->>'deal' = ${minted!.dealB}`;
    expect(audit!.n).toBe(1);
  } finally {
    await sql.end();
  }

  // The receipt card keeps his move/detach door.
  await page.goto(`/receipts/${minted!.receiptId}`);
  await expect(page.getByTestId('receipt-deal-pick')).toBeVisible();
});

test('deal A (a calc deal): his lenta takes a text note', async ({ page }) => {
  await login(page, VED);
  await page.goto(`/bitimlar/${minted!.dealA}`);
  const feed = page.getByTestId('client-feed');
  await expect(feed).toBeVisible();
  // Text only for the VED (docs/VED-TARIX.md §10): no 📎 on his box.
  await expect(page.getByTestId('feed-note-attach')).toHaveCount(0);
  const note = `VED savoli ${run.marker}`;
  await page.getByTestId('feed-note-body').fill(note);
  await page.getByTestId('feed-note-save').click();
  await expect(feed.getByText(note)).toBeVisible({ timeout: 15_000 });
});

test('a coded B leaves his board — the slice is the work, not a list of names', async ({ page }) => {
  await login(page, VED);
  await page.goto(`/bitimlar?q=${run.marker}`);
  const board = phoneBoard(page);
  await expect(board.getByTestId('deal-card')).toHaveCount(1);
  await expect(board.getByTestId('deal-card').filter({ hasText: `${run.marker}-A` })).toHaveCount(1);
  // The lenta filter still works where the lenta IS his: A is a calc deal and
  // carries the note he wrote on it a test ago.
  await page.goto(`/bitimlar?q=${run.marker}&lenta=${encodeURIComponent(`VED savoli ${run.marker}`)}`);
  await expect(board.getByTestId('deal-card')).toHaveCount(1);
  await expect(board.getByTestId('deal-card').filter({ hasText: `${run.marker}-A` })).toHaveCount(1);
});

test('the same card for the owner still carries the terms — per person, not per card', async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/bitimlar/${minted!.dealB}`);
  await expect(page.getByTestId('deal-edit-panel')).toBeVisible();
  await expect(page.getByTestId('deal-discount-panel')).toBeVisible();
  await expect(page.getByTestId('deal-terms-readonly')).toHaveCount(0);
});

test('cleanup: nothing carries the marker', async () => {
  const sql = database();
  try {
    expect(await cleanup(sql, run)).toBe(0);
  } finally {
    await sql.end();
  }
});
