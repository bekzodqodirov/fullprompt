import { expect, test, type Page } from '@playwright/test';
import { cleanup, cleanupEarlier, database, mint, newRun, type Minted } from './ved-bitim-fixture';

/**
 * The VED's desktop board (G3 a, 2026-10-07): read-only by the ABSENCE of
 * `onMove` — no ⋯, no bulk bar, no drag — and the hint line says why while
 * keeping the height the board's viewport arithmetic was measured with.
 *
 * The drag's oracle is one the UI fence ALONE controls: no drop line appears,
 * no server action is sent, nothing is refused, and the stage in the database
 * has not moved. With the board's `onMove` restored and the action's gate kept,
 * the first three go red (and the gate's sentence renders); strip the action's
 * gate too and the last one does.
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const VED = '+998900000004';
const SELLER = '+998900000009';
const SHOTS = process.env.VED_BITIM_SHOTS ?? 'test-results';
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

const desktopBoard = (page: Page) => page.getByTestId('funnel-desktop');

async function boardBottom(page: Page) {
  return page.evaluate(() => {
    const desktop = document.querySelector('[data-testid="funnel-desktop"]')!;
    const board = desktop.querySelector('.overflow-x-auto')!;
    return Math.round(board.getBoundingClientRect().bottom);
  });
}

test('mint: three deals of the demo seller', async () => {
  const sql = database();
  try {
    await cleanupEarlier(sql);
    minted = await mint(sql, run);
  } finally {
    await sql.end();
  }
});

test('the board draws no move door and says why, on one line', async ({ page }) => {
  await login(page, VED);
  await page.goto(`/bitimlar?q=${run.marker}`);
  const board = desktopBoard(page);
  await expect(board.getByTestId('deal-card')).toHaveCount(2);
  await expect(board.getByTestId('move-other')).toHaveCount(0);
  await expect(board.getByTestId('card-select')).toHaveCount(0);
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
  const hint = page.getByTestId('board-hint');
  await expect(hint).toBeVisible();
  await expect(hint).not.toContainText('🖱');
  await expect(hint).toHaveText(/sotuvchi|продавец|seller|销售/);
  // One line: its height is one line of `text-xs`.
  const lineBox = await hint.evaluate((el) => {
    const style = getComputedStyle(el);
    return { height: el.getBoundingClientRect().height, line: parseFloat(style.lineHeight) };
  });
  expect(lineBox.height).toBeLessThanOrEqual(lineBox.line + 1);
  const vedBottom = await boardBottom(page);
  const width = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(width.client).toBe(1280);
  expect(width.scroll).toBeLessThanOrEqual(width.client);
  await page.screenshot({ path: `${SHOTS}/ved-bitim-board-1280.png` });

  // The board ends where a seller's does — the hint kept its height.
  await login(page, SELLER);
  await page.goto(`/bitimlar?q=${run.marker}`);
  await expect(desktopBoard(page).getByTestId('deal-card').first()).toBeVisible();
  expect(Math.abs((await boardBottom(page)) - vedBottom)).toBeLessThanOrEqual(2);
});

test('a real mouse drag moves nothing and asks the server nothing', async ({ page }) => {
  await login(page, VED);
  await page.goto(`/bitimlar?q=${run.marker}`);
  const board = desktopBoard(page);
  const card = board.getByTestId('deal-card').filter({ hasText: `${run.marker}-A` });
  await expect(card).toBeVisible();
  const url = page.url();
  // Another column's box to drop onto — any section that is not A's own.
  const target = board.locator('[data-stage-id]').nth(1);
  await expect(target).toBeVisible();

  const actions: string[] = [];
  page.on('request', (request) => {
    if (request.headers()['next-action']) actions.push(request.url());
  });

  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 8 });
  await expect(page.getByTestId('drop-marker')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(300);

  expect(actions).toEqual([]);
  await expect(page.getByTestId('kanban-error')).toHaveCount(0);
  expect(page.url()).toBe(url);

  await page.reload();
  const sql = database();
  try {
    const [row] = await sql<{ moved: boolean }[]>`
      SELECT d.stage_id <> (SELECT id FROM deal_stages WHERE active AND kind = 'open' ORDER BY sort_order LIMIT 1) AS moved
        FROM deals d WHERE d.id = ${minted!.dealA}`;
    expect(row!.moved).toBe(false);
  } finally {
    await sql.end();
  }
});

test('the card at 1280: the terms sentence in place of the two panels', async ({ page }) => {
  await login(page, VED);
  await page.goto(`/bitimlar/${minted!.dealB}`);
  await expect(page.getByTestId('deal-compare').getByTestId('deal-terms-readonly')).toBeVisible();
  await expect(page.getByTestId('deal-edit-panel')).toHaveCount(0);
  const width = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(width.client).toBe(1280);
  expect(width.scroll).toBeLessThanOrEqual(width.client);
  await page.screenshot({ path: `${SHOTS}/ved-bitim-card-1280.png`, fullPage: true });
});

test('cleanup: nothing carries the marker', async () => {
  const sql = database();
  try {
    expect(await cleanup(sql, run)).toBe(0);
  } finally {
    await sql.end();
  }
});
