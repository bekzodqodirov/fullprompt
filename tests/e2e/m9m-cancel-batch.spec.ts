import { expect, test } from '@playwright/test';

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

test('a batch created by mistake is cancelled and leaves the board', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/batches');
  await page.getByTestId('create-quick-batch').click();
  // The quick batch opens its own card.
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
  const url = page.url();
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
  await page.goto(url);
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0);

  // And it is off the working board: findable in the archive, not in the way.
  await page.goto('/batches');
  const board = page.locator('.grid').first();
  await expect(board).not.toContainText(code);
});

test('a warehouse operator is not offered the way out', async ({ page }) => {
  // Departure the loader may do — he is the one standing at the truck. Giving
  // the cargo back and retiring the trip is a manager's call.
  await login(page, OWNER);
  await page.goto('/batches');
  // Out of the operator's own warehouse, so the batch is one he really works
  // on — a card he could not open at all would prove nothing about the button.
  await page.selectOption('select[name="originId"]', { label: 'YW' });
  await page.selectOption('select[name="destId"]', { label: 'TAS1' });
  await page.getByTestId('create-quick-batch').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
  const url = page.url();
  await expect(page.getByTestId('cancel-batch')).toBeVisible();

  // Same batch, same screen, different person.
  await login(page, OPERATOR);
  await page.goto(url);
  // He can still do his job on it — finish loading is right there.
  await expect(page.getByTestId('finish-loading')).toBeVisible();
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0);
});
