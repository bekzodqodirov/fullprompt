import { expect, test, type Page } from '@playwright/test';

/**
 * The menu by job — «ish joylari» (2026-09-26, docs/NAV-WORKSPACES.md).
 *
 * The unit fence walks every tab through each page's gate as the code states
 * it; this is the oracle that cannot be fooled by a restated rule: log in as
 * every shipped person, harvest every link the menu actually DRAWS for them,
 * and ask the server for each one. A redirect is a tab that bounces — the
 * thing the whole round promises never to draw.
 *
 * Desktop because the sidebar exists only from `md` up. It leaves one
 * configuration row behind for nobody: the star it toggles is taken off again
 * in the same test (#183).
 */

const PASSWORD = 'demo1234';
const PEOPLE = [
  ['+998900000001', 'super_admin'],
  ['+998900000002', 'admin'],
  ['+998900000003', 'logist'],
  ['+998900000004', 'ved_manager'],
  ['+998900000005', 'warehouse_manager'],
  ['+998900000006', 'warehouse_operator'],
  ['+998900000009', 'sales_manager'],
  ['+998900000010', 'accountant'],
  ['+998900000011', 'viewer'],
] as const;

async function login(page: Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const hrefsIn = async (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));

/** Everything the menu draws for this person: workspace rows, then every strip. */
async function harvest(page: Page): Promise<Set<string>> {
  const found = new Set<string>();
  const entries = await hrefsIn(page, '[data-testid="sidebar"] a[data-testid^="ws-"]');
  for (const href of entries) {
    found.add(href);
    await page.goto(href);
    // Tabs (every report group's, the hidden ones included) and the ⚙
    // settings — the ⚙ list is in the DOM while closed.
    for (const one of await hrefsIn(page, '[data-testid="ws-tabs"] a')) found.add(one);
  }
  return found;
}

test('every page the menu offers opens for the person it is offered to', async ({ page }) => {
  test.setTimeout(600_000);
  // The control: the oracle below must be able to SEE a bounce, or a green
  // run proves nothing (#494). A packer asking for the accounts is sent home.
  await login(page, '+998900000006');
  const bounce = await page.request.get('/accounting', { maxRedirects: 0 });
  expect(bounce.status()).toBeGreaterThanOrEqual(300);
  expect(bounce.status()).toBeLessThan(400);

  for (const [phone, role] of PEOPLE) {
    await login(page, phone);
    const offered = await harvest(page);
    expect(offered.size, role).toBeGreaterThan(1);
    for (const href of offered) {
      const answer = await page.request.get(href, { maxRedirects: 0 });
      expect(answer.status(), `${role} is offered ${href}`).toBe(200);
    }
  }
});

test('a packer’s menu is the warehouse and the trucks, nothing else', async ({ page }) => {
  await login(page, '+998900000006');
  const rows = await hrefsIn(page, '[data-testid="sidebar"] a[data-testid^="ws-"]');
  const keys = await page
    .locator('[data-testid="sidebar"] a[data-testid^="ws-"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('data-testid')));
  expect(keys).toEqual(['ws-home', 'ws-sklad', 'ws-yol']);
  expect(rows).toEqual(['/', '/stock', '/batches']);
  // …and on the stock screen the strip is Sklad's, with this page lit.
  await page.goto('/stock');
  const lit = page.locator('[data-testid="ws-tabs"] a[aria-current="page"]');
  await expect(lit).toHaveAttribute('href', '/stock');
  await expect(page.locator('[data-testid="ws-tabs"] a[href="/accounting"]')).toHaveCount(0);
});

test('the reports live in one place, grouped, and the owner’s settings sit in their own job', async ({
  page,
}) => {
  await login(page, '+998900000001');
  // The P&L is a REPORT now, in the money group, and «Hisobotlar» is lit.
  await page.goto('/accounting/pnl');
  await expect(page.getByTestId('ws-reports')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('[data-testid="ws-tabs"] a[aria-current="page"]')).toHaveAttribute(
    'href',
    '/accounting/pnl',
  );
  // The groups are a switch in place, not six more navigations.
  expect(await page.getByTestId('ws-group').locator('option').count()).toBeGreaterThanOrEqual(5);
  // The FX rates are a Pul TAB (typed daily), and the page no longer calls
  // itself administration…
  await page.goto('/admin/fx');
  await expect(page.getByTestId('ws-pul')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('admin-back')).toHaveCount(0);
  await expect(page.locator('[data-testid="ws-tab"][href="/admin/fx"]').first()).toHaveAttribute(
    'aria-current',
    'page',
  );
  // …and the cost types are Pul's ⚙.
  await page.goto('/admin/cost-types');
  await expect(page.getByTestId('ws-pul')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('[data-testid="ws-setting"][href="/admin/cost-types"]')).toHaveAttribute(
    'aria-current',
    'page',
  );
  // …and the hub no longer offers them twice.
  await page.goto('/admin');
  await expect(page.locator('a[data-testid="admin-tile"][href="/admin/fx"]')).toHaveCount(0);
  await expect(page.locator('a[data-testid="admin-tile"][href="/admin/warehouses"]')).toHaveCount(1);
});

test('a star puts a page in «Tez-tez», and taking it off takes it out', async ({ page }) => {
  await login(page, '+998900000001');
  await page.goto('/accounting/expenses');
  const star = page.getByTestId('ws-star');
  const frequent = page.locator('[data-testid="frequent-item"][href="/accounting/expenses"]');
  // Put the page back the way it was found, whatever an earlier run left.
  if ((await star.getAttribute('aria-pressed')) === 'true') {
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'false');
  }
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(frequent).toHaveCount(1);
  // The workspace's own first page has no star: it is already a menu row.
  await page.goto('/accounting');
  await expect(page.getByTestId('ws-star')).toHaveCount(0);
  // Cleanup is part of the test (#183, round 57's afterAll lie).
  await page.goto('/accounting/expenses');
  await page.getByTestId('ws-star').click();
  await expect(page.getByTestId('ws-star')).toHaveAttribute('aria-pressed', 'false');
  await expect(frequent).toHaveCount(0);
});

test('«+ Yangi» opens the doors, and a payment starts by naming the client', async ({ page }) => {
  await login(page, '+998900000001');
  await page.getByTestId('quick-create').click();
  for (const key of ['receive', 'deal', 'payment', 'expense', 'calc', 'task']) {
    await expect(page.getByTestId(`quick-act-${key}`)).toBeVisible();
  }
  // The lead box is still where the panel opens (round 60's rule).
  await expect(page.getByTestId('quick-name')).toBeFocused();
  await page.getByTestId('quick-act-payment').click();
  await page.getByTestId('quick-pick-input').fill('GS777');
  await page.getByTestId('quick-pick-hit').first().click();
  await expect(page).toHaveURL(/\/finance\/[0-9a-f-]{36}$/);
});
