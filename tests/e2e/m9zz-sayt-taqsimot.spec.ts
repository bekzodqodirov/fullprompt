import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import postgres from 'postgres';

/**
 * «Saytdan so'rovlar» in the browser (round 113) at 360 px: the admin ticks a
 * seller for a website team and types the Telegram handle they answer on, the
 * panel's «keyingi» line names them, and the website's own question — sent
 * over real HTTP from the website's page — gets that handle back.
 *
 * The ranking, the fences and the tag landing are proven in
 * tests/integration/site-assign.integration.test.ts. What only this spec
 * shows: the panel saves through the real form, a folded person's card still
 * posts, the route answers in the standalone build, and every string renders
 * in the default locale (#163).
 *
 * Stage 1a «Hajm» (his 6 c, J32): the choice «Saytdan so'rovlar («Sotib olib
 * berish»dan tashqari): sotuvchilarga / AI sotuvchiga» is saved through its own
 * form, and once on it says ONE line of truth — here the AI cannot take one (no
 * AI seat is named on this server), so the line gives the reason in WORDS, the
 * «keyingi» line still names the seller, and the website's question still gets
 * her handle: the site is never told «nobody» because of the AI. Measured at
 * 360 px in Russian (the admin's locale).
 *
 * A team tick is CONFIGURATION (#183): while it stands, every website visitor
 * in the rest of the suite would be sent to this seller. So the last test
 * unticks and clears the handle, and proves it by reading the page back. The
 * AI choice is configuration too — every visitor's door asks it — so the same
 * last test puts it back through its own form, and an afterAll net writes the
 * stored row back exactly. The offer the route writes is data and stays.
 */

const PASSWORD = 'demo1234';
const ADMIN = '+998900000001';
const SELLER_NAME = 'Dilnoza (Sales)';
const HANDLE = `e2e_sayt_${String(Date.now()).slice(-6)}`;

// The admin reads Russian (his stored locale, and the default); the words come from the bundle (#163).
const ru = JSON.parse(readFileSync('messages/ru.json', 'utf8')) as {
  routing: { site: Record<'aiTitle' | 'aiSellers' | 'aiSeat' | 'aiCannot' | 'aiHint', string> };
};

/**
 * «AI hozir qabul qila olmaydi (<sabab>)» as a pattern: the bundle's sentence literal, the reason WORDS (J32 — the
 * reason once had none): several words, no code's underscore, no bracket.
 */
const cannotLine = new RegExp(
  `^⚠ ${ru.routing.site.aiCannot
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .split('\\{reason\\}')
    .join('([^()_]+ [^()_]+)')}$`,
  'u',
);

const AI_KEY = 'lead_assign_ai';
type AiMode = 'off' | 'all';
/** The stored choice before this spec — the row itself (null = never stored: the default, `off`). */
let aiRowBefore: { value: unknown; updated_by: string | null; updated_at: Date } | null | undefined;
let aiBefore: AiMode = 'off';

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for this spec’s snapshot and its net');
  return postgres(url, { max: 1, onnotice: () => {} });
}

async function fitsThePhone(page: import('@playwright/test').Page) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const sql = database();
  try {
    const [row] = await sql<{ value: unknown; updated_by: string | null; updated_at: Date }[]>`
      SELECT value, updated_by, updated_at FROM settings WHERE key = ${AI_KEY}`;
    aiRowBefore = row ?? null;
    aiBefore = row?.value === 'all' ? 'all' : 'off';
  } finally {
    await sql.end();
  }
});

/** The stored AI choice exactly as before — the net under the final test (a serial run skips it after a failure). */
async function restoreAiChoice(): Promise<void> {
  if (aiRowBefore === undefined) return;
  const sql = database();
  try {
    if (aiRowBefore === null) {
      await sql`DELETE FROM settings WHERE key = ${AI_KEY}`;
    } else {
      await sql`
        UPDATE settings SET value = ${sql.json(aiRowBefore.value as string)}, updated_by = ${aiRowBefore.updated_by},
                            updated_at = ${aiRowBefore.updated_at}
         WHERE key = ${AI_KEY}`;
    }
  } finally {
    await sql.end();
  }
}

test.afterAll(async () => {
  await restoreAiChoice();
});

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const sellerCard = (page: import('@playwright/test').Page) =>
  page.getByTestId('site-person').filter({ hasText: SELLER_NAME });

async function openSellerCard(page: import('@playwright/test').Page) {
  await page.goto('/admin/taqsimot');
  await expect(page.getByTestId('site-panel')).toBeVisible();
  // Nobody ticked her yet and she has no connected Telegram, so she sits in
  // the fold — which is exactly the case the per-row posting exists for.
  if (!(await sellerCard(page).isVisible())) {
    await page.getByTestId('site-form').locator('details > summary').click();
  }
  await expect(sellerCard(page)).toBeVisible();
}

test('the admin ticks a seller for a website team and the panel names her next', async ({ page }) => {
  await login(page, ADMIN);
  await openSellerCard(page);
  const card = sellerCard(page);
  await card.getByTestId('site-team-cargo').check();
  await card.getByTestId('site-username').fill(`@${HANDLE}`);
  await page.getByTestId('site-save').click();
  await expect(page.getByTestId('site-save')).toContainText('✅');

  await page.reload();
  await expect(sellerCard(page)).toBeVisible(); // ticked → out of the fold
  await expect(sellerCard(page).getByTestId('site-team-cargo')).toBeChecked();
  await expect(sellerCard(page).getByTestId('site-person-status')).toContainText(`@${HANDLE}`);
  await expect(page.getByTestId('site-next')).toContainText(`@${HANDLE}`);

  // A card at 360 px must not widen the page (#400).
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
});

test('the website page asks and gets her handle; another page gets nothing', async ({ page }) => {
  const lead = `GSR-E2E${String(Date.now()).slice(-6)}`;
  const url = `/api/lead/assign?team=cargo&tag=yuk&page=/narxlar/&lang=uz&lead=${lead}`;
  const ours = await page.request.get(url, { headers: { origin: 'https://gsrlogistics.uz' } });
  expect(ours.status()).toBe(200);
  expect(await ours.json()).toEqual({ username: HANDLE });
  expect(ours.headers()['access-control-allow-origin']).toBe('https://gsrlogistics.uz');

  const theirs = await page.request.get(url.replace(lead, `${lead}X`), {
    headers: { origin: 'https://evil.example' },
  });
  expect(await theirs.json()).toEqual({ username: null });
  expect(theirs.headers()['access-control-allow-origin']).toBeUndefined();

  // …and the offer shows on the panel's recent list.
  await login(page, ADMIN);
  await page.goto('/admin/taqsimot');
  await expect(page.getByTestId('site-offers')).toContainText(`@${HANDLE}`);
});

test('the AI choice: «AI sotuvchiga» is saved, its truth line says in words why the AI cannot take one now — and the website still gets the seller', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto('/admin/taqsimot');
  const ai = page.getByTestId('site-ai');
  await expect(ai).toContainText(ru.routing.site.aiTitle);
  await expect(ai).toContainText(ru.routing.site.aiSellers);
  await expect(ai).toContainText(ru.routing.site.aiSeat);
  await expect(ai).toContainText(ru.routing.site.aiHint);
  await expect(ai.getByTestId(`site-ai-${aiBefore}`)).toBeChecked();
  // Off: no truth line — there is nothing the AI is meant to be doing.
  if (aiBefore === 'off') await expect(ai.getByTestId('site-ai-truth')).toHaveCount(0);
  await fitsThePhone(page);

  await ai.getByTestId('site-ai-all').check();
  await ai.getByTestId('site-ai-save').click();
  await expect(ai.getByTestId('site-ai-save')).toContainText('✅');

  await page.reload();
  await expect(ai.getByTestId('site-ai-all')).toBeChecked();
  // On, and no AI seat is named here: refused, the reason in his words, the visitors to the sellers meanwhile.
  const truth = ai.getByTestId('site-ai-truth');
  await expect(truth).toHaveAttribute('data-ok', '0');
  await expect(truth).toHaveText(cannotLine);
  // The door's own order on the panel: the seat would come first, but it takes none — the roster's pick stands.
  await expect(page.getByTestId('site-next')).toContainText(`@${HANDLE}`);
  await expect(page.getByTestId('site-next-ai')).toHaveCount(0);
  await fitsThePhone(page);

  // …and the website is never told «nobody» because of the AI: the roster answers, as before.
  const lead = `GSR-E2EAI${String(Date.now()).slice(-6)}`;
  const answer = await page.request.get(`/api/lead/assign?team=cargo&tag=yuk&page=/narxlar/&lang=uz&lead=${lead}`, {
    headers: { origin: 'https://gsrlogistics.uz' },
  });
  expect(answer.status()).toBe(200);
  expect(await answer.json()).toEqual({ username: HANDLE });
});

test('cleanup: the AI choice, the tick and the handle come off again', async ({ page }) => {
  await login(page, ADMIN);
  // The AI choice first, through its own form, as it stood before this spec.
  await page.goto('/admin/taqsimot');
  const ai = page.getByTestId('site-ai');
  await ai.getByTestId(`site-ai-${aiBefore}`).check();
  await ai.getByTestId('site-ai-save').click();
  await expect(ai.getByTestId('site-ai-save')).toContainText('✅');
  await page.reload();
  await expect(ai.getByTestId(`site-ai-${aiBefore}`)).toBeChecked();
  if (aiBefore === 'off') await expect(ai.getByTestId('site-ai-truth')).toHaveCount(0);
  // The row itself back to the byte (a choice saved as the default still leaves a row behind).
  await restoreAiChoice();
  const sql = database();
  try {
    const rows = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${AI_KEY}`;
    expect(rows.map((r) => r.value)).toEqual(aiRowBefore ? [aiRowBefore.value] : []);
  } finally {
    await sql.end();
  }

  await openSellerCard(page);
  const card = sellerCard(page);
  await card.getByTestId('site-team-cargo').uncheck();
  await card.getByTestId('site-username').fill('');
  await page.getByTestId('site-save').click();
  await expect(page.getByTestId('site-save')).toContainText('✅');

  await openSellerCard(page);
  await expect(sellerCard(page).getByTestId('site-team-cargo')).not.toBeChecked();
  await expect(sellerCard(page).getByTestId('site-username')).toHaveValue('');
  await expect(page.getByTestId('site-next')).not.toContainText(`@${HANDLE}`);
});
