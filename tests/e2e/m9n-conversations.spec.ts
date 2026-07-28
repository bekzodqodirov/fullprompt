import { expect, test } from '@playwright/test';

/**
 * The conversations screen — phase 2 of the client chat in the CRM.
 *
 * Runs after everything else and creates NOTHING: it reads whatever the
 * integration suite left in `tg_messages` earlier in the same CI run, so it
 * cannot change what any other spec renders (#154, #183).
 *
 * What only an e2e can prove: that the screen is reachable, that a row leads
 * to its thread, and — the part that matters — that reading what a client
 * told us in confidence is behind a permission.
 */

const OWNER = '+998900000001';
const OPERATOR = '+998900000006';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('the conversation list opens and leads into a thread', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar');
  await expect(page).toHaveURL(/\/suhbatlar$/);

  const rows = page.getByTestId('conversation-row');
  // The integration suite writes conversations earlier in the same run. If it
  // ever stops, this asserts the empty state instead of quietly passing on an
  // empty page — a screen that shows nothing must say so.
  if ((await rows.count()) === 0) {
    await expect(page.getByTestId('conversations-empty')).toBeVisible();
    return;
  }

  await rows.first().click();
  await expect(page).toHaveURL(/\/suhbatlar\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('conversation-thread')).toBeVisible();
  // Read-only in this phase, and the screen must not pretend otherwise.
  await expect(page.locator('textarea')).toHaveCount(0);
});

/**
 * Phase 3's one piece of screen. It renders only when a manager has actually
 * logged in, which on a CI database nobody has — so what is worth pinning here
 * is the ABSENCE: a feature nobody has set up must not put a permanent grey
 * box on a screen that is read every morning (#183's spirit).
 *
 * That the banner says the right thing when a bridge IS configured is proved
 * in `telegram-live.integration.test.ts`, against a real row, where the state
 * can be driven through all five of its values.
 */
test('no bridge banner before anybody has connected an account', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar');
  await expect(page.getByTestId('tg-bridge')).toHaveCount(0);
});

test('search narrows the list, and a miss says so', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar?q=zzz-no-such-client-zzz');
  await expect(page.getByTestId('conversations-empty')).toBeVisible();
  await expect(page.getByTestId('conversation-row')).toHaveCount(0);
});

test('a warehouse operator cannot read what clients told sales', async ({ page }) => {
  // Not clutter-hiding — a real gate. These are conversations customers had in
  // confidence with their manager, and the page carries its own check rather
  // than trusting the menu to keep anybody out (#198).
  await login(page, OPERATOR);
  await page.goto('/suhbatlar');
  await expect(page).toHaveURL('/');
});

/**
 * The trade-off the owner asked about, made explicit.
 *
 * He wanted the chat on the deal card too. A deal card is open to the VED
 * manager as well as sales (`DEAL_WRITE_PERMISSIONS` = crm.leads · ved.docs ·
 * clients.manage), so putting an ungated panel there would have quietly handed
 * the customs manager every private sales conversation in the company.
 *
 * The panel gates itself, which means the same card shows different things to
 * different people — deliberately. That is the behaviour worth pinning, in the
 * one place it can actually be observed.
 */
const VED = '+998900000004';
const SALES = '+998900000009';

test('a deal card shows the conversation to sales and hides it from VED', async ({ page }) => {
  await login(page, OWNER);
  // `?scope=all`: the board opens on MINE, and the deal the earlier spec left
  // belongs to somebody else — without this the board is empty and the test
  // skips itself, which is worse than failing because it looks like coverage.
  await page.goto('/bitimlar?scope=all');
  // The board's own card, not any link starting with /bitimlar — that also
  // matches the "new deal" button, which goes somewhere else entirely.
  const deal = page.getByTestId('deal-card').first();
  await expect(deal).toBeVisible();
  await deal.click();
  await expect(page).toHaveURL(/\/bitimlar\/[0-9a-f-]{36}$/);
  const url = page.url();
  // Whether THIS deal's client has an imported conversation depends on the
  // run, so the owner's view is the reference: whatever he sees, VED must not.
  const ownerSees = await page.getByTestId('tg-thread').count();

  await login(page, VED);
  await page.goto(url);
  await expect(page.getByRole('heading').first()).toBeVisible();
  // He still does his job on the card — the customs papers are his.
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId('tg-thread')).toHaveCount(0);

  if (ownerSees > 0) {
    await login(page, SALES);
    await page.goto(url);
    // Sales may be scoped out of another manager's deal; only assert the
    // panel when the card itself opened.
    if (page.url() === url) await expect(page.getByTestId('tg-thread')).toHaveCount(ownerSees);
  }
});
