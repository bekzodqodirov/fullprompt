import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * B9 — the system watching itself, in a browser at 360 px.
 *
 * 1. A server error's number travels: a page that throws on purpose
 *    (/sinov-xato, a 404 everywhere ERROR_PROBE is not set) shows its digest,
 *    and the super admin finds that exact row on /admin/xatolar.
 * 2. The list is the super admin's: an admin is sent home and is offered no
 *    door to it.
 * 3. A refused bot turns the owner's home red — seeded, because this
 *    container has no network and CI's runner does (#278): the fake token
 *    gets a real 401 THERE and a dead socket HERE, so the spec asserts only
 *    what it seeds and never the line's absence.
 * 4. The last test removes what this spec wrote. It does not assert the bot
 *    row is gone afterwards: in CI the server's own drain may write it back
 *    within a minute, truthfully.
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'demo1234';
const OWNER = '+998900000001';
const ADMIN = '+998900000002';

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to seed and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function noSideScroll(page: Page) {
  const w = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  expect(w.doc).toBeLessThanOrEqual(w.view);
}

let digest = '';

test('the digest on the error screen is found on /admin/xatolar', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/sinov-xato');
  const shown = page.locator('p.font-mono').filter({ hasText: /^#/ });
  await expect(shown).toBeVisible();
  digest = (await shown.innerText()).trim();
  expect(digest).toMatch(/^#\S+$/);

  // The recorder writes beside the response, not before it.
  await expect(async () => {
    await page.goto(`/admin/xatolar?q=${encodeURIComponent(digest)}`);
    await expect(page.getByTestId('xatolar-row')).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  const row = page.getByTestId('xatolar-row');
  await expect(row).toContainText('kuzatuv sinov xatosi');
  await expect(row).toContainText(digest);
  await noSideScroll(page);
  await page.screenshot({ path: 'test-results/kuzatuv-xatolar-360.png', fullPage: true });

  // The search box takes the number exactly as the screenshot shows it.
  await page.goto('/admin/xatolar');
  await page.getByTestId('xatolar-q').fill(digest);
  await page.getByTestId('xatolar-search').click();
  await expect(page.getByTestId('xatolar-row')).toHaveCount(1);

  // …and the home counts it.
  await page.goto('/');
  await expect(page.getByTestId('adm-errors')).toBeVisible();
  expect(Number(await page.getByTestId('adm-errors').innerText())).toBeGreaterThanOrEqual(1);
});

test('the list is the super admin\'s — an admin is sent home and offered no door', async ({ page }) => {
  await login(page, ADMIN);
  await page.goto('/admin/xatolar');
  await expect(page).toHaveURL('/');
  await page.goto('/admin');
  await expect(page.locator('a[data-testid="admin-tile"][href="/admin/xatolar"]')).toHaveCount(0);
  await expect(page.getByTestId('adm-errors')).toHaveCount(0);

  await login(page, OWNER);
  await page.goto('/admin');
  await expect(page.locator('a[data-testid="admin-tile"][href="/admin/xatolar"]')).toHaveCount(1);
});

test('a refused bot turns the owner\'s home red, inside the phone\'s width', async ({ page }) => {
  const sql = database();
  try {
    await sql`
      INSERT INTO system_signals (key, detail) VALUES ('telegram:bot', 'Unauthorized')
      ON CONFLICT (key) DO UPDATE SET detail = EXCLUDED.detail, updated_at = now()`;
  } finally {
    await sql.end();
  }
  await login(page, OWNER);
  const line = page.getByTestId('adm-signal').getByTestId('bot-down');
  await expect(line).toBeVisible();
  await expect(line).toContainText('🔴');
  await noSideScroll(page);
  await page.screenshot({ path: 'test-results/kuzatuv-home-360.png', fullPage: true });

  // The link lands on the same predicate's list, with the same sentence above it.
  await line.click();
  await expect(page).toHaveURL(/\/admin\/notifications/);
  await expect(page.getByTestId('bot-down')).toBeVisible();
  await noSideScroll(page);
});

test('cleanup — the seeded bot row and the probe\'s error row', async () => {
  const sql = database();
  try {
    await sql`DELETE FROM system_signals WHERE key = 'telegram:bot'`;
    if (digest) {
      const key = digest.replace(/^#/, '').split('@')[0]!;
      await sql`DELETE FROM system_errors WHERE key = ${key}`;
      const left = await sql`SELECT 1 FROM system_errors WHERE key = ${key}`;
      expect(left.length).toBe(0);
    }
  } finally {
    await sql.end();
  }
});
