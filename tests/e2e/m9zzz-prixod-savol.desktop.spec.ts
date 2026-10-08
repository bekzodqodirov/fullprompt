import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import { PASSWORD as OPERATOR_PASSWORD, cleanupAll, database, mint, newRun } from './prixod-savol-fixture';

/**
 * «❓ Savol-javob» on a prixod card, in a browser (round 2, 0129 — the
 * owner's E6 c warehouse half, E7 b, Q4 a). What only a browser can prove:
 * the logist's question lands on the card and reaches the operator of the
 * warehouse where the cargo stands; a seller and the VED open the same card
 * and see no thread and no «elsewhere» line (the server is the oracle); the
 * operator on a PHONE finds it in «👥 Ichki», the row's `#ichki` lands with the
 * title below the sticky header, the row turns read only after the page
 * reported the read and BEFORE he answers (an answer is marked read for its
 * author anyway, so asserting after it would be green whatever the read route
 * did), his answer with an unbroken 300-character token does not widen the
 * phone, and the logist's dock shows it new. The door, the audience, the
 * Telegram half and the frame are the integration file's; the Telegram half
 * has NO e2e — CI has no bot and this container cannot reach Telegram.
 *
 * Sorts after m9zzz-narx-kanali and before m9zzz-qarz-izoh («n» < «p» < «q»).
 * Its OWN operator and prixod (prixod-savol-fixture.ts), deactivated and
 * deleted by a cleanup TEST (#523).
 */

test.describe.configure({ mode: 'serial' });

const LOGIST = '+998900000003';
const VED = '+998900000004';
const SELLER = '+998900000009';
const DEMO_PASSWORD = 'demo1234';
const SHOTS = process.env.PS_SHOTS ?? 'test-results';

const run = newRun();
const QUESTION = `TAS1 da ikkala karobka ham turibdimi? ${run.marker}`;
const TOKEN = `y${'z'.repeat(299)}`;
const ANSWER = `Ha, ikkalasi ham 3-qatorda ${run.marker}\n${TOKEN}`;
let receiptId = '';
let operatorId = '';

async function login(page: Page, phone: string, password = DEMO_PASSWORD) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function widthFits(page: Page, width: number) {
  const w = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(w.client).toBe(width);
  expect(w.scroll).toBeLessThanOrEqual(w.client);
}

async function openThreadsTab(page: Page) {
  const panel = page.getByTestId('dock-panel');
  await expect(async () => {
    if (!(await panel.isVisible())) await page.getByTestId('dock-button').click();
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('dock-tab-threads').click();
  await expect(page.getByTestId('dock-threads')).toBeVisible();
}

const row = (page: Page) => page.locator(`[data-testid="dock-thread"][data-kind="receipt"][data-id="${receiptId}"]`);

test('the fixture stands', async () => {
  const sql = database();
  try {
    await cleanupAll(sql);
    ({ receiptId, operatorId } = await mint(sql, run));
  } finally {
    await sql.end();
  }
  expect(receiptId).not.toBe('');
});

test('the logist asks on the prixod card — the panel names TAS1, and the TAS1 operator is pinged', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto(`/receipts/${receiptId}`);
  const panel = page.getByTestId('cargo-thread');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('cargo-thread-now')).toContainText('TAS1');
  await expect(page.getByTestId('cargo-thread-audience')).toContainText('TAS1');
  await expect(page.getByTestId('cargo-thread-empty')).toBeVisible();
  await page.getByTestId('cargo-thread-input').fill(QUESTION);
  await page.getByTestId('cargo-thread-send').click();
  await expect(page.getByTestId('cargo-thread-message').filter({ hasText: QUESTION })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('cargo-thread-no-staff')).toHaveCount(0);
  await expect(page.getByTestId('cargo-thread-nobody')).toHaveCount(0);
  await widthFits(page, 1280);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/prixod-savol-panel-1280.png`, fullPage: true });

  const sql = database();
  try {
    const pings = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM notifications
       WHERE user_id = ${operatorId} AND type = 'InternalNote'
         AND payload -> 'thread' ->> 'kind' = 'receipt' AND payload -> 'thread' ->> 'id' = ${receiptId}`;
    expect(pings[0]!.n).toBe(1);
  } finally {
    await sql.end();
  }
});

test('a seller and the VED open the same card and see no thread at all (E7 b)', async ({ page }) => {
  for (const phone of [SELLER, VED]) {
    await login(page, phone);
    const response = await page.goto(`/receipts/${receiptId}`);
    expect(response?.status(), phone).toBe(200);
    await expect(page.locator('main')).toContainText(`${run.marker}-R`);
    await expect(page.getByTestId('cargo-thread'), phone).toHaveCount(0);
    await expect(page.getByTestId('cargo-thread-elsewhere'), phone).toHaveCount(0);
  }
});

test('the operator, on a phone, finds it in «👥 Ichki», reads it, and answers', async ({ browser }) => {
  // A bare context inherits no baseURL (round 57) and a `.desktop` spec gets
  // no 360 px — the house phone is stated here (the baza-statistika precedent).
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
  });
  try {
    const page = await ctx.newPage();
    await login(page, run.operatorPhone, OPERATOR_PASSWORD);
    await openThreadsTab(page);
    // Two tabs, both words drawn.
    for (const tab of ['dock-tab-threads', 'dock-tab-tasks']) {
      const word = page.getByTestId(tab).locator('span').nth(1);
      await expect(word).toBeVisible();
      expect((await word.boundingBox())!.width, tab).toBeGreaterThan(20);
    }
    await expect(row(page)).toHaveAttribute('data-unread', '1', { timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/prixod-savol-dock-360.png` });

    const read = page.waitForResponse((r) => r.url().includes('/api/threads/read') && r.status() === 204);
    await row(page).click();
    await expect(page).toHaveURL(new RegExp(`/receipts/${receiptId}#ichki$`));
    await expect(page.getByTestId('cargo-thread-message').filter({ hasText: QUESTION })).toBeVisible({ timeout: 15_000 });
    // The anchor lands BELOW the sticky app bar (`scroll-mt-20`), not under it.
    await expect(async () => {
      const header = await page.locator('header').first().boundingBox();
      const title = await page.getByTestId('cargo-thread-title').boundingBox();
      expect(header).not.toBeNull();
      expect(title).not.toBeNull();
      expect(title!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
    }).toPass({ timeout: 10_000 });
    // …and the geometry alone cannot see the margin HERE: the panel sits near
    // the page's end, so the browser stops at the maximum scroll (measured:
    // scrollY 671 = max, title at 274 px under a 57 px header) and the title
    // clears the bar with or without it — dropping `scroll-mt-20` stayed
    // green. So the margin the browser applies is asserted too: at least the
    // header's height, or a longer card would land the title under the bar.
    const margin = await page
      .getByTestId('cargo-thread')
      .evaluate((el) => parseFloat(getComputedStyle(el).scrollMarginTop) || 0);
    const bar = await page.locator('header').first().boundingBox();
    expect(margin, 'scroll-margin-top clears the sticky header').toBeGreaterThanOrEqual(bar!.height);
    await read;

    // Read BEFORE he answers: the logist's question is still the newest message.
    await openThreadsTab(page);
    await expect(row(page)).toHaveAttribute('data-unread', '0', { timeout: 15_000 });
    await page.getByTestId('dock-close').click();

    await page.getByTestId('cargo-thread-input').fill(ANSWER);
    // Never Enter: a coarse pointer's box sends with the button (round 14).
    await page.getByTestId('cargo-thread-send').click();
    await expect(page.getByTestId('cargo-thread-message').filter({ hasText: run.marker }).nth(1)).toBeVisible({
      timeout: 15_000,
    });
    await widthFits(page, 360);
    // The send button is clear of the fixed tab bar. Measured where a thumb
    // meets it — scrolled to the middle of the screen — because the answer's
    // own tall bubble has just pushed it below the fold (its box was 810 > 800
    // straight after the send), and `scrollIntoViewIfNeeded` aligns it to the
    // viewport's bottom edge, i.e. under the bar by construction. What makes
    // it reachable is the second half: the document carries at least the
    // bar's height below the button, so it can always be scrolled above it.
    const sendButton = page.getByTestId('cargo-thread-send');
    await sendButton.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const send = await sendButton.boundingBox();
    const tabBar = await page.getByTestId('tab-bar').boundingBox();
    expect(send).not.toBeNull();
    expect(tabBar, 'the phone draws its tab bar').not.toBeNull();
    expect(send!.y + send!.height).toBeLessThanOrEqual(tabBar!.y);
    const room = await sendButton.evaluate((el) => {
      const bottom = el.getBoundingClientRect().bottom + window.scrollY;
      return document.documentElement.scrollHeight - bottom;
    });
    expect(room, 'room below the button for the tab bar').toBeGreaterThanOrEqual(tabBar!.height);
    await page.getByTestId('cargo-thread').screenshot({ path: `${SHOTS}/prixod-savol-panel-360.png` });
    await page.screenshot({ path: `${SHOTS}/prixod-savol-page-360.png` });
  } finally {
    await ctx.close();
  }
});

test('the logist’s dock shows the answer new, and the row opens it', async ({ page }) => {
  await login(page, LOGIST);
  await openThreadsTab(page);
  await expect(row(page)).toHaveAttribute('data-unread', '1', { timeout: 15_000 });
  await row(page).click();
  await expect(page).toHaveURL(new RegExp(`/receipts/${receiptId}#ichki$`));
  await expect(page.getByTestId('cargo-thread-message').filter({ hasText: TOKEN.slice(0, 40) })).toBeVisible({
    timeout: 15_000,
  });
  await widthFits(page, 1280);
});

test('nothing of this spec stands (cleanup as a test)', async () => {
  const sql = database();
  try {
    expect(await cleanupAll(sql)).toEqual({ receipts: 0, activeOperators: 0 });
  } finally {
    await sql.end();
  }
});
