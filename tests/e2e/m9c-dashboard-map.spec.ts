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

test('the dashboard covers the money, the cargo and the funnel', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/dashboard');

  // Six morning figures, then what needs a person, then the three parts.
  for (const id of ['tile-cash', 'tile-revenue', 'tile-profit', 'tile-receivable', 'tile-intake', 'tile-won']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
  await expect(page.getByTestId('kpi-row').locator('> *')).toHaveCount(6);
  for (const key of ['section-attention', 'section-moneyTitle', 'section-logisticsTitle', 'section-salesTitle']) {
    await expect(page.getByTestId(key)).toBeVisible();
  }
  for (const id of ['dash-pnl-chart', 'dash-cash-chart', 'dash-balance-rows', 'dash-aging-bar', 'dash-trips', 'dash-unbilled', 'dash-pipeline-bar']) {
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

test('the money is the owner\'s and the admin\'s: the accountant sees none of it', async ({ page }) => {
  // His answer 4a (2026-09-25): the accountant has the accounting screens.
  await login(page, ACCOUNTANT);
  await page.goto('/dashboard');
  await expect(page.getByTestId('section-logisticsTitle')).toBeVisible();
  await expect(page.getByTestId('section-moneyTitle')).toHaveCount(0);
  await expect(page.getByTestId('tile-cash')).toHaveCount(0);
  await expect(page.getByTestId('tile-intake')).toBeVisible();
});

test('a warehouse manager gets the warehouse half and no money', async ({ page }) => {
  await login(page, YW_MANAGER);
  await page.goto('/dashboard');
  await expect(page.getByTestId('section-logisticsTitle')).toBeVisible();
  await expect(page.getByTestId('section-attention')).toBeVisible();
  // No finance permission → the block is absent, not empty.
  await expect(page.getByTestId('section-moneyTitle')).toHaveCount(0);
  await expect(page.getByTestId('tile-cash')).toHaveCount(0);
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
