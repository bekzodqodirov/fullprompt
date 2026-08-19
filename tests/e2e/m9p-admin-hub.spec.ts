import { expect, test } from '@playwright/test';

/**
 * The owner's feedback round, batch 1 (2026-07-28).
 *
 * «Boshqaruv» is a hub of buttons now, not a corridor into the warehouse
 * list; expense types are data he edits himself; and the two sales boards
 * carry doors to each other. Each spec is written against the thing he
 * actually complained about.
 */

const OWNER = '+998900000001';
const YW_OPERATOR = '+998900000006';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('administration opens as a hub of buttons, not the warehouse list', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/admin');
  await expect(page).toHaveURL('/admin');
  // Every section is a button on ONE screen — nothing left to a strip that
  // scrolls off the phone. The owner holds every permission, so all doors.
  const tiles = page.getByTestId('admin-tile');
  expect(await tiles.count()).toBeGreaterThanOrEqual(10);
  await expect(page.locator('a[href="/admin/cost-types"]').first()).toBeVisible();

  // …and the operator still has no way in.
  await login(page, YW_OPERATOR);
  await page.goto('/admin');
  await expect(page).toHaveURL('/');
});

test('the client book is a Sotuv screen, and says so wherever it is looked at', async ({ page }) => {
  // Round 75, owner: "adminstrativnoedagi klientini glavniga chiqaz". He had
  // asked once before and the TILE was moved — he asked again because the
  // screen still called itself Administration in three places.
  await login(page, OWNER);

  // 1. No second door from the hub. Scoped to the tiles: the shell's own
  //    menu offers the book from Sotuv on every page, including this one,
  //    and that offer is the whole point.
  await page.goto('/admin');
  const tile = (href: string) => page.locator(`a[data-testid="admin-tile"][href="${href}"]`);
  // The control: this selector does find a door that IS on the hub, so the
  // assertion below is about the client book and not about a broken locator.
  await expect(tile('/admin/warehouses')).toHaveCount(1);
  await expect(tile('/admin/clients')).toHaveCount(0);

  // 2. No «← Boshqaruv» on the book itself — while a real admin page keeps it,
  //    so this is a rule about that subtree and not a deletion.
  await page.goto('/admin/warehouses');
  await expect(page.getByTestId('admin-back')).toBeVisible();
  await page.goto('/admin/clients');
  await expect(page.getByTestId('admin-back')).toHaveCount(0);

  // 3. One menu row lit, not two. The highlight prefix-matched, so
  //    «Boshqaruv» used to light up here at the same time as «Mijozlar».
  const lit = page.locator('a[aria-current="page"]');
  expect(await lit.evaluateAll((els) => els.map((el) => el.getAttribute('href')))).toEqual([
    '/admin/clients',
  ]);
});

test('Bitimlar and CRM sit side by side on the home screen', async ({ page }) => {
  // Round 75, owner: "sotuv main ekranda bitim bn crmni ketma ket qoy". They
  // were already consecutive in the navigation list and still wrapped between
  // each other in the phone's two-column grid.
  //
  // Measured in the browser rather than reasoned about, because the unit
  // fence names the column counts and only the real stylesheet knows them.
  await login(page, OWNER);
  // Scoped to the TILE GRID: the admin dashboard above it (round 107) also
  // links /bitimlar, and a bare `.first()` would measure the wrong element.
  const box = async (href: string) =>
    page.locator(`[data-testid="home-tiles"] a[href="${href}"]`).first().boundingBox();
  const deals = await box('/bitimlar');
  const crm = await box('/crm');
  expect(deals).not.toBeNull();
  expect(crm).not.toBeNull();
  // Same row, and the deal board on the left of it.
  expect(Math.round(deals!.y)).toBe(Math.round(crm!.y));
  expect(deals!.x).toBeLessThan(crm!.x);

  // …and «Bugun qo'ng'iroq» is off the screen and off the menu, while the
  // route it pointed at still answers (a menu decision is not an access one).
  await expect(page.locator('a[href="/crm/today"]')).toHaveCount(0);
  await page.goto('/crm/today');
  await expect(page).toHaveURL('/crm/today');
});

test('the owner adds his own expense type — it was never hard-coded, now it has a door', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/admin/cost-types');
  await page.getByTestId('add-cost-type').click();
  const name = `Perevalka ${runId}`;
  await page.locator('input[name="name"]').fill(name);
  await page.getByTestId('save-cost-type').click();
  await expect(page.getByText(name)).toBeVisible();

  // Hidden types leave the expense forms but keep their history — and hiding
  // OUR row keeps later specs' dropdowns free of test data (#154). The form
  // queries only `active` types, so the chip is the visible proof.
  const row = page.locator('.card').filter({ hasText: name }).first();
  // Centre the row first: the dictionary outgrew one phone screen (round 29
  // seeded the grid columns), and Playwright's own scroll-into-view parks a
  // bottom row's buttons exactly under the fixed tab bar.
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await row.locator('form button[type="submit"]').click();
  await expect(page.locator('.card').filter({ hasText: name }).first()).toHaveClass(/opacity-60/);
});

test('each sales board carries the door to the other', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/crm');
  await page.getByTestId('to-deals').click();
  await expect(page).toHaveURL('/bitimlar');
  await page.getByTestId('to-leads').click();
  await expect(page).toHaveURL('/crm');
});
