import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * «Yuk turi» (0135) on the deal's ✏️ form — the part only a browser can see.
 * React resets a form after its action; a CONTROLLED select then snapped back
 * to the mode the page first rendered, so the screen read «LTL» over a deal
 * that was FTL, and the next unrelated save posted the stale mode and quietly
 * turned the deal (and its prixods) back (#1448). The field is uncontrolled
 * and keyed on the stored mode now: after each save it reads what is stored,
 * and an unrelated save leaves the mode alone.
 *
 *  1. the office (the owner): FTL saved → the select still says FTL, the chip
 *     is on the card; a title fix keeps it FTL; LTL saved → the chip is gone;
 *  2. cleanup, a final TEST: the deal it made is deleted (#183's discipline —
 *     data, but an FTL deal on GS777 would change what a later reader sees).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);

test.describe.configure({ mode: 'serial' });

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to clean up this spec’s deal');
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

async function dealIsFtl(title: string): Promise<boolean> {
  const sql = database();
  try {
    const rows = await sql<{ ftl: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM deal_ftl df WHERE df.deal_id = d.id) AS ftl
        FROM deals d WHERE d.title = ${title}`;
    return rows[0]?.ftl === true;
  } finally {
    await sql.end();
  }
}

const title = `Yuk turi ${runId}`;

test('the office marks a deal FTL and back — the select keeps what is stored', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/admin/clients?q=GS777');
  await page.locator('a[href^="/admin/clients/"]:not([href$="/new"])').first().click();
  await page.getByTestId('client-new-deal').click();
  await page.getByTestId('deal-title').fill(title);
  await page.getByTestId('save-deal').click();
  await expect(page).toHaveURL(/\/bitimlar\/[0-9a-f-]+$/);
  await expect(page.getByTestId('deal-ftl-chip')).toHaveCount(0);

  await page.getByTestId('deal-edit-panel').click();
  const form = page.getByTestId('deal-form');
  await form.getByTestId('load-mode').selectOption('ftl');
  await page.getByTestId('save-deal').click();
  await expect(form.locator('button[type="submit"]')).toContainText('✅');
  await expect(page.getByTestId('deal-ftl-chip')).toBeVisible();
  // The defect: the reset put the select back on «LTL» over an FTL deal.
  await expect(form.getByTestId('load-mode')).toHaveValue('ftl');
  expect(await dealIsFtl(title)).toBe(true);

  // An unrelated save must not touch the mode.
  await page.getByTestId('deal-title').fill(`${title} ✓`);
  await page.getByTestId('save-deal').click();
  // The input holds what was TYPED, so it proves nothing about the save; the
  // h1 is the server's re-render, i.e. the save has landed.
  await expect(page.locator('h1').first()).toContainText(`${title} ✓`);
  await expect(page.getByTestId('deal-title')).toHaveValue(`${title} ✓`);
  await expect(form.getByTestId('load-mode')).toHaveValue('ftl');
  expect(await dealIsFtl(`${title} ✓`)).toBe(true);

  await form.getByTestId('load-mode').selectOption('ltl');
  await page.getByTestId('save-deal').click();
  await expect(page.getByTestId('deal-ftl-chip')).toHaveCount(0);
  await expect(form.getByTestId('load-mode')).toHaveValue('ltl');
  expect(await dealIsFtl(`${title} ✓`)).toBe(false);

  await page.reload();
  await page.getByTestId('deal-edit-panel').click();
  await expect(page.getByTestId('deal-form').getByTestId('load-mode')).toHaveValue('ltl');
});

test('cleanup: the deal this spec made is gone', async () => {
  const sql = database();
  try {
    await sql`DELETE FROM deals WHERE title IN (${title}, ${`${title} ✓`})`;
    const [left] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM deals WHERE title IN (${title}, ${`${title} ✓`})`;
    expect(left!.n).toBe(0);
  } finally {
    await sql.end();
  }
});
