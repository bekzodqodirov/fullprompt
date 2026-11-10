import { expect, test } from '@playwright/test';
import { openFold } from './fold';
import { createQuickBatch } from './quick-batch';

/**
 * Getting a batch off the board.
 *
 * The owner's problem: "dev payitida productionga partiyalar planlar yaratib
 * qo'ygandim … endi shularni o'chira olmayabman." Test batches sat next to
 * real trucks with no way to retire them, because `cancelled` — a status the
 * schema, the board and the tracking service have all understood since M3 —
 * had no action that could reach it.
 *
 * Runs LAST on purpose. It creates a batch and cancels it, and a cancelled
 * batch lands in the archive drawer; file names carry the run order (#154), so
 * a spec that leaves anything behind belongs after the ones that count what is
 * on the board.
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

test('the quick batch asks first, and «Bekor» posts nothing', async ({ page }) => {
  // His 6a (docs/NARX-VA-RAQAM.md §3.2.9): one line of confirm before a
  // number is minted. The question is IN the page — a native dialog would be
  // dismissed by Playwright and eat the cancel's own `page.once` below.
  await login(page, OWNER);
  await page.goto('/batches');
  const trucksOnBoard = page.getByTestId('batch-board').locator('a[href^="/batches/"]');
  const before = await trucksOnBoard.count();
  const confirm = page.getByTestId('quick-batch-confirm');
  await expect(async () => {
    if (!(await confirm.isVisible())) await page.getByTestId('create-quick-batch').click();
    await expect(confirm).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  // It names what the form will post, in words.
  await expect(confirm).toContainText('→');
  const origin = await confirm.getAttribute('data-origin');
  const dest = await confirm.getAttribute('data-dest');
  expect(origin).toBeTruthy();
  expect(dest).toBeTruthy();
  expect(origin).not.toBe(dest);
  // «Bekor» closes the question and nothing is created: still on the board.
  await page.getByTestId('quick-batch-no').click();
  await expect(confirm).toHaveCount(0);
  await expect(page).toHaveURL(/\/batches$/);
  await expect(page.getByTestId('create-quick-batch')).toBeVisible();
  await page.reload();
  await expect(trucksOnBoard).toHaveCount(before);
});

test('a batch created by mistake is cancelled, leaves the board and gives its number back', async ({ page }) => {
  await login(page, OWNER);
  await createQuickBatch(page);
  const path = new URL(page.url()).pathname;
  const code = (await page.locator('h1').first().innerText()).trim();

  await page.getByTestId('cancel-batch').click();
  // A reason is required — the button stays dead until there is one, the same
  // rule the service enforces.
  const confirm = page.getByTestId('cancel-batch-confirm');
  await expect(confirm).toBeDisabled();
  await page.locator('#cancel-reason').fill('test partiya');
  page.once('dialog', (d) => void d.accept());
  await confirm.click();

  // Waited for HERE rather than by navigating: the server action is still in
  // flight when the click returns, and a `goto` on top of it cancels the
  // request — the test would then be asserting on a batch nobody cancelled.
  // Once it lands, the card stops offering the controls of a live batch.
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('depart-batch')).toHaveCount(0);
  await page.goto(path);
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0);

  // His 4a: the truck was the counter's top and never left, so its number
  // came back — said on the card, durably (the dialog that heard the answer
  // is gone with the refresh), and the truck now wears «… (bekor)».
  const state = page.getByTestId('batch-number-state');
  await expect(state).toHaveAttribute('data-state', 'returned');
  await expect(state).toContainText(code);
  await expect(page.locator('h1').first()).toContainText(`${code} (bekor`);

  // And it is off the working board: findable in the archive, not in the way.
  // By the truck's OWN link — a released number comes back, so a retry or a
  // second run on this database mints «code» again and cancels it as
  // «code (bekor 2)», and a count over the code as a substring would find both.
  await page.goto('/batches');
  const board = page.getByTestId('batch-board');
  await expect(board).toBeAttached();
  await expect(board.locator(`a[href="${path}"]`)).toHaveCount(0);
  await page.goto(`/batches?archive=1&q=${encodeURIComponent(code)}`);
  await expect(page.locator(`[data-testid="batch-archive-row"][href="${path}"]`)).toHaveCount(1);
});

test('a truck that has not left takes another receiving warehouse — the same truck, the same number', async ({ page }) => {
  // His 6a (docs/NARX-VA-RAQAM.md §2.4): a mis-picked destination is fixed in
  // place instead of a cancel and a new number.
  await login(page, OWNER);
  const path = new URL(await createQuickBatch(page, { origin: 'YW', dest: 'TAS1' })).pathname;
  const code = (await page.locator('h1').first().innerText()).trim();
  await expect(page.getByTestId('batch-head')).toContainText('YW → TAS1');

  await page.goto(`${path}/mashina`);
  await openFold(page.getByTestId('batch-dest-change-panel').locator('xpath=..'));
  const select = page.getByTestId('dest-change-target');
  const tas2 = await select.locator('option', { hasText: /^TAS2 · / }).getAttribute('value');
  expect(tas2).toBeTruthy();
  // A pick that lands while the form is hydrating is taken back — pick until
  // the button wakes (fold.ts's lesson).
  await expect(async () => {
    await select.selectOption(tas2!);
    await expect(page.getByTestId('dest-change-submit')).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('dest-change-submit').click();
  await expect(page.getByTestId('dest-change-done')).toContainText('TAS2', { timeout: 15_000 });

  await page.goto(path);
  await expect(page.getByTestId('batch-head')).toContainText('YW → TAS2');
  await expect(page.locator('h1').first()).toHaveText(code);

  // Cleanup — the truck was the top of YW, so its number comes back too.
  await page.getByTestId('cancel-batch').click();
  await page.locator('#cancel-reason').fill('yo‘nalish sinov');
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('cancel-batch-confirm').click();
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('batch-number-state')).toHaveAttribute('data-state', 'returned');
});

test('a warehouse operator is not offered the way out', async ({ page }) => {
  // Departure the loader may do — he is the one standing at the truck. Giving
  // the cargo back and retiring the trip is a manager's call.
  await login(page, OWNER);
  // Out of the operator's own warehouse, so the batch is one he really works
  // on — a card he could not open at all would prove nothing about the button.
  const url = await createQuickBatch(page, { origin: 'YW', dest: 'TAS1' });
  await expect(page.getByTestId('cancel-batch')).toBeVisible();

  // Same batch, same screen, different person.
  await login(page, OPERATOR);
  await page.goto(url);
  // He can still do his job on it — finish loading is right there.
  await expect(page.getByTestId('finish-loading')).toBeVisible();
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0);
});
