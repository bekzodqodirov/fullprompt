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

test('the dashboard covers logistics, money and the funnel', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/dashboard');

  // Every section the owner asked for, in one screen.
  for (const key of ['todayTitle', 'moneyTitle', 'salesTitle', 'logisticsTitle']) {
    await expect(page.getByTestId(`section-${key}`)).toBeVisible();
  }
  // The money block reports real figures off the ledger, not placeholders.
  await expect(page.getByTestId('section-moneyTitle')).toContainText('$');
  // The headline row is four tiles regardless of what the numbers say.
  await expect(page.getByTestId('kpi-row').locator('> *')).toHaveCount(4);
});

test('a warehouse manager gets the warehouse half and no money', async ({ page }) => {
  await login(page, YW_MANAGER);
  await page.goto('/dashboard');
  await expect(page.getByTestId('section-logisticsTitle')).toBeVisible();
  // No finance permission → the block is absent, not empty.
  await expect(page.getByTestId('section-moneyTitle')).toHaveCount(0);
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
