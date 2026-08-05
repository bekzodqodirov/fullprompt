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

test('the door to «which chats to keep» is there with nothing pending', async ({ page }) => {
  // It used to appear only while a chat was waiting for a decision, so the
  // moment the owner answered the last one, the screen holding every decided
  // chat — and the buttons that take one back out or delete what was stored
  // from it — became unreachable. Nothing links to it from any menu.
  await login(page, OWNER);
  await page.goto('/suhbatlar');
  const link = page.getByTestId('which-chats-link');
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/suhbatlar\/qaysi$/);
  // And the decided list is reachable from there, which is where the undo and
  // the purge live.
  await page.getByTestId('show-decided').click();
  await expect(page).toHaveURL(/show=done$/);
});

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

/**
 * Phase 4's compose box, and the thing that matters more than the box: when a
 * reply CANNOT go, the screen says why.
 *
 * Nothing is configured in CI — no stored Telegram account, sending switched
 * off — so what is asserted here is the honest refusal. A screen that simply
 * omitted the box would leave a manager asking "why can't I type", and the
 * answer they reach for is restarting a server.
 */
test('a thread with no bridge says why it cannot be replied to', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/suhbatlar');
  const rows = page.getByTestId('conversation-row');
  if ((await rows.count()) === 0) return;
  await rows.first().click();
  await expect(page.getByTestId('conversation-thread')).toBeVisible();
  // Not a disabled box, and not silence: a sentence.
  await expect(page.getByTestId('reply-blocked')).toBeVisible();
  await expect(page.getByTestId('reply-box')).toHaveCount(0);
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

test('a deal card shows the TIMELINE to sales and hides it from VED', async ({ page }) => {
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
  // The timeline replaced the read-only chat panel here. It is asserted on
  // `client-feed`, and that matters: this spec kept passing after the swap
  // while asserting on a testid the page no longer renders — both counts were
  // zero and the gate was proved by nothing at all.
  //
  // The owner's view is the reference, because whether THIS deal's client has
  // anything on their timeline depends on what earlier specs left. What must
  // hold is the RELATION: whatever he can see, VED cannot.
  const ownerSees = await page.getByTestId('client-feed').count();
  // And the timeline is not conditional on a conversation existing — a client
  // with cargo has one — so on a seeded deal it must actually be there.
  expect(ownerSees, 'the owner must see a timeline on a deal card').toBeGreaterThan(0);

  await login(page, VED);
  await page.goto(url);
  await expect(page.getByRole('heading').first()).toBeVisible();
  // He still does his job on the card — the customs papers are his.
  await expect(page).toHaveURL(url);
  // A deal card is open to `ved.docs`, so an ungated timeline here would hand
  // the customs manager every private sales conversation AND every note.
  await expect(page.getByTestId('client-feed')).toHaveCount(0);

  await login(page, SALES);
  await page.goto(url);
  // Sales may be scoped out of another manager's deal; only assert the panel
  // when the card itself opened.
  if (page.url() === url) {
    await expect(page.getByTestId('client-feed')).toHaveCount(ownerSees);
  }
});

/**
 * «Qaysi chatlar» — the owner's ask that a person, not only the phone match,
 * decides what goes into the CRM.
 *
 * The decision flow itself runs against real rows in
 * `chat-rules.integration.test.ts`; filling this screen needs a Telegram scan,
 * which no test can perform. What only an e2e can prove is the ACCESS, and
 * that is the part worth pinning here, because this screen is gated TIGHTER
 * than the conversations it belongs to: reading a client's thread is a sales
 * job, deciding what the company starts keeping about a person is not.
 *
 * It also creates nothing, so it stays movable in the run order (#154, #183).
 */
const LOGIST = '+998900000003';

test('a sales manager may read conversations but not decide which are kept', async ({ page }) => {
  await login(page, SALES);
  // He is allowed in here — this is his job.
  await page.goto('/suhbatlar');
  await expect(page).toHaveURL(/\/suhbatlar$/);
  // And not here: `crm.leads` without `clients.manage`.
  await page.goto('/suhbatlar/qaysi');
  await expect(page).toHaveURL('/');
});

test('a warehouse operator reaches neither', async ({ page }) => {
  await login(page, OPERATOR);
  await page.goto('/suhbatlar/qaysi');
  await expect(page).toHaveURL('/');
});

test('somebody who may decide gets the screen, and it says when there is nothing', async ({
  page,
}) => {
  await login(page, LOGIST);
  await page.goto('/suhbatlar/qaysi');
  await expect(page).toHaveURL(/\/suhbatlar\/qaysi$/);
  // Nothing has been scanned in CI, so the screen must SAY so rather than
  // render an empty page that looks broken.
  await expect(page.getByTestId('which-chats-empty')).toBeVisible();
  // The DOOR stays — it also leads to every chat already decided, and to the
  // buttons that take one back out or delete what was stored from it. What
  // must not appear with nothing pending is the BADGE: the link is a place,
  // the badge is a claim that there is work waiting.
  await page.goto('/suhbatlar');
  await expect(page.getByTestId('which-chats-link')).toBeVisible();
  await expect(page.getByTestId('which-chats-badge')).toHaveCount(0);
});
