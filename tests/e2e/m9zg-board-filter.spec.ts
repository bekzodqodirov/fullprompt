import { expect, test } from '@playwright/test';

/**
 * Finding one job on a board that holds hundreds.
 *
 * The rules — that the filter is in SQL and that the counts share its
 * predicate — are proven in the integration suite. What only a browser shows
 * is whether the filter SURVIVES the screen: the mine/all tabs and the
 * «+N · show all» footer were literal strings, so before this round the first
 * tap on any of them silently dropped what had been typed and reloaded the
 * unfiltered board, which reads as the filter being broken.
 *
 * It creates one lead and closes it at the end, like m9ze does.
 */

const OWNER = '+998900000001';
// A sales_manager: holds crm.leads and NOT crm.leads.view_all, which is the
// whole point of the two tests below.
const SALES = '+998900000009';
const PASSWORD = 'demo1234';
const NAME = `Filtr e2e ${String(Date.now()).slice(-6)}`;

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const board = (page: import('@playwright/test').Page) => page.getByTestId('funnel-mobile');

test('the box narrows the board, and a miss empties it honestly', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/crm/leads/new');
  await page.locator('input[name="name"]').fill(NAME);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/crm\/leads\/[0-9a-f-]+$/);

  await page.goto('/crm?scope=all');
  await expect(board(page).getByTestId('lead-card').filter({ hasText: NAME })).toHaveCount(1);

  await page.getByTestId('board-q').fill(NAME);
  await page.getByTestId('board-filter-apply').click();
  await expect(page).toHaveURL(/[?&]q=/);
  // Exactly the one card, on a board that had many.
  await expect(board(page).getByTestId('lead-card')).toHaveCount(1);
  await expect(board(page).getByTestId('lead-card').first()).toContainText(NAME);

  // A miss says nothing found rather than showing everything.
  await page.getByTestId('board-q').fill(`yo-q-${Date.now()}`);
  await page.getByTestId('board-filter-apply').click();
  await expect(board(page).getByTestId('lead-card')).toHaveCount(0);
});

test('the filter survives the tabs, the archive link and the clear button', async ({ page }) => {
  await login(page, OWNER);
  await page.goto(`/crm?scope=all&q=${encodeURIComponent(NAME)}`);
  await expect(board(page).getByTestId('lead-card')).toHaveCount(1);

  // «Mening»: scope drops, the filter stays.
  await page.getByRole('link', { name: /^(Мои|Meniki|Mine|我的)$/ }).first().click();
  await expect(page).toHaveURL(/[?&]q=/);

  // Back to all, then the archive door — the one that used to load 400
  // unfiltered closed cards and look like a broken filter.
  await page.goto(`/crm?scope=all&q=${encodeURIComponent(NAME)}`);
  const archive = page.getByTestId('stage-archive-link').first();
  if (await archive.count()) {
    await archive.click();
    await expect(page).toHaveURL(/[?&]q=/);
    await expect(page).toHaveURL(/arxiv=1/);
  }

  // Clear puts the whole board back.
  await page.goto(`/crm?scope=all&q=${encodeURIComponent(NAME)}`);
  await page.getByTestId('board-filter-clear').click();
  await expect(page).not.toHaveURL(/[?&]q=/);
  await expect(board(page).getByTestId('lead-card').first()).toBeVisible();
});

test('somebody who may not see the whole funnel is not offered a colleague', async ({ page }) => {
  await login(page, SALES);
  await page.goto('/crm');
  await expect(page.getByTestId('board-filter')).toBeVisible();
  // The picker belongs to whoever may look at everybody's work.
  await expect(page.getByTestId('board-hodim')).toHaveCount(0);
});

test('a hodim in the address bar does not widen what a seller can see', async ({ page }) => {
  // The funnel's ownership rule is also the search's and the bot's. A fourth
  // door has to ask the same question, so the param is IGNORED rather than
  // obeyed — the board must look exactly as it did without it.
  await login(page, SALES);
  await page.goto('/crm');
  const own = await board(page).getByTestId('lead-card').count();
  await page.goto('/crm?hodim=00000000-0000-0000-0000-000000000000');
  await expect(board(page).getByTestId('lead-card')).toHaveCount(own);
});

test('the deal board carries the same row', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/bitimlar?scope=all');
  await expect(page.getByTestId('board-filter')).toBeVisible();
  await page.getByTestId('board-q').fill(`yo-q-${Date.now()}`);
  await page.getByTestId('board-filter-apply').click();
  await expect(page.getByTestId('deal-card')).toHaveCount(0);
  // …and the attention list narrows with it, rather than sitting there full.
  await expect(page.getByTestId('deal-attention')).toHaveCount(0);
});

test('the lead it created is closed, so it leaves the board', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/crm?scope=all');
  const card = board(page).getByTestId('lead-card').filter({ hasText: NAME }).first();
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
