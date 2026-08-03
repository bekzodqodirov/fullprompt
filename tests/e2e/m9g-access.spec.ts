import { expect, test } from '@playwright/test';

/**
 * Who sees what.
 *
 * The owner's ask, in his words: "mening kunim / kalendarlar skladchiga
 * korinishi shart emas — ularga faqat sklad boyicha ishlar korinsa boladi …
 * dostuplarni kimga nimalar korinishini yahwilab organ va togirla".
 *
 * Two separate claims live here, and they pull in opposite directions:
 *  - a warehouse operator's app is only the warehouse, and
 *  - work assigned to that operator must STILL reach them.
 * A menu change that fails the second is not tidying, it is losing work, so
 * both are asserted in the same file where they cannot drift apart.
 *
 * The rest is access, not clutter: pages that had no gate at all, and a
 * warehouse scope that the LIST screens applied and the CARD screens did not.
 */

const OWNER = '+998900000001';
const YW_OPERATOR = '+998900000006';
const GZ_OPERATOR = '+998900000007';
const LOGIST = '+998900000003';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);

/** Open a <details> panel only if it is shut — it may open itself. */
async function openPanel(page: import('@playwright/test').Page, testId: string) {
  const summary = page.getByTestId(testId);
  await expect(summary).toBeVisible();
  const open = await summary.evaluate(
    (el) => (el.parentElement as HTMLDetailsElement | null)?.open ?? false,
  );
  if (!open) await summary.click();
}

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('a warehouse operator gets a warehouse app, and nothing else', async ({ page }) => {
  await login(page, YW_OPERATOR);

  // The home tiles ARE the menu on a phone.
  await expect(page.locator('main a[href="/receive"]').first()).toBeVisible();
  await expect(page.locator('main a[href="/batches"]').first()).toBeVisible();

  // Round 47, the owner's item 9: a promise about cargo is a sales fact, and
  // there is nothing a packer can do with one. Gone from his screens — the
  // route still answers for the people whose job it is.
  await expect(page.locator('main a[href="/arrivals"]')).toHaveCount(0);
  // …and «Свои списки» is gone from everybody's, his instruction («kerak
  // emas, olib tashla»).
  await expect(page.locator('main a[href="/o"]')).toHaveCount(0);

  // The personal planner belongs to people who plan; a packer is told what to
  // pack. Both entries are gone from the menu — not from the app.
  await expect(page.locator('main a[href="/kalendar"]')).toHaveCount(0);
  await expect(page.locator('main a[href="/crm"]')).toHaveCount(0);
  await expect(page.locator('main a[href="/accounting"]')).toHaveCount(0);
  await expect(page.locator('main a[href="/pipeline"]')).toHaveCount(0);
});

test('work given to a warehouse operator still reaches them', async ({ page }) => {
  // Raised by the owner, on the operator, due today.
  await login(page, OWNER);
  await page.goto('/bugun');
  await openPanel(page, 'new-task-panel');
  const title = `Yashiklarni qayta joyla ${runId}`;
  await page.getByTestId('task-title').fill(title);
  const picker = page.getByTestId('task-assignee');
  const options = await picker.locator('option').all();
  let operatorValue: string | null = null;
  for (const option of options) {
    if ((await option.textContent())?.includes('Wang Lei')) {
      operatorValue = await option.getAttribute('value');
      break;
    }
  }
  expect(operatorValue).toBeTruthy();
  await picker.selectOption(operatorValue!);
  // Dated today on purpose: undated work is real work, but it is not what the
  // home banner counts, and this test is about the banner.
  await page.getByTestId('task-due').fill(new Date().toISOString().slice(0, 10));
  // Wait for the ✅ the action puts on the button — navigating before the
  // server action commits is how this suite has flaked twice before.
  await page.getByTestId('save-task').click();
  await expect(page.getByTestId('save-task')).toHaveText('✅');

  // …and lands on the one screen they do open, even though /bugun is not in
  // their menu. This is the assertion that makes the menu change safe.
  await login(page, YW_OPERATOR);
  await expect(page.getByTestId('home-tasks')).toBeVisible();
  await page.getByTestId('home-tasks').click();
  await expect(page).toHaveURL('/bugun');
  await expect(page.getByText(title)).toBeVisible();
});

test('the admin pages that had no gate now have one', async ({ page }) => {
  await login(page, YW_OPERATOR);
  // Each of these rendered a working form for anyone who typed the URL.
  for (const url of [
    '/admin/users/new',
    '/admin/warehouses/new',
    '/admin/clients/new',
    '/admin/settings',
  ]) {
    await page.goto(url);
    await expect(page).toHaveURL('/');
  }
});

test('the client book opens for everyone the menu offers it to', async ({ page }) => {
  // The logist holds `clients.manage`: he creates clients, edits their cards
  // and mints their cabinet links. The page asked for the WAREHOUSE admin
  // right instead, so the menu showed him «Mijozlar» and the page bounced him
  // straight home — a dead entry in a working menu.
  await login(page, LOGIST);
  await expect(page.locator('main a[href="/admin/clients"]').first()).toBeVisible();
  await page.goto('/admin/clients');
  await expect(page).toHaveURL('/admin/clients');
  await expect(page.getByTestId('clients-xlsx')).toBeVisible();

  // …and the warehouse operator, who holds neither, still cannot.
  await login(page, YW_OPERATOR);
  await page.goto('/admin/clients');
  await expect(page).toHaveURL('/');
});

test('a warehouse card obeys the same scope as the warehouse list', async ({ page }) => {
  // The YW operator's own receipt — reachable, and its id is a real one.
  await login(page, YW_OPERATOR);
  await page.goto('/receipts');
  const link = page.locator('a[href^="/receipts/"]').first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  await page.goto(href!);
  await expect(page).toHaveURL(href!);

  // The same url, pasted to a colleague in Guangzhou: the list would never
  // have shown it to them, and now the card will not either.
  await login(page, GZ_OPERATOR);
  const response = await page.goto(href!);
  expect(response?.status()).toBe(404);
});
