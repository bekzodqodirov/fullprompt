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

/**
 * What the strip holds and what a reader can reach from it: its parts counted,
 * then the tabs of the row on screen — the report group picked, or the flat
 * row — each with ✂ when the row's edge cuts it off, and how many wait in
 * «Yana ▾». Read until two readings 100 ms apart agree: the fold is worked
 * out after the row gets its size, a frame or two after it is drawn.
 */
async function stripNow(page: Page) {
  const read = () =>
    page.getByTestId('ws-tabs').evaluate((nav) => {
      const shown = [...nav.querySelectorAll<HTMLElement>('[data-testid="ws-row"]')].find(
        (row) => row.clientWidth > 0,
      );
      const edge = shown?.getBoundingClientRect().right ?? 0;
      const inRow = shown
        ? [...shown.querySelectorAll(':scope > a[data-testid="ws-tab"]')].map(
            (link) =>
              `${link.getAttribute('href')}${link.getBoundingClientRect().right > edge + 1 ? ' ✂' : ''}`,
          )
        : [];
      return {
        row: nav.firstElementChild?.children.length ?? -1,
        groups: nav.querySelectorAll('[data-testid="ws-group"]').length,
        stars: nav.querySelectorAll('[data-testid="ws-star"]').length,
        settings: nav.querySelectorAll('[data-testid="ws-settings"]').length,
        tabs: nav.querySelectorAll('[data-testid="ws-tab"]').length,
        inRow,
        folded: shown?.querySelectorAll('[data-testid="ws-more"] a').length ?? 0,
      };
    });
  let last = JSON.stringify(await read());
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(100);
    const now = JSON.stringify(await read());
    if (now === last) break;
    last = now;
  }
  return JSON.parse(last) as Awaited<ReturnType<typeof read>>;
}

test('the strip after a walk of clicks is the strip a fresh load of the same page draws', async ({
  page,
}) => {
  // The owner's screenshot of 2026-09-30: three «Yuk ▾» pickers and two
  // «Yana ▾» folds side by side in one row, one copy per page he had clicked
  // to. Every other test here arrives by `page.goto`, i.e. a whole new
  // document with a clean strip, which is how it stayed green: only a CLIENT
  // navigation leaves the old copy behind (#1247), and only a client
  // navigation reuses the row for another workspace's tabs (#1248). So the
  // walk is clicks — the strip's own links, then the sidebar across every
  // workspace — and the oracle is a fresh load of each address, something the
  // strip's code does not get to write.
  await login(page, '+998900000001');
  const strip = page.getByTestId('ws-tabs');
  const walked: { href: string; seen: Awaited<ReturnType<typeof stripNow>> }[] = [];
  // A marker on the WINDOW survives a client navigation and dies with a
  // reload — so a click that landed before hydration and reloaded the page
  // fails here instead of passing on a clean strip (#494).
  // The address is read back rather than assumed: a list with a saved
  // default view answers a bare visit with that view (round 57).
  const arrived = async (href: string) => {
    await page.waitForURL((url) => url.pathname === href);
    expect(await page.evaluate(() => '__walk' in window), `${href}: a click, not a reload`).toBe(
      true,
    );
    const url = new URL(page.url());
    walked.push({ href: url.pathname + url.search, seen: await stripNow(page) });
  };
  // Hisobotlar (the grouped strip — his screenshot is its cargo group) and
  // Yo'l (a flat strip with a ⚙: the ☆ and the ⚙ are siblings there).
  for (const [start, group] of [
    ['/dashboard', 'cargo'],
    ['/batches', null],
  ] as const) {
    await page.goto(start);
    await page.waitForLoadState('networkidle');
    if (group) await strip.getByTestId('ws-group').selectOption(group);
    await stripNow(page);
    const hrefs = await hrefsIn(page, '[data-testid="ws-tabs"] a[data-testid="ws-tab"]:visible');
    await page.evaluate(() => Object.assign(window, { __walk: true }));
    for (const href of hrefs.filter((one) => one !== start).slice(0, 3)) {
      await strip.locator(`a[data-testid="ws-tab"][href="${href}"]:visible`).click();
      await arrived(href);
    }
  }
  // Across workspaces by the sidebar: the layout keeps the strip, and the row
  // takes the next workspace's tabs.
  const cross = async (href: string) => {
    await page.locator(`[data-testid="sidebar"] a[data-testid^="ws-"][href="${href}"]`).click();
    await arrived(href);
  };
  const rows = await hrefsIn(page, '[data-testid="sidebar"] a[data-testid^="ws-"]');
  const flat = rows.filter((one) => one !== '/' && one !== '/admin' && one !== '/dashboard');
  for (const href of [...flat, '/dashboard']) await cross(href);
  // …and straight from one folded row to another, both ways: a workspace
  // between them whose tabs all fit unfolds the row and hides the stale
  // count, which is how a walk in menu order stayed green on it at 1280 px.
  const folding = flat.filter((href) =>
    walked.some((one) => one.href.split('?')[0] === href && one.seen.folded > 0),
  );
  expect(folding.length, 'two flat workspaces whose rows fold').toBeGreaterThanOrEqual(2);
  for (const href of [folding[1]!, folding[0]!, folding[1]!]) await cross(href);
  expect(walked.length).toBeGreaterThanOrEqual(12);
  for (const { href, seen } of walked) {
    await page.goto(href);
    await page.waitForLoadState('networkidle');
    expect(seen, href).toEqual(await stripNow(page));
  }
});

test('a report group picked in the strip folds what does not fit, and cuts nothing off', async ({
  page,
}) => {
  // #1248's other half: the groups not picked are drawn hidden, a hidden link
  // measures 0 px, and a row measured then believed everything fitted — so
  // «Moliya» picked on the dashboard showed five of its eight reports and cut
  // the rest off the edge, with no «Yana ▾» to reach them. The oracle is the
  // geometry: a tab is either wholly inside the row or in the fold.
  await login(page, '+998900000001');
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
  const picker = page.getByTestId('ws-tabs').getByTestId('ws-group');
  const groups = await picker
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(groups.length).toBeGreaterThanOrEqual(5);
  let folds = 0;
  for (const group of groups) {
    await picker.selectOption(group);
    const now = await stripNow(page);
    expect(
      now.inRow.filter((tab) => tab.endsWith('✂')),
      group,
    ).toEqual([]);
    folds += now.folded;
  }
  // The premise: at this width some group does not fit, or «nothing is cut
  // off» would be true of a strip that never folds at all.
  expect(folds).toBeGreaterThan(0);
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
