import { expect, test, type Page } from '@playwright/test';
import { database, DRIVER, dropBoardTruck, mintBoardTruck } from './doska-fixture';

/**
 * Partiya doskasi on a phone (his 1A 2a 3a 10b, docs/PARTIYA-DOSKASI.md §3):
 * the road strip of counts filters the board to a place, the four columns
 * are tabs over one DOM, and the ⋯ on a truck on the road carries the
 * logist's pins and the driver's number. A pin moves the card to its new
 * place. The spec's own truck is minted on the YW → TAS1 road and deleted by
 * its last test.
 */

test.describe.configure({ mode: 'serial' });

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const sql = database();
let truck: { id: string; code: string };

async function login(page: Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/** The document is exactly the phone: no overflow, and no zoom-out (#400, e2e-width-oracle). */
async function fitsThePhone(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
  expect(client).toBe(page.viewportSize()!.width);
}

test.beforeAll(async () => {
  truck = await mintBoardTruck(sql, OWNER);
});

test.afterAll(async () => {
  await sql.end();
});

test('the strip filters the board to a place and opens its column', async ({ page }) => {
  await login(page);
  await page.goto('/batches');
  await fitsThePhone(page);
  const card = page.locator(`[data-testid=batch-board-card][data-code="${truck.code}"]`);
  // A day out of Yiwu on a six-day road: inside China by its schedule.
  const stop = page.getByTestId('board-stop-road_cn');
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(page).toHaveURL(/[?&]joy=road_cn/);
  await expect(page.getByTestId('board-stop-road_cn')).toHaveAttribute('aria-current', 'true');
  // The phone opens on the road column, and the card is drawn.
  await expect(page.getByTestId('board-tab-road')).toBeChecked();
  await expect(card).toBeVisible();
  await expect(page.getByTestId('board-section-road-cn')).toContainText(truck.code);
  // A tab is a radio: the arrived column is one tap away, the road one hidden.
  await page.locator('label:has(#bt-arrived)').click();
  await expect(card).toBeHidden();
  await page.locator('label:has(#bt-road)').click();
  await expect(card).toBeVisible();
  await fitsThePhone(page);
});

test('the ⋯ pins the truck in Kyrgyzstan and the card moves to «Tranzitda»', async ({ page }) => {
  await login(page);
  await page.goto('/batches?joy=road_cn');
  const card = page.locator(`[data-testid=batch-board-card][data-code="${truck.code}"]`);
  await card.getByTestId('board-menu').locator('summary').click();
  // The driver's number dials digits only, and is printed as written.
  const call = card.getByTestId('board-call');
  await expect(call).toHaveAttribute('href', 'tel:+998907654321');
  await expect(call).toContainText(DRIVER);
  // No pin yet: all three of the road's pins are offered, none as «Hozir».
  await expect(card.getByTestId('board-pin-now')).toHaveCount(0);
  await expect(card.locator('form button')).toHaveCount(3);
  await card.locator('form button', { hasText: '🇰🇬' }).click();
  // The press revalidates the board: off the «inside China» stop…
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  // …and on the transit one, with the pin as a chip and not as a button.
  await page.getByTestId('board-stop-road_transit').click();
  await expect(page).toHaveURL(/[?&]joy=road_transit/);
  const moved = page.locator(`[data-testid=batch-board-card][data-code="${truck.code}"]`);
  await expect(moved).toBeVisible();
  await expect(page.getByTestId('board-section-road-transit')).toContainText(truck.code);
  await moved.getByTestId('board-menu').locator('summary').click();
  await expect(moved.getByTestId('board-pin-now')).toContainText('🇰🇬');
  await expect(moved.locator('form button')).toHaveCount(2);
  await expect(moved.locator('form button', { hasText: '🇰🇬' })).toHaveCount(0);
  await fitsThePhone(page);
});

test('cleanup: the spec’s truck leaves the road', async () => {
  await dropBoardTruck(sql, truck.id);
  const left = await sql`SELECT 1 FROM batches WHERE id = ${truck.id}`;
  expect(left.length).toBe(0);
});
