import { expect, test } from '@playwright/test';

/**
 * The dock (owner, items 5+7): chat and tasks reachable from ANY page, and a
 * card that is about a client opens the drawer straight into that client's
 * conversation. The warehouse gets a tasks-only dock: the conversation gate
 * is the same one /suhbatlar holds.
 */

const OWNER = '+998900000001';
const YW_OPERATOR = '+998900000006';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/**
 * Open the drawer, pressing again only while it is still closed. Measured:
 * this spec failed once in a full run (the panel never appeared after the
 * press) and passed 9 of 9 alone on the same build and database — the likely
 * cause is a press that lands before hydration, on a button with no handler
 * yet. The button is a TOGGLE, so a blind second press would close a drawer
 * the first one opened (fold.ts's guard).
 */
async function openDock(page: import('@playwright/test').Page) {
  const panel = page.getByTestId('dock-panel');
  await expect(async () => {
    if (!(await panel.isVisible())) await page.getByTestId('dock-button').click();
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

test('a warehouse operator gets no chat tab, on any page', async ({ page }) => {
  await login(page, YW_OPERATOR);
  await page.goto('/stock');
  await openDock(page);
  // No chat tab — reading clients' conversations is not warehouse work.
  await expect(page.getByTestId('dock-tab-chat')).toHaveCount(0);
  // «👥 Ichki» since round 2 (0129, E7 b): the prixod and truck threads of
  // the cargo standing at his warehouse land there.
  await expect(page.getByTestId('dock-tab-threads')).toHaveCount(1);
  await expect(page.getByTestId('dock-tab-tasks')).toBeVisible();
});

test('on a client card the dock opens straight into that conversation', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/admin/clients');
  // A real client ROW — the first matching href is the «new client» button,
  // and the new-client form is about nobody.
  const link = page.locator('main a[href^="/admin/clients/"]:not([href$="/new"])').first();
  await link.click();
  await expect(page).toHaveURL(/\/admin\/clients\/(?!new).+/);

  await openDock(page);
  // The marker did its job: no list to search, the thread header names the
  // client this card is about.
  await expect(page.getByTestId('dock-thread-client')).toBeVisible({ timeout: 10_000 });

  // Back leads to the full conversation list.
  await page.getByTestId('dock-thread-back').click();
  await expect(page.getByTestId('dock-thread-client')).toHaveCount(0);
});

test('the dock closes itself on navigation', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/stock');
  await openDock(page);
  await page.getByTestId('dock-tab-tasks').click();
  // Follow the «my day» link out of the dock — the drawer must not stay
  // standing over the new page.
  await page.locator('a[href="/bugun"]').last().click();
  await expect(page).toHaveURL('/bugun');
  await expect(page.getByTestId('dock-panel')).toHaveCount(0);
});
