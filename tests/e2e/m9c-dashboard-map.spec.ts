import { expect, test } from '@playwright/test';

/**
 * The owner's two viewing screens: a dashboard that covers the whole company
 * and a map that fills the phone when asked.
 *
 * Sorted after the trip specs so there is real cargo, real money and real
 * trucks to show — this suite runs one worker over one database in file
 * order.
 */

const OWNER = '+998900000001';
const YW_MANAGER = '+998900000005';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const ACCOUNTANT = '+998900000010';
const LOGIST = '+998900000003';

test('the dashboard reads top to bottom: profit, four figures, alerts, pictures, then the details', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/dashboard');

  // Round B (canvas): the period's profit, then the four figures behind it.
  await expect(page.getByTestId('dash-hero')).toBeVisible();
  for (const id of ['tile-revenue', 'tile-cost', 'tile-cash', 'tile-receivable']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByTestId('kpi-row').locator('> *')).toHaveCount(4);
  // What needs a person, then the pictures.
  for (const id of [
    'section-attention',
    'dash-alerts',
    'dash-hero-line',
    'dash-cash-weeks',
    'dash-intake-days',
    'dash-fill',
    'dash-trucks',
    'dash-funnel',
    'dash-funnel-flow',
    'dash-aging',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  // «Batafsil» keeps every block the page had.
  for (const key of ['section-moneyTitle', 'section-logisticsTitle']) {
    await expect(page.getByTestId(key)).toBeVisible();
  }
  for (const id of [
    'dash-pnl-chart',
    'dash-cash-chart',
    'dash-balance-rows',
    'dash-aging-bar',
    'dash-debtors',
    'dash-trips',
    'dash-unbilled',
    'dash-pipeline-bar',
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }

  // Nothing on the page is wider than the phone (a row wider than 360 px
  // rescales the whole screen, #400).
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  // The bridge's net is the Balans page's own figure (#513): one number, two
  // screens, compared to the dollar. Re-read until they agree: the net now
  // carries the cost of unpriced cargo (U03), and a queued re-split landing
  // between the two loads moves a share between priced and unpriced cargo —
  // information, not a disagreement between the screens.
  const dollars = (text: string | null) => Math.round(Number((text ?? '').replace(/[^0-9.−-]/g, '').replace('−', '-')));
  await expect(async () => {
    await page.goto('/dashboard');
    const dashNet = dollars(await page.getByTestId('dash-balance-net').locator('[data-value]').textContent());
    await page.goto('/accounting/balance');
    const pageNet = dollars(await page.getByTestId('balance-net').textContent());
    expect(dashNet).toBe(pageNet);
  }).toPass({ timeout: 30_000 });
});

test('a tile and the report it opens print the same figure over the same days (#513)', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/dashboard?davr=30');
  // The revenue tile links to the P&L over exactly its window, and the P&L's
  // own revenue figure is the tile's.
  const tile = page.getByTestId('tile-revenue');
  const tileText = (await tile.locator('[data-value]').first().textContent())?.trim();
  const href = await tile.locator('a').first().getAttribute('href');
  expect(href).toMatch(/^\/accounting\/pnl\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  await page.goto(href!);
  await expect(page.getByTestId('pnl-kpi-revenue').locator('p.font-mono')).toHaveText(tileText!);

  // The thirty days of intake and the receipts journal over the same days.
  await page.goto('/dashboard');
  const total = page.getByTestId('dash-intake-days-total');
  const m3 = Number(await total.locator('[data-value]').getAttribute('data-value'));
  await page.goto((await total.getAttribute('href'))!);
  const header = await page.getByTestId('journal-totals').textContent();
  const printed = Number((/·\s*([\d,.]+)\s*m³/.exec(header ?? '')?.[1] ?? '').replace(/,/g, ''));
  expect(printed).toBeCloseTo(m3, 2);
});

test('the period moves the flows and leaves what stands now alone; garbage reads as «this month»', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/dashboard');
  await expect(page.getByTestId('dash-period-oy')).toHaveAttribute('aria-current', 'page');
  const monthLabel = await page.getByTestId('dash-hero-label').textContent();
  const monthHref = await page.getByTestId('tile-revenue').locator('a').first().getAttribute('href');
  const cash = await page.getByTestId('tile-cash').locator('[data-value]').first().getAttribute('data-value');

  await page.getByTestId('dash-period-7').click();
  await expect(page).toHaveURL(/davr=7/);
  await expect(page.getByTestId('dash-period-7')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('dash-hero-label')).not.toHaveText(monthLabel!);
  expect(await page.getByTestId('tile-revenue').locator('a').first().getAttribute('href')).not.toBe(monthHref);
  // The kassa is a balance NOW — no period moves it.
  expect(await page.getByTestId('tile-cash').locator('[data-value]').first().getAttribute('data-value')).toBe(cash);
  // The comparison is printed as dates, never a sentence that has to guess.
  await expect(page.getByTestId('dash-hero-prior')).toContainText(/\d{2}\.\d{2}/);

  await page.goto('/dashboard?davr=xx');
  await expect(page.getByTestId('dash-period-oy')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('dash-hero-label')).toHaveText(monthLabel!);
});

test('one warehouse narrows the cargo; the money says it is the whole company; a foreign id is dropped', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/dashboard');
  const select = page.locator('#dash-ombor-select');
  await expect(select).toBeVisible();
  const allRows = await page.getByTestId('wh-fill-row').count();
  expect(allRows).toBeGreaterThan(1);
  await expect(page.getByTestId('dash-hero-scope')).toHaveAttribute('data-scope', 'period');

  const id = await select.locator('option').nth(1).getAttribute('value');
  await page.goto(`/dashboard?ombor=${id}`);
  await expect(page.getByTestId('wh-fill-row')).toHaveCount(1);
  await expect(page.getByTestId('dash-hero-scope')).toHaveAttribute('data-scope', 'company');
  await expect(select).toHaveValue(id!);
  // The period links keep the warehouse (#514).
  expect(await page.getByTestId('dash-period-7').getAttribute('href')).toContain(`ombor=${id}`);

  // A warehouse id nobody offered is a forged post: it is dropped, not obeyed.
  await page.goto('/dashboard?ombor=00000000-0000-0000-0000-00000000abcd');
  await expect(select).toHaveValue('');
  await expect(page.getByTestId('wh-fill-row')).toHaveCount(allRows);
  await expect(page.getByTestId('dash-hero-scope')).toHaveAttribute('data-scope', 'period');
});

test('the money is the owner\'s and the admin\'s: the accountant sees none of it', async ({ page }) => {
  // His answer 4a (2026-09-25): the accountant has the accounting screens.
  await login(page, ACCOUNTANT);
  await page.goto('/dashboard');
  await expect(page.getByTestId('section-logisticsTitle')).toBeVisible();
  await expect(page.getByTestId('section-moneyTitle')).toHaveCount(0);
  await expect(page.getByTestId('dash-hero')).toHaveCount(0);
  await expect(page.getByTestId('dash-cash-weeks')).toHaveCount(0);
  await expect(page.getByTestId('dash-aging')).toHaveCount(0);
  await expect(page.getByTestId('tile-cash')).toHaveCount(0);
  await expect(page.getByTestId('tile-intake')).toBeVisible();
  await expect(page.getByTestId('dash-intake-days')).toBeVisible();
});

test('a warehouse manager gets the warehouse half, no money and no warehouse picker', async ({ page }) => {
  await login(page, YW_MANAGER);
  await page.goto('/dashboard');
  await expect(page.getByTestId('section-logisticsTitle')).toBeVisible();
  await expect(page.getByTestId('section-attention')).toBeVisible();
  // No finance permission → the block is absent, not empty.
  await expect(page.getByTestId('section-moneyTitle')).toHaveCount(0);
  await expect(page.getByTestId('tile-cash')).toHaveCount(0);
  // One warehouse of his own: nothing to choose between.
  await expect(page.getByTestId('dash-ombor')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('the logist reads the funnel and never its money (judge O7)', async ({ page }) => {
  await login(page, LOGIST);
  await page.goto('/dashboard');
  await expect(page.getByTestId('dash-funnel')).toBeVisible();
  await expect(page.getByTestId('dash-funnel-flow')).toHaveCount(0);
  await expect(page.getByTestId('dash-funnel')).not.toContainText('$');
});

test('the map fills the screen and says which mark is which', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/map');

  // The key that tells a warehouse mark from a truck mark.
  await expect(page.getByTestId('map-legend')).toBeVisible();

  const toggle = page.getByTestId('map-fullscreen');
  await expect(toggle).toBeVisible();
  await toggle.click();
  // Fullscreen really covers the viewport, tab bar and header included.
  const box = (await page.locator('.fixed.inset-0').first().boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.width).toBeCloseTo(view.width, 0);
  expect(box.height).toBeCloseTo(view.height, 0);

  await toggle.click();
  await expect(page.locator('.fixed.inset-0')).toHaveCount(0);

  // Tapping a warehouse answers INSIDE the map (owner, item 12): the popup
  // is a child of the canvas, so it also survives fullscreen — the old cards
  // below the map were exactly what fullscreen buried.
  // A truck that has just departed stands ON its origin warehouse, and the
  // truck mark takes the tap (deliberately — Leaflet gives it zIndexOffset
  // 1000, the schematic draws it last). Round 109's bigger lorry made that
  // overlap likelier, so the spec picks a pin nothing is covering instead of
  // trusting the first one; if every pin were covered it still fails loudly.
  const pins = page.getByTestId('map-warehouse');
  const free = await pins.evaluateAll((nodes) =>
    nodes.findIndex((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit ? node.contains(hit) : false;
    }),
  );
  expect(free, 'no warehouse mark is clickable — every one is under a truck').toBeGreaterThan(-1);
  await pins.nth(free).click();
  const popup = page.getByTestId('map-popup');
  await expect(popup).toBeVisible();
  await expect(popup.locator('a[href^="/stock"]')).toBeVisible();
  await popup.getByRole('button', { name: 'close' }).click();
  await expect(page.getByTestId('map-popup')).toHaveCount(0);
});
