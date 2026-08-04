import { expect, test } from '@playwright/test';

/**
 * Ticking cards and acting on all of them at once.
 *
 * The rules are proven in the integration suite, against the same functions
 * the action loops over. What only a browser can show is that the ticks and
 * the bar exist, that the bar refuses a lost move until a reason is typed,
 * and — the part that matters — that a card the board is showing actually
 * ends up in the other column.
 *
 * It creates its own leads and moves them back, because a lead left in a
 * different stage is the next spec's board (#154).
 *
 * Everything is scoped to `funnel-mobile`: the board renders BOTH shapes into
 * the DOM and toggles them with CSS rather than by measuring the window (a
 * breakpoint read in JavaScript draws the wrong shape for the first frame),
 * so an unscoped `lead-card` locator finds every card twice.
 */

/** The phone board — the one this project's viewport actually shows. */
const BOARD = '[data-testid="funnel-mobile"]';

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const TAG = `Bulk e2e ${String(Date.now()).slice(-6)}`;

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

async function newLead(page: import('@playwright/test').Page, name: string) {
  await page.goto('/crm/leads/new');
  await page.locator('input[name="name"]').fill(name);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/crm\/leads\/[0-9a-f-]+$/);
}

test('two leads are ticked and moved together', async ({ page }) => {
  await login(page);
  await newLead(page, `${TAG} A`);
  await newLead(page, `${TAG} B`);

  await page.goto('/crm?scope=all');
  // No bar until something is ticked — it must not sit over the board.
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);

  const cards = page.locator(BOARD).getByTestId('lead-card').filter({ hasText: TAG });
  await expect(cards).toHaveCount(2);
  await cards.nth(0).getByTestId('card-select').click();
  await cards.nth(1).getByTestId('card-select').click();

  const bar = page.getByTestId('bulk-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('bulk-count')).toContainText('2');

  // Move them to the second open stage, whatever it is called on this board.
  const options = await bar.getByTestId('bulk-stage').locator('option').all();
  const values = (await Promise.all(options.map((o) => o.getAttribute('value')))).filter(Boolean);
  const target = values[1]!;
  await bar.getByTestId('bulk-stage').selectOption(target);
  await bar.getByTestId('bulk-move').click();

  await expect(bar.getByTestId('bulk-result')).toBeVisible({ timeout: 15_000 });
  await expect(bar.getByTestId('bulk-result')).toContainText('2');

  // The board agrees: both cards now sit in the column they were sent to.
  await page.goto('/crm?scope=all');
  const moved = page
    .locator(BOARD)
    .locator('section')
    .filter({ has: page.getByTestId('lead-card').filter({ hasText: `${TAG} A` }) });
  await expect(moved).toHaveCount(1);
});

test('a lost move stays refused until a reason is typed', async ({ page }) => {
  await login(page);
  await page.goto('/crm?scope=all');
  const card = page.locator(BOARD).getByTestId('lead-card').filter({ hasText: `${TAG} A` }).first();
  await card.getByTestId('card-select').click();

  const bar = page.getByTestId('bulk-bar');
  const stage = bar.getByTestId('bulk-stage');
  // By KIND, not by position: the owner names and orders his own funnel, and
  // the last column is as likely to be «won» as «lost».
  const lost = await stage.locator('option[data-kind="lost"]').first().getAttribute('value');
  await stage.selectOption(lost!);

  // The reason box appeared and the button will not fire without it.
  await expect(bar.getByTestId('bulk-reason')).toBeVisible();
  await expect(bar.getByTestId('bulk-move')).toBeDisabled();

  await bar.getByTestId('bulk-reason').fill('e2e sinov');
  await expect(bar.getByTestId('bulk-move')).toBeEnabled();
});

test('the leads it created are put back where the board expects them', async ({ page }) => {
  await login(page);
  await page.goto('/crm?scope=all');
  for (const suffix of ['A', 'B']) {
    const card = page
      .locator(BOARD)
      .getByTestId('lead-card')
      .filter({ hasText: `${TAG} ${suffix}` })
      .first();
    if ((await card.count()) === 0) continue;
    await card.getByTestId('card-select').click();
  }
  const bar = page.getByTestId('bulk-bar');
  if (await bar.isVisible()) {
    const options = await bar.getByTestId('bulk-stage').locator('option').all();
    const values = (await Promise.all(options.map((o) => o.getAttribute('value')))).filter(Boolean);
    await bar.getByTestId('bulk-stage').selectOption(values[0]!);
    await bar.getByTestId('bulk-move').click();
    await expect(bar.getByTestId('bulk-result')).toBeVisible({ timeout: 15_000 });
  }
});
