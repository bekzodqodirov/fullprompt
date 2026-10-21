import { expect, test, type Page } from '@playwright/test';
import { database, DRIVER, dropSpecTrucks, mintBoardTruck, mintFormingTruck, mintInlandTruck } from './doska-fixture';

/**
 * Partiya doskasi on a phone (his 1A 2a 3a 10b, docs/PARTIYA-DOSKASI.md §3):
 * the road strip of counts filters the board to a place, the columns are
 * four tabs over one DOM — the «Yo'lda» tab holding both road columns (his
 * «xitoy ichidagi va tashqisi», 2026-10-21) — and the ⋯ on a truck on the
 * road carries the logist's pins and the driver's number. A pin moves the
 * card to its new place. The spec's own trucks are minted on the YW → TAS1
 * and YW → KA roads and deleted by its last test.
 */

test.describe.configure({ mode: 'serial' });

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const sql = database();
let truck: { id: string; code: string };
let forming: { id: string; code: string };
let inland: { id: string; code: string };

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
  forming = await mintFormingTruck(sql, OWNER);
  inland = await mintInlandTruck(sql, OWNER);
});

test.afterAll(async () => {
  // Every truck this spec ever minted, whichever test failed or retried.
  await dropSpecTrucks(sql, 'DSK');
  await dropSpecTrucks(sql, 'DSF');
  await dropSpecTrucks(sql, 'DSI');
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
  await expect(page.getByTestId('board-section-outbound-cn')).toContainText(truck.code);
  // A tab is a radio: the arrived column is one tap away, the road one hidden.
  await page.locator('label:has(#bt-arrived)').click();
  await expect(card).toBeHidden();
  await page.locator('label:has(#bt-road)').click();
  await expect(card).toBeVisible();
  await fitsThePhone(page);
});

test('the «Yo’lda» tab holds both road columns: to Kashgar inside China, to Tashkent outside it', async ({ page }) => {
  await login(page);
  await page.goto('/batches');
  await page.locator('label:has(#bt-road)').click();
  const inlandCol = page.getByTestId('board-col-inland');
  const outboundCol = page.getByTestId('board-col-outbound');
  // Both halves on the one tab, each told apart by its own heading.
  await expect(inlandCol.locator('h2')).toBeVisible();
  await expect(outboundCol.locator('h2')).toBeVisible();
  // Yiwu → Kashgar is inland, under its destination; Yiwu → Tashkent outbound.
  const inlandCard = inlandCol.locator(`[data-testid=batch-board-card][data-code="${inland.code}"]`);
  await expect(inlandCard).toBeVisible();
  await expect(inlandCard.locator('xpath=ancestor::div[starts-with(@data-testid, "board-section-inland-to:")]').locator('h3')).toContainText('→ Kashgar');
  await expect(outboundCol.locator(`[data-testid=batch-board-card][data-code="${truck.code}"]`)).toBeVisible();
  await expect(inlandCol.locator(`[data-testid=batch-board-card][data-code="${truck.code}"]`)).toHaveCount(0);
  // Every inland trip is inside China: the «ichki reys» badge would say nothing there.
  await expect(inlandCard.getByTestId('board-badge-internal')).toHaveCount(0);
  // The other tabs hide both halves.
  await page.locator('label:has(#bt-arrived)').click();
  await expect(inlandCol).toBeHidden();
  await expect(outboundCol).toBeHidden();
  await fitsThePhone(page);
});

test('a strip tap opens its column even after a tab was picked by hand', async ({ page }) => {
  await login(page);
  await page.goto('/batches');
  // The spec's own quick truck makes «Shakllanmoqda» the column the phone
  // opens on; the person then looks at another column by hand…
  await expect(page.getByTestId('board-tab-forming')).toBeChecked();
  await page.locator('label:has(#bt-arrived)').click();
  await expect(page.getByTestId('board-tab-arrived')).toBeChecked();
  // …and taps «Shakllanmoqda» on the strip: the default column did not
  // change, and the tab must follow the tap all the same (the review's
  // finding — a soft navigation kept the hand-picked radio).
  await page.getByTestId('board-stop-forming').click();
  await expect(page).toHaveURL(/[?&]joy=forming/);
  await expect(page.getByTestId('board-tab-forming')).toBeChecked();
  const card = page.locator(`[data-testid=batch-board-card][data-code="${forming.code}"]`);
  await expect(card).toBeVisible();
  // A quick truck with nothing scanned reads «rejasiz». (The scanned quick
  // truck — «Yuklandi N karobka», never «N / N · hammasi yuklandi» — is
  // `cargoLineOf`'s table in tests/unit/batch-board.test.ts.)
  await expect(card.getByTestId('board-cargo')).not.toContainText('/');
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
  await expect(page.getByTestId('board-section-outbound-transit')).toContainText(truck.code);
  await moved.getByTestId('board-menu').locator('summary').click();
  await expect(moved.getByTestId('board-pin-now')).toContainText('🇰🇬');
  await expect(moved.locator('form button')).toHaveCount(2);
  await expect(moved.locator('form button', { hasText: '🇰🇬' })).toHaveCount(0);
  await fitsThePhone(page);
});

test('cleanup: the spec’s trucks leave the board', async () => {
  await dropSpecTrucks(sql, 'DSK');
  await dropSpecTrucks(sql, 'DSF');
  await dropSpecTrucks(sql, 'DSI');
  const left = await sql`SELECT 1 FROM batches WHERE code LIKE 'DSK%' OR code LIKE 'DSF%' OR code LIKE 'DSI%'`;
  expect(left.length).toBe(0);
});
