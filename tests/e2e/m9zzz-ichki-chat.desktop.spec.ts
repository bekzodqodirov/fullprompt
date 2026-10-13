import 'dotenv/config';
import postgres from 'postgres';
import { expect, test, type Page } from '@playwright/test';

/**
 * «❓ Savol-javob» — the calculation's Q&A on the work's own card, in a
 * browser (the owner's E answers, 2026-10-07; docs spec §7). What only a
 * browser can prove: the VED's question on the calc page reaches the SELLER's
 * card as an open fold and a chip on the lenta, his answer leaves the fold
 * open under his hand (the judge's 13 — an `open={unread}` would have snapped
 * it shut on the revalidation after his own send), a link naming the fold
 * opens it, and the dock's «👥 Ichki» row turns read only after the page
 * reported the read (the judge's 19). The door, the audience, the Telegram
 * landing and the read arithmetic are proven in the integration files; the
 * Telegram half has NO e2e — CI has no bot and this container cannot reach
 * Telegram.
 *
 * Its OWN lead (the m9zta-ved-karta template). It sorts after
 * m9zzz-baza-statistika and m9zzz-hisoblash-telefon and before m9zzz-qarz-izoh
 * and m9zzz-ved-bitim (b < h < i < q < v) — and ved-bitim logs in as the SAME
 * VED, so this spec leaves no open job (the VED answers it as a TEST), no
 * configuration, the VED's language exactly as it found it, and its lead
 * closed. Notes and read marks are data, not configuration (#183).
 */

test.describe.configure({ mode: 'serial' });

const ADMIN = '+998900000001';
const VED = '+998900000004';
// A warehouse operator: no chat; «👥 Ichki» since round 2 (0129 — the cargo
// threads of his warehouse) beside his day, so a dock of TWO tabs (CHAT-7).
const OPERATOR = '+998900000006';
// A plain seller: on HER card the lenta's chip names a fold on the SAME page.
const SELLER = '+998900000009';
const PASSWORD = 'demo1234';
const SHOTS = process.env.CHAT_SHOTS ?? 'test-results';

const STAMP = Date.now();
// The stamp sits BEFORE a word (2026-10-09): at a name's end, beside «, 300»,
// it is a count candidate and the seller's table asks (calc-row-fix-name).
const GOODS = `ichki chat ${STAMP} tovar`;
const LEAD = `Ichki chat e2e ${STAMP}`;
// A token with no break opportunity anywhere — a pasted link, a hash.
const TOKEN = `x${'q'.repeat(299)}`;
const QUESTION = `Necha kub? ichki e2e ${STAMP}\n${TOKEN}`;
const ANSWER = `12 kub, ichki javob ${STAMP}`;

let cardUrl = '';
let requestId = '';
let vedLocale: string | null = null;
let leadOwner: string | null | undefined;
let restored = false;

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to borrow and return the VED’s language');
  return postgres(url, { max: 1, onnotice: () => {} });
}

async function setVedLocale(locale: string) {
  const sql = database();
  try {
    await sql`UPDATE users SET locale = ${locale} WHERE phone = ${VED}`;
  } finally {
    await sql.end();
  }
}

async function restoreLocale() {
  if (restored || vedLocale === null) return;
  await setVedLocale(vedLocale);
  restored = true;
}

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** Document width against the viewport's own (#1241 — never `innerWidth`). */
async function widthFits(page: Page, width: number) {
  const w = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(w.client).toBe(width);
  expect(w.scroll).toBeLessThanOrEqual(w.client);
}

const fold = (page: Page) => page.locator(`#calc-thread-${requestId}`);

test.afterAll(async () => {
  await restoreLocale();
});

test('the admin makes a lead and sends a rastamojka calculation', async ({ page }) => {
  const sql = database();
  try {
    const [row] = await sql<{ locale: string }[]>`SELECT locale FROM users WHERE phone = ${VED}`;
    vedLocale = row!.locale;
  } finally {
    await sql.end();
  }

  await login(page, ADMIN);
  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  await page.getByTestId('quick-name').fill(LEAD);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  cardUrl = (await made.getByRole('link').first().getAttribute('href'))!;
  await page.goto(cardUrl);

  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-rastamojka').click();
  await page.getByTestId('calc-goods').fill(`${GOODS}, 300`);
  await page.getByTestId('calc-send').click();
  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  const requestUrl = (await page.getByTestId('calc-open-link').first().getAttribute('href'))!;
  requestId = requestUrl.split('/').pop()!;
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
});

test('the VED asks on the calculation’s own page', async ({ page }) => {
  expect(requestId).not.toBe('');
  await login(page, VED);
  await page.goto(`/hisoblash/${requestId}`);
  const take = page.getByTestId('calc-take');
  if (await take.count()) await take.click();
  const thread = page.getByTestId('calc-thread');
  await expect(thread.getByTestId('calc-thread-empty')).toBeVisible();
  await thread.getByTestId('calc-thread-input').fill(QUESTION);
  await thread.getByTestId('calc-thread-send').click();
  await expect(thread.getByTestId('calc-thread-message')).toHaveCount(1, { timeout: 15_000 });
  await expect(thread.getByTestId('calc-thread-list')).toContainText(`Necha kub? ichki e2e ${STAMP}`);
  // The box cleared on the server's answer, never before it.
  await expect(thread.getByTestId('calc-thread-input')).toHaveValue('');
  await expect(page.getByTestId('calc-thread-jump')).toContainText('1');

  // The 300-character token wraps inside its bubble at both widths.
  await widthFits(page, 1280);
  await thread.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/ichki-calc-page-1280.png`, fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  await expect(page.getByTestId('calc-thread-message')).toHaveCount(1);
  await widthFits(page, 360);
  await page.getByTestId('calc-thread').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/ichki-calc-page-360.png`, fullPage: true });
});

test('the seller’s card: the fold is open, the lenta names it, and it stays open after his answer', async ({ page }) => {
  expect(cardUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(cardUrl);
  await expect(page.getByTestId('calc-panel-threads')).toBeVisible({ timeout: 15_000 });
  await expect(fold(page)).toHaveAttribute('open', '');
  await expect(fold(page).getByTestId('calc-thread-fold-unread')).toBeVisible();
  await expect(fold(page).getByTestId('calc-thread-message')).toHaveCount(1);
  await expect(fold(page)).toContainText(`Necha kub? ichki e2e ${STAMP}`);
  const chip = page.getByTestId('client-feed').getByTestId('feed-calc-thread');
  await expect(chip.first()).toBeVisible();
  // Where the chip leads is the reader's own address for the thread — the
  // admin holds `ved.docs`, so his is the calc page (threadHrefsFor).
  await expect(chip.first()).toHaveAttribute('href', new RegExp(requestId));

  await fold(page).getByTestId('calc-thread-input').fill(ANSWER);
  await fold(page).getByTestId('calc-thread-send').click();
  await expect(fold(page).getByTestId('calc-thread-message')).toHaveCount(2, { timeout: 15_000 });
  await expect(fold(page)).toContainText(ANSWER);
  // The judge's 13: the revalidation after his own send must not shut it.
  await expect(fold(page)).toHaveAttribute('open', '');
  await widthFits(page, 1280);
  await fold(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/ichki-card-fold-1280.png`, fullPage: true });

  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  await expect(fold(page)).toHaveAttribute('open', '');
  await widthFits(page, 360);
  await fold(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/ichki-card-fold-360.png`, fullPage: true });
});

test('the VED’s dock lists the thread as new, and it turns read once the page said so', async ({ page }) => {
  await login(page, VED);
  await page.goto('/');
  await page.getByTestId('dock-button').click();
  await page.getByTestId('dock-tab-threads').click();
  const row = page.locator(`[data-testid="dock-thread"][data-kind="calc"][data-id="${requestId}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute('data-unread', '1');
  await expect(row.getByTestId('dock-thread-unread')).toBeVisible();
  await expect(page.getByTestId('dock-threads-unread-count')).toBeVisible();

  const read = page.waitForResponse((r) => r.url().includes('/api/threads/read') && r.status() === 204);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/hisoblash/${requestId}#savol$`));
  await expect(page.getByTestId('calc-thread')).toContainText(ANSWER, { timeout: 15_000 });
  await read;

  await page.getByTestId('dock-button').click();
  await page.getByTestId('dock-tab-threads').click();
  await expect(row).toHaveAttribute('data-unread', '0', { timeout: 15_000 });
});

test('the dock in every language, as a phone sheet and as the desktop drawer: ✕ inside and whole', async ({ page }) => {
  // The judge's 18 asked 360×800 in ru and uz; the round's own screenshot
  // then found the 26rem DRAWER at 1280 overflowing in Russian (the ✕ past its
  // edge) and crushing the ✕ to 20 px in English — so both shapes, all four.
  for (const view of [
    { width: 360, height: 800 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(view);
    for (const lang of ['ru', 'uz', 'en', 'zh-CN'] as const) {
      await setVedLocale(lang);
      await login(page, VED);
      await page.getByTestId('dock-button').click();
      const panel = page.getByTestId('dock-panel');
      await expect(panel).toBeVisible();
      await page.getByTestId('dock-tab-threads').click();
      await expect(page.locator(`[data-testid="dock-thread"][data-id="${requestId}"]`)).toBeVisible({ timeout: 15_000 });
      await widthFits(page, view.width);
      const sheet = (await panel.boundingBox())!;
      const close = (await page.getByTestId('dock-close').boundingBox())!;
      expect(close.x, `${view.width} ${lang}`).toBeGreaterThanOrEqual(sheet.x);
      expect(close.x + close.width, `${view.width} ${lang}`).toBeLessThanOrEqual(sheet.x + sheet.width + 0.5);
      expect(close.y).toBeGreaterThanOrEqual(sheet.y);
      expect(close.width, `${view.width} ${lang}: the ✕ keeps its touch box`).toBeGreaterThanOrEqual(40);
      // The tab row itself does not run past the sheet.
      const row = await page.getByTestId('dock-close').evaluate((el) => ({
        client: el.parentElement!.clientWidth,
        scroll: el.parentElement!.scrollWidth,
      }));
      expect(row.scroll, `${view.width} ${lang}: tab row`).toBeLessThanOrEqual(row.client);
      if (lang === 'ru' || lang === 'uz') {
        await page.screenshot({ path: `${SHOTS}/ichki-dock-${view.width}-${lang}.png` });
      }
    }
  }
  await restoreLocale();
});

test('the VED answers the job with «Готово» — it leaves his queue (no open job left behind)', async ({ page }) => {
  await login(page, VED);
  await page.goto(`/hisoblash/${requestId}`);
  await page.getByTestId('calc-finish-open').click();
  await page.getByTestId('calc-answer-amount').fill('900');
  await page.getByTestId('calc-answer-note').fill('ichki chat e2e');
  await page.getByTestId('calc-answer-internal').fill('ichki chat e2e');
  await page.getByTestId('calc-finish').click();
  await expect(page.getByTestId('calc-answer')).toBeVisible({ timeout: 15_000 });
  // The finished job keeps its Q&A.
  await expect(page.getByTestId('calc-thread-message')).toHaveCount(2);
  await page.goto('/hisoblash');
  await expect(page.getByTestId('calc-queue').locator(`a[href="/hisoblash/${requestId}"]`)).toHaveCount(0);
});

test('a link that names the fold opens it — closed without its hash once the job is done and read', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto(cardUrl);
  await expect(fold(page)).toBeVisible({ timeout: 15_000 });
  // Done and read by him (his answer is the newest note): it draws closed.
  await expect(fold(page)).not.toHaveAttribute('open', '');
  await page.goto('/');
  await page.goto(`${cardUrl}#calc-thread-${requestId}`);
  await expect(fold(page)).toHaveAttribute('open', '', { timeout: 15_000 });
  await expect(page.locator('details').filter({ has: page.getByTestId('calc-panel') })).toHaveAttribute('open', '');
  await expect(fold(page)).toContainText(ANSWER);
});

test('on the seller’s own card the lenta’s chip opens the closed fold — a same-page link fires no hashchange', async ({ page }) => {
  // The card goes to a plain seller, so the chip's address is THIS card's fold
  // (threadHrefsFor) — a Next <Link> to the page you are on, which pushes a
  // hash and fires nothing (the owner is put back in the cleanup test).
  const sql = database();
  try {
    const leadId = cardUrl.split('/').pop()!;
    const [row] = await sql<{ owner: string | null }[]>`SELECT owner_id::text AS owner FROM leads WHERE id = ${leadId}`;
    leadOwner = row!.owner;
    await sql`UPDATE leads SET owner_id = (SELECT id FROM users WHERE phone = ${SELLER}) WHERE id = ${leadId}`;
  } finally {
    await sql.end();
  }
  await login(page, SELLER);
  // Her first visit: the admin's answer is new to her, so the fold draws open
  // and marks the thread read — wait for that, then it draws closed.
  const read = page.waitForResponse((r) => r.url().includes('/api/threads/read') && r.status() === 204);
  await page.goto(cardUrl);
  await expect(fold(page)).toHaveAttribute('open', '', { timeout: 15_000 });
  await read;
  await page.reload();
  await expect(fold(page)).toBeVisible({ timeout: 15_000 });
  await expect(fold(page)).not.toHaveAttribute('open', '');
  const chip = page.getByTestId('client-feed').getByTestId('feed-calc-thread').first();
  await expect(chip).toHaveAttribute('href', `${cardUrl}#calc-thread-${requestId}`);
  await chip.click();
  await expect(page).toHaveURL(new RegExp(`#calc-thread-${requestId}$`));
  await expect(fold(page)).toHaveAttribute('open', '', { timeout: 5_000 });
  await expect(fold(page)).toContainText(ANSWER);
});

test('a dock with two tabs keeps its words on a phone (the warehouse operator’s «👥 Ichki» and «Mening kunim»)', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, OPERATOR);
  await page.getByTestId('dock-button').click();
  await expect(page.getByTestId('dock-panel')).toBeVisible();
  await expect(page.getByTestId('dock-tab-chat')).toHaveCount(0);
  // Round 2 (0129, E7 b): the cargo threads of his warehouse land in «👥 Ichki».
  await expect(page.getByTestId('dock-tab-threads')).toHaveCount(1);
  // Each word is the tab's second span; `sr-only` would make it a 1 px box.
  const words = [
    page.getByTestId('dock-tab-tasks').locator('span').nth(1),
    page.getByTestId('dock-tab-threads').locator('span').nth(1),
  ];
  for (const word of words) {
    await expect(word).toBeVisible();
    expect((await word.boundingBox())!.width).toBeGreaterThan(20);
  }
  await widthFits(page, 360);
  await page.screenshot({ path: `${SHOTS}/ichki-dock-operator-360.png` });
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const word of words) {
    await expect(word).toBeVisible();
    expect((await word.boundingBox())!.width).toBeGreaterThan(20);
  }
  await widthFits(page, 1280);
  await page.screenshot({ path: `${SHOTS}/ichki-dock-operator-1280.png` });
});

test('the lead it created is closed and the VED’s language is his again (cleanup as a test)', async ({ page }) => {
  await restoreLocale();
  const sql = database();
  try {
    if (leadOwner !== undefined) {
      await sql`UPDATE leads SET owner_id = ${leadOwner} WHERE id = ${cardUrl.split('/').pop()!}`;
    }
    const [row] = await sql<{ locale: string }[]>`SELECT locale FROM users WHERE phone = ${VED}`;
    expect(row!.locale).toBe(vedLocale);
    const [open] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM calc_requests WHERE id = ${requestId} AND completed_at IS NULL`;
    expect(open!.n).toBe(0);
  } finally {
    await sql.end();
  }

  await login(page, ADMIN);
  await page.goto('/crm?scope=all');
  const card = page.getByTestId('funnel-desktop').getByTestId('lead-card').filter({ hasText: LEAD }).first();
  if ((await card.count()) === 0) return;
  await card.getByTestId('card-select').click();
  const bar = page.getByTestId('bulk-bar');
  const lost = await bar.getByTestId('bulk-stage').locator('option[data-kind="lost"]').first().getAttribute('value');
  await bar.getByTestId('bulk-stage').selectOption(lost!);
  await bar.getByTestId('bulk-reason').fill('e2e tozalash');
  await bar.getByTestId('bulk-move').click();
  await expect(bar.getByTestId('bulk-result')).toContainText('1', { timeout: 15_000 });
});
