import { expect, test } from '@playwright/test';

/**
 * Round 71: the funnel's filter panel, pressed as a salesperson presses it.
 *
 * The flow the owner asked for: a lead carries the SERVICE price after
 * hisoblatish, and the board narrows by it. The spec mints its own two leads
 * (one dear, one cheap), filters, and checks BOTH halves of #513 — the cards
 * narrow AND the excluded one is genuinely gone, not scrolled away.
 *
 * The saved view it creates is CONFIGURATION (#183): a leftover default view
 * would redirect every later spec that opens /crm bare, so the removal is a
 * TEST with the same fixtures as the rest (round 57's afterAll lesson).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const RUN = `R71-${String(Date.now()).slice(-6)}`;

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
});

test('a lead is born with a price, and the panel narrows the board to it', async ({ page }) => {
  // Two leads through the real form — the price box is part of it now.
  for (const [name, price] of [
    [`${RUN} qimmat mijoz`, '2500'],
    [`${RUN} arzon mijoz`, '120'],
  ] as const) {
    await page.goto('/crm/leads/new');
    await page.getByTestId('lead-name').fill(name);
    await page.getByTestId('lead-quote-amount').fill(price);
    await page.getByTestId('save-lead').click();
    await expect(page.getByText(/✅/).first()).toBeVisible({ timeout: 15_000 });
  }

  await page.goto(`/crm?scope=all&q=${encodeURIComponent(RUN)}`);
  // The funnel renders BOTH board shapes; scope to one or every card counts
  // twice (m9zc's lesson).
  const board = page.getByTestId('funnel-mobile');
  await expect(board.getByTestId('lead-card')).toHaveCount(2);
  // The card SHOWS the price — a filterable number nobody can see is a
  // filter over invisible ink.
  await expect(board.getByTestId('lead-card').filter({ hasText: /2[\s\u00A0]500/ })).toHaveCount(1);

  // Open the panel, ask for ≥ 1000, apply.
  await page.getByTestId('board-filters-toggle').click();
  await expect(page.getByTestId('board-filters-panel')).toBeVisible();
  await page.getByTestId('bf-narx_min').fill('1000');
  await page.getByTestId('bf-apply').click();

  await expect(board.getByTestId('lead-card')).toHaveCount(1);
  await expect(board.getByTestId('lead-card')).toContainText(`${RUN} qimmat`);
  // The filter stays visible while the panel is closed — as a chip…
  await expect(page.getByTestId('bf-chip-narx_min')).toBeVisible();

  // …whose press removes exactly that answer and brings the cheap card back.
  await page.getByTestId('bf-chip-narx_min').click();
  await expect(board.getByTestId('lead-card')).toHaveCount(2);
});

test('a filter worth typing twice becomes a named view', async ({ page }) => {
  await page.goto(`/crm?scope=all&q=${encodeURIComponent(RUN)}&narx_min=1000`);
  await expect(page.getByTestId('funnel-mobile').getByTestId('lead-card')).toHaveCount(1);

  await page.getByTestId('view-menu').click();
  await page.getByTestId('view-name').fill(`${RUN} qimmatlar`);
  await page.getByTestId('view-save').click();
  const chip = page.getByTestId('view-chip').filter({ hasText: `${RUN} qimmatlar` });
  await expect(chip).toBeVisible({ timeout: 15_000 });

  // A view is a LINK: leave, open the views menu, press it, and the
  // filtered board returns (round 72: views live behind one button).
  await page.goto('/crm?scope=all');
  await page.getByTestId('view-menu').click();
  await page
    .getByTestId('view-chip')
    .filter({ hasText: `${RUN} qimmatlar` })
    .click();
  await expect(page).toHaveURL(/narx_min=1000/);
  await expect(page.getByTestId('funnel-mobile').getByTestId('lead-card')).toHaveCount(1);
  await expect(page.getByTestId('bf-chip-narx_min')).toBeVisible();
});

test('the board owns the screen — bottom at the tab bar, no sideways growth', async ({ page }) => {
  // Round 72's whole point, measured: no test read --board-extra before this
  // one, and a wrong constant is invisible to everything else. The board's
  // bottom edge must land at the tab bar (not under it — #547's covered
  // buttons; not far above it — wasted screen), and the document must never
  // grow wider than the viewport (#400's page rescale).
  for (const url of ['/crm?scope=all', `/crm?scope=all&q=${encodeURIComponent(RUN)}`, '/bitimlar?scope=all']) {
    await page.goto(url);
    const geo = await page.evaluate(() => {
      const track = document.querySelector('[data-testid="stage-track"]')!.getBoundingClientRect();
      const tabbar = document.querySelector('[data-testid="tab-bar"]')!.getBoundingClientRect();
      return {
        gap: Math.round(tabbar.top - track.bottom),
        width: document.documentElement.scrollWidth,
      };
    });
    expect(geo.width, `${url} grew sideways`).toBeLessThanOrEqual(360);
    expect(geo.gap, `${url} board bottom vs tab bar`).toBeGreaterThanOrEqual(-2);
    expect(geo.gap, `${url} board bottom vs tab bar`).toBeLessThanOrEqual(48);
  }
});

test('the view it created is removed again', async ({ page }) => {
  await page.goto('/crm?scope=all');
  await page.getByTestId('view-menu').click();
  const row = page.locator('li').filter({ hasText: `${RUN} qimmatlar` });
  if (await row.count()) await row.getByTestId('view-delete').click();
  await expect(
    page.getByTestId('view-chip').filter({ hasText: `${RUN} qimmatlar` }),
  ).toHaveCount(0);
});
