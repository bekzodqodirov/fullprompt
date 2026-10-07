import { expect, test, type Browser, type Locator, type Page, type Route } from '@playwright/test';
import postgres from 'postgres';

/**
 * The rastamojka calculation EDITED on the phone (his B1 a … B6 a + 21b), in
 * the phone-shaped browser the VED carries.
 *
 * What only a browser can prove: that a card opens its row's sheet and the
 * sheet's live figure is the figure its Saqlash stores (m9zr's own 248 /
 * 224.24, so engine drift turns both red together); that «1,125» is asked and
 * NOTHING is posted; that a one-row save leaves every other unsaved row
 * unsaved; that a closed tab's drafts are OFFERED back, gate the seal, and are
 * kept while the question stands; that a lost answer is pressed again into the
 * SAME row; that a deploy's dead action says «reload»; and that a colleague's
 * change under a drafted cell is a warning, never a lock.
 *
 * Its own lead and request; its goods share no word with any other spec's (a
 * SEAL is configuration for the memory, #935 — and this spec seals nothing).
 * The request is ANSWERED and the lead lost at the end, as tests (#183/#508):
 * an open request is configuration for every later hisoblash spec.
 */

const ADMIN = '+998900000001';
const VED = '+998900000004';
const PASSWORD = 'demo1234';
const SHOTS = process.env.SHOTS_DIR ?? 'test-results';

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

let leadName = '';
let requestUrl = '';

test.describe.configure({ mode: 'serial' });

// A stray beforeunload must never cancel a reload (m9v's rule).
test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
});

const row = (page: Page, name: string): Locator =>
  page.getByTestId('calc-phone-row').filter({ hasText: name });
const sheet = (page: Page) => page.getByTestId('calc-phone-sheet');

async function openRow(page: Page, name: string) {
  await row(page, name).click();
  await expect(sheet(page)).toBeVisible();
}

async function saveSheet(page: Page) {
  await sheet(page).getByTestId('calc-phone-save').click();
  await expect(sheet(page)).toHaveCount(0, { timeout: 15_000 });
}

/** Saved AND settled: nothing drafted, nothing waiting — a reload now is safe. */
async function settled(page: Page) {
  await expect(page.getByTestId('calc-unsaved')).toHaveCount(0, { timeout: 15_000 });
}

test('T1 — the request opens on the phone as cards', async ({ page, browser }) => {
  // The request is SENT from a desk: on a phone the card's send form is the
  // bot's door by design (calc-panel.tsx), and the bot is not this spec's.
  const desk = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
  });
  try {
    const d = await desk.newPage();
    await login(d, ADMIN);
    await d.goto('/crm');
    await d.getByTestId('quick-create').click();
    const pickLead = d.getByTestId('quick-kind-lead');
    if (await pickLead.count()) await pickLead.click();
    leadName = `VED telefon e2e ${Date.now()}`;
    await d.getByTestId('quick-name').fill(leadName);
    await d.getByTestId('quick-save').click();
    const made = d.getByTestId('quick-made');
    await expect(made).toBeVisible({ timeout: 15_000 });
    await d.goto((await made.getByRole('link').first().getAttribute('href'))!);
    await d.getByTestId('calc-panel').click();
    await d.getByTestId('calc-section-rastamojka').click();
    await d.getByTestId('calc-goods').fill('kafel oq, 50\nsopol kosa, 10');
    await d.getByTestId('calc-send').click();
    await expect(d.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
    requestUrl = (await d.getByTestId('calc-open-link').first().getAttribute('href'))!;
  } finally {
    await desk.close();
  }

  await login(page, ADMIN);
  await page.goto(requestUrl);
  await expect(page.getByTestId('calc-phone-hint')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('calc-table')).toBeHidden();
  await expect(page.getByTestId('calc-phone-row')).toHaveCount(2);
  // Nothing here may have come from a sealed job of another spec (#935).
  await expect(page.getByTestId('calc-phone-chip-memory')).toHaveCount(0);
});

test('T2 — the whole row is edited in its sheet; the live figure is the saved one (B1 a, 21b, #886)', async ({
  page,
}) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);

  await openRow(page, 'kafel oq');
  await sheet(page).getByTestId('calc-phone-code').fill('6907');
  await saveSheet(page);
  // The code minted the block, and the block carries the law.
  await expect(page.getByTestId('calc-phone-rates').first()).toBeVisible({ timeout: 15_000 });

  await openRow(page, 'kafel oq');
  const s = sheet(page);
  await expect(s.getByTestId('calc-phone-measure')).toBeVisible();
  await expect(s.getByTestId('calc-phone-basis')).toHaveValue('m2');
  await s.getByTestId('calc-phone-measure').fill('200');
  await s.getByTestId('calc-phone-baza').fill('1');
  // 200 m² at $1/m² → MAX(15 % of 200, 200 × $1) + 12 % VAT of 400 = $248,
  // BEFORE the save — the sheet runs the engine the seal runs.
  await expect(s.getByTestId('calc-phone-live')).toContainText('248');

  // The sheet at the phone's width: inside the screen, and a footer that
  // leaves the fields room above the keyboard.
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(360);
  const box = await s.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  const footer = await s.getByTestId('calc-phone-footer').boundingBox();
  expect(footer).not.toBeNull();
  expect(footer!.height).toBeLessThanOrEqual(140);
  await page.screenshot({ path: `${SHOTS}/phone-sheet-measured-360.png` });

  await saveSheet(page);
  await settled(page);
  await page.reload();
  await expect(page.getByTestId('calc-phone-block-customs')).toContainText('248', {
    timeout: 15_000,
  });
  await openRow(page, 'kafel oq');
  await expect(sheet(page).getByTestId('calc-phone-measure')).toHaveValue('200');
  await expect(sheet(page).getByTestId('calc-phone-baza')).toHaveValue('1');
  await expect(sheet(page).getByTestId('calc-phone-basis')).toHaveValue('m2');

  // 21b: the unit is changed on the phone too — per m³ the value reads the
  // row's kub, which it does not have yet: a refusal in words, never $0.
  await sheet(page).getByTestId('calc-phone-basis').selectOption('m3');
  await expect(sheet(page).getByTestId('calc-phone-live')).toContainText('⚠');
  await sheet(page).getByTestId('calc-phone-m3').fill('2');
  // 2 m³ × $1 → 15 % = 0.30; the law's floor still counts its 200 m² → 200;
  // VAT 12 % of 202 = 24.24 → $224.24.
  await expect(sheet(page).getByTestId('calc-phone-live')).toContainText('224.24');
  await saveSheet(page);
  await settled(page);
  await page.reload();
  await expect(page.getByTestId('calc-phone-block-customs')).toContainText('224.24', {
    timeout: 15_000,
  });
  await openRow(page, 'kafel oq');
  await expect(sheet(page).getByTestId('calc-phone-basis')).toHaveValue('m3');

  // Back to the block every later test expects: per m², no kub.
  await sheet(page).getByTestId('calc-phone-basis').selectOption('m2');
  await sheet(page).getByTestId('calc-phone-m3').fill('');
  await saveSheet(page);
  await settled(page);
  await expect(page.getByTestId('calc-phone-block-customs')).toContainText('248', {
    timeout: 15_000,
  });

  // D15: the seal panel's fields are 16 px on the phone (iPhone zooms on less).
  expect(
    await page.getByTestId('calc-discount').evaluate((el) => getComputedStyle(el).fontSize),
  ).toBe('16px');
});

test('T3 — «1,125» is asked, and nothing is posted until he answers (B4 a)', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);

  let posts = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.headers()['next-action']) posts += 1;
  });
  await openRow(page, 'sopol kosa');
  await sheet(page).getByTestId('calc-phone-baza').fill('1,125');
  await expect(sheet(page).getByTestId('calc-phone-save')).toBeEnabled();
  await sheet(page).getByTestId('calc-phone-save').click();
  const question = sheet(page).getByTestId('calc-phone-ambiguous');
  await expect(question).toBeVisible();
  await expect(question).toContainText('1.125');
  await expect(question).toContainText('1125');
  await page.waitForTimeout(500);
  expect(posts, 'an ambiguous baza must post nothing').toBe(0);
  await page.screenshot({ path: `${SHOTS}/phone-sheet-ambiguous-360.png` });

  await question.getByTestId('calc-phone-ambiguous-decimal').click();
  await expect(sheet(page).getByTestId('calc-phone-baza')).toHaveValue('1.125');
  await expect(question).toHaveCount(0);
  await saveSheet(page);
  await settled(page);
  await page.reload();
  await openRow(page, 'sopol kosa');
  await expect(sheet(page).getByTestId('calc-phone-baza')).toHaveValue('1.125');
});

test('T4 — one row saved leaves the other unsaved; a closed tab’s drafts are offered back (B2 a, B5 a)', async ({
  page,
}) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);

  await openRow(page, 'sopol kosa');
  await sheet(page).getByTestId('calc-phone-qty').fill('40');
  await sheet(page).getByTestId('calc-phone-close').click();
  await expect(row(page, 'sopol kosa')).toHaveAttribute('data-drafted', '1');

  await openRow(page, 'kafel oq');
  await sheet(page).getByTestId('calc-phone-note').fill('telefon');
  await saveSheet(page);
  await expect(row(page, 'kafel oq')).not.toHaveAttribute('data-drafted', '1', { timeout: 15_000 });
  // B2 a: the one-row save settled ITS row and nothing else.
  await expect(row(page, 'sopol kosa')).toHaveAttribute('data-drafted', '1');
  await page.screenshot({ path: `${SHOTS}/phone-list-drafted-360.png` });

  await page.reload();
  const restore = page.getByTestId('calc-restore');
  await expect(restore).toHaveCount(1, { timeout: 15_000 });
  // The seal waits on what is waiting to be restored.
  await expect(page.getByTestId('calc-seal-unsaved')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/phone-restore-360.png` });

  // He does not answer; he types on another row and the tab dies again.
  await openRow(page, 'kafel oq');
  await sheet(page).getByTestId('calc-phone-note').fill('telefon 2');
  await sheet(page).getByTestId('calc-phone-close').click();
  await page.reload();
  await expect(page.getByTestId('calc-restore')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('calc-restore')).toContainText('2');
  await page.getByTestId('calc-restore-yes').click();
  await expect(row(page, 'sopol kosa')).toHaveAttribute('data-drafted', '1');
  await expect(row(page, 'kafel oq')).toHaveAttribute('data-drafted', '1');

  await openRow(page, 'sopol kosa');
  await expect(sheet(page).getByTestId('calc-phone-qty')).toHaveValue('40');
  await saveSheet(page);
  await openRow(page, 'kafel oq');
  await saveSheet(page);
  await settled(page);
  await page.reload();
  await expect(page.getByTestId('calc-phone-hint')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('calc-restore')).toHaveCount(0);
  await openRow(page, 'sopol kosa');
  await expect(sheet(page).getByTestId('calc-phone-qty')).toHaveValue('40');
  await sheet(page).getByTestId('calc-phone-close').click();
  await openRow(page, 'kafel oq');
  await expect(sheet(page).getByTestId('calc-phone-note')).toHaveValue('telefon 2');
});

test('T5 — a lost answer is pressed again into the SAME row; a dead action after a deploy says «reload»', async ({
  page,
}) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);
  const path = new URL(requestUrl, 'http://x').pathname;

  await page.getByTestId('calc-phone-add').click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByTestId('calc-phone-name').fill('sopol likopcha');
  await sheet(page).getByTestId('calc-phone-qty').fill('5');

  // The server commits; the phone never hears back.
  let lost = false;
  const onPage = (url: URL) => url.pathname === path;
  const loseAnswer = async (route: Route) => {
    if (!lost && route.request().method() === 'POST' && route.request().headers()['next-action']) {
      lost = true;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.fallback();
  };
  await page.route(onPage, loseAnswer);
  await sheet(page).getByTestId('calc-phone-save').click();
  await expect(sheet(page).getByTestId('calc-phone-error')).toBeVisible({ timeout: 15_000 });
  await expect(sheet(page).getByTestId('calc-reload')).toHaveCount(0);
  await expect(sheet(page).getByTestId('calc-phone-name')).toHaveValue('sopol likopcha');

  // A correction typed before the second press, then ONE press.
  await sheet(page).getByTestId('calc-phone-qty').fill('6');
  await sheet(page).getByTestId('calc-phone-save').click();
  await expect(sheet(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('calc-phone-ghost')).toHaveCount(0, { timeout: 15_000 });
  await settled(page);
  await page.unroute(onPage, loseAnswer);
  await page.reload();
  await expect(page.getByTestId('calc-phone-row')).toHaveCount(3, { timeout: 15_000 });
  await openRow(page, 'sopol likopcha');
  await expect(sheet(page).getByTestId('calc-phone-qty')).toHaveValue('6');
  await sheet(page).getByTestId('calc-phone-close').click();

  // After a deploy the tab's action ids are dead — the save says «reload».
  // The version is faked at the CONTEXT: once the service worker controls the
  // page, its NetworkOnly fetch of /api/version is not the page's request.
  const deadAction = async (route: Route) => {
    if (route.request().method() === 'POST' && route.request().headers()['next-action']) {
      await route.abort();
      return;
    }
    await route.fallback();
  };
  const otherBuild = (route: Route) => route.fulfill({ json: { build: 'other' } });
  await page.route(onPage, deadAction);
  await page.context().route('**/api/version', otherBuild);
  await openRow(page, 'kafel oq');
  await sheet(page).getByTestId('calc-phone-note').fill('yangi build');
  await sheet(page).getByTestId('calc-phone-save').click();
  await expect(sheet(page).getByTestId('calc-reload')).toBeVisible({ timeout: 15_000 });
  await page.unroute(onPage, deadAction);
  await page.context().unroute('**/api/version', otherBuild);
  // Leave nothing drafted behind.
  await sheet(page).getByTestId('calc-phone-discard').click();
  await sheet(page).getByTestId('calc-phone-close').click();
  await expect(page.getByTestId('calc-unsaved')).toHaveCount(0);
});

/** A colleague (the demo VED, in a phone of their own) sets «sopol kosa»'s
 * count and saves it. */
async function colleagueSetsQty(browser: Browser, qty: string) {
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
  });
  try {
    const other = await ctx.newPage();
    other.on('dialog', (d) => void d.accept());
    await login(other, VED);
    await other.goto(requestUrl);
    await openRow(other, 'sopol kosa');
    await sheet(other).getByTestId('calc-phone-qty').fill(qty);
    await saveSheet(other);
    await settled(other);
  } finally {
    await ctx.close();
  }
}

test('T6 — a colleague’s change under a drafted cell is a warning, never a lock (B6 a)', async ({
  page,
  browser,
}) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);
  await openRow(page, 'sopol kosa');
  await sheet(page).getByTestId('calc-phone-qty').fill('41');
  await colleagueSetsQty(browser, '42');

  // Without a press: the 15 s probe brings the change in, and the ROW says so.
  const changed = sheet(page).getByTestId('calc-phone-changed');
  await expect(changed).toBeVisible({ timeout: 30_000 });
  await expect(changed).toContainText('40');
  await expect(changed).toContainText('42');
  await page.screenshot({ path: `${SHOTS}/phone-sheet-changed-360.png` });
  // The warning was on the screen, so one press is the acknowledgement.
  await saveSheet(page);
  await settled(page);
  await page.reload();
  await openRow(page, 'sopol kosa');
  await expect(sheet(page).getByTestId('calc-phone-qty')).toHaveValue('41');

  // The press's OWN look — the race B6 a is about: the colleague saves and he
  // presses before any poll has told the screen. The poll's probe is held (a
  // failed probe refreshes nothing; at the CONTEXT, because the service
  // worker's fetch is not the page's), so the only look is the press's.
  let hold = true;
  const holdProbe = (route: Route) => (hold ? route.abort() : route.fallback());
  await page.context().route('**/api/calc/rev/**', holdProbe);
  try {
    await sheet(page).getByTestId('calc-phone-qty').fill('43');
    await colleagueSetsQty(browser, '44');
    await expect(changed).toHaveCount(0);
    hold = false;
    await sheet(page).getByTestId('calc-phone-save').click();
    // The press refreshed, found 41 → 44 under his draft, and did NOT save.
    await expect(changed).toBeVisible({ timeout: 15_000 });
    await expect(changed).toContainText('41');
    await expect(changed).toContainText('44');
    await expect(sheet(page)).toBeVisible();
  } finally {
    await page.context().unroute('**/api/calc/rev/**', holdProbe);
  }
  await saveSheet(page);
  await settled(page);
  await page.reload();
  await openRow(page, 'sopol kosa');
  await expect(sheet(page).getByTestId('calc-phone-qty')).toHaveValue('43');
  await sheet(page).getByTestId('calc-phone-close').click();
});

test('T6b — a number nothing reads is named under its box; a press is bound to its row (review PHONE-4, PHONE-3)', async ({
  page,
}) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);

  // PHONE-4: «1.2.3» is refused UNDER the kg box, the box itself marked —
  // five number boxes and one sentence at the top named none of them.
  await openRow(page, 'kafel oq');
  await sheet(page).getByTestId('calc-phone-kg').fill('1.2.3');
  await sheet(page).getByTestId('calc-phone-save').click();
  const bad = sheet(page).getByTestId('calc-phone-bad');
  await expect(bad).toBeVisible();
  await expect(sheet(page).getByTestId('calc-phone-kg')).toHaveClass(/border-warn/);
  await expect(sheet(page).getByTestId('calc-phone-error')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/phone-sheet-bad-number-360.png` });
  await sheet(page).getByTestId('calc-phone-kg').fill('');
  await expect(bad).toHaveCount(0);
  await sheet(page).getByTestId('calc-phone-close').click();

  // PHONE-3: closing the sheet — and opening ANOTHER drafted row — while the
  // press looks first neither cancels the press nor turns it onto that row.
  await openRow(page, 'sopol kosa');
  await sheet(page).getByTestId('calc-phone-note').fill('boshqa qator');
  await sheet(page).getByTestId('calc-phone-close').click();
  await expect(row(page, 'sopol kosa')).toHaveAttribute('data-drafted', '1');

  // The look is held 2.5 s at the CONTEXT (the service worker's fetch is not
  // the page's), long enough to close and open by hand.
  let slow = true;
  const slowProbe = async (route: Route) => {
    if (slow) await new Promise((resolve) => setTimeout(resolve, 2_500));
    await route.fallback();
  };
  await page.context().route('**/api/calc/rev/**', slowProbe);
  try {
    await openRow(page, 'kafel oq');
    await sheet(page).getByTestId('calc-phone-note').fill('bog‘langan');
    await sheet(page).getByTestId('calc-phone-save').click();
    await sheet(page).getByTestId('calc-phone-close').click();
    await expect(sheet(page)).toHaveCount(0);
    await openRow(page, 'sopol kosa');
    // The press saved ITS row…
    await expect(row(page, 'kafel oq')).not.toHaveAttribute('data-drafted', '1', { timeout: 15_000 });
    // …and left the open one alone: still drafted, its sheet still open.
    await expect(row(page, 'sopol kosa')).toHaveAttribute('data-drafted', '1');
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByTestId('calc-phone-note')).toHaveValue('boshqa qator');
  } finally {
    slow = false;
    await page.context().unroute('**/api/calc/rev/**', slowProbe);
  }
  await sheet(page).getByTestId('calc-phone-discard').click();
  await sheet(page).getByTestId('calc-phone-close').click();
  await settled(page);
  await page.reload();
  await openRow(page, 'kafel oq');
  await expect(sheet(page).getByTestId('calc-phone-note')).toHaveValue('bog‘langan');
  await sheet(page).getByTestId('calc-phone-close').click();
});

test('T6c — a restore with nothing to restore is said ONCE (review PHONE-6)', async ({ page, browser }) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);
  await openRow(page, 'sopol kosa');
  await sheet(page).getByTestId('calc-phone-qty').fill('45');
  await sheet(page).getByTestId('calc-phone-close').click();
  await expect(row(page, 'sopol kosa')).toHaveAttribute('data-drafted', '1');
  // A colleague changes the very cell while this tab is gone.
  await colleagueSetsQty(browser, '46');

  await page.reload();
  const restore = page.getByTestId('calc-restore');
  await expect(restore).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('calc-restore-skipped')).toContainText('46');
  // Nothing to bring back: no «Tiklash», and the one button only dismisses.
  await expect(page.getByTestId('calc-restore-yes')).toHaveCount(0);
  await expect(page.getByTestId('calc-restore-no')).toHaveText(/Tushunarli|Понятно|Got it|知道了/);
  await expect(page.getByTestId('calc-unsaved')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/phone-restore-news-360.png` });

  // Unanswered, it does not come back on the next open.
  await page.reload();
  await expect(page.getByTestId('calc-phone-hint')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('calc-restore')).toHaveCount(0);
});

test('T7 — cleanup: the job is answered and the lead lost (as a test)', async ({ page }) => {
  expect(requestUrl).not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);
  const take = page.getByTestId('calc-take');
  if (await take.isVisible()) {
    await take.click();
    await expect(take).toHaveCount(0, { timeout: 15_000 });
  }
  await page.getByTestId('calc-finish-open').click();
  await page.getByTestId('calc-answer-amount').fill('480');
  await page.getByTestId('calc-answer-note').fill('e2e');
  await page.getByTestId('calc-answer-internal').fill('ichki izoh e2e');
  await page.getByTestId('calc-finish').click();
  await expect(page.getByTestId('calc-answer')).toBeVisible({ timeout: 15_000 });

  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const id = new URL(requestUrl, 'http://x').pathname.split('/').pop()!;
      const [req] = await sql`SELECT completed_at FROM calc_requests WHERE id = ${id}::uuid`;
      expect(req?.completed_at, 'the run’s request is answered').not.toBeNull();
    } finally {
      await sql.end();
    }
  }

  await page.goto('/crm?scope=all');
  const card = page
    .getByTestId('funnel-mobile')
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
