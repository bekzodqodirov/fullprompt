import { expect, test, type Page } from '@playwright/test';
import { database, dropSpecTrucks, mintBoardTruck } from './doska-fixture';

/**
 * Partiya doskasi on a desktop (docs/PARTIYA-DOSKASI.md §3): the five
 * columns side by side with no tabs — the road in two, inside China and
 * outside it (2026-10-21) — the road bar beside the %, and the
 * corridor filter — a Yiwu → Tashkent truck drives the Irkeshtam road and is
 * no «ichki reys». The spec's own truck is deleted by its last test.
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

test.beforeAll(async () => {
  truck = await mintBoardTruck(sql, OWNER, 'DSD');
});

test.afterAll(async () => {
  await dropSpecTrucks(sql, 'DSD');
  await sql.end();
});

test('five columns in one row, no tabs, and the truck on the outbound road with its bar', async ({ page }) => {
  await login(page);
  await page.goto('/batches');
  const cols = ['forming', 'loading', 'inland', 'outbound', 'arrived'];
  for (const col of cols) await expect(page.getByTestId(`board-col-${col}`)).toBeVisible();
  // One frame (#1429): the five stand on one row, left to right in road order.
  const boxes = await page.evaluate(
    (ids) => ids.map((id) => document.querySelector(`[data-testid="board-col-${id}"]`)!.getBoundingClientRect()),
    cols,
  );
  for (const b of boxes) expect(Math.abs(b.y - boxes[0]!.y)).toBeLessThan(2);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x);
  await expect(page.getByTestId('board-tab-road')).toBeHidden();
  const card = page.getByTestId('board-col-outbound').locator(`[data-testid=batch-board-card][data-code="${truck.code}"]`);
  await expect(card).toBeVisible();
  const road = card.getByTestId('board-road');
  await expect(road).toContainText('%');
  // The bar is decoration: the place and the % are printed beside it.
  await expect(road.locator('[aria-hidden="true"]').first()).toBeAttached();
  const width = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
});

test('the corridor filter keeps the Irkeshtam road and drops it from «ichki»', async ({ page }) => {
  await login(page);
  await page.goto('/batches');
  const card = page.locator(`[data-testid=batch-board-card][data-code="${truck.code}"]`);
  await page.getByTestId('board-filter-fold').locator('summary').click();
  await page.locator('select[name="yonalish"]').selectOption('irkeshtam');
  await page.getByTestId('board-filters').getByRole('button').click();
  await expect(page).toHaveURL(/[?&]yonalish=irkeshtam/);
  await expect(card).toBeVisible();
  // The fold stays open while a filter is on — what narrows the board is never hidden.
  await expect(page.locator('select[name="yonalish"]')).toBeVisible();
  await page.locator('select[name="yonalish"]').selectOption('ichki');
  await page.getByTestId('board-filters').getByRole('button').click();
  await expect(page).toHaveURL(/[?&]yonalish=ichki/);
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('batch-board')).toBeAttached();
});

test('cleanup: the spec’s truck leaves the road', async () => {
  await dropSpecTrucks(sql, 'DSD');
  const left = await sql`SELECT 1 FROM batches WHERE code LIKE 'DSD%'`;
  expect(left.length).toBe(0);
});
