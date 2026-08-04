import { expect, test } from '@playwright/test';

/**
 * The skladchi's home screen is his work order, not a menu.
 *
 * Owner: "har bir hodim qiladigan ishiga qarab layout tuz" — a warehouse
 * operator opens the app and reads a sequence: receive, what is coming,
 * loading, handover — each step carrying the live number that says whether
 * it needs him NOW. The number is the point, so the spec proves the number
 * moves with the data instead of merely existing.
 *
 * Runs as Wang Lei, whose locale is zh-CN on purpose: everything asserted
 * here is a testid or a digit, which is what keeps the spec honest in all
 * four languages.
 */

const YW_OPERATOR = '+998900000006';
const OWNER = '+998900000001';
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

/** The badge is absent at zero — absence IS the number. */
async function batchCount(page: import('@playwright/test').Page): Promise<number> {
  await page.goto('/');
  await expect(page.getByTestId('flow-batches')).toBeVisible();
  const badge = page.getByTestId('flow-batches-count');
  if ((await badge.count()) === 0) return 0;
  return Number((await badge.innerText()).trim());
}

test('the warehouse day, in order, with live numbers', async ({ page }) => {
  await login(page, YW_OPERATOR);

  // The sequence: receive on top, then the steps of the day.
  await expect(page.getByTestId('flow-receive')).toBeVisible();
  await expect(page.getByTestId('flow-batches')).toBeVisible();
  await expect(page.getByTestId('flow-issue')).toBeVisible();

  // Round 47, the owner's item 9: «skladga kutilayotgan yuklar degan narsa
  // kerak emas — faqat kelishi kutilayotgan partiyani qo'shsang bo'lgani».
  // The promise row is gone from the warehouse screen entirely, and so is the
  // menu entry behind it: a packer acts on trucks, not on somebody's plan.
  await expect(page.getByTestId('flow-arrivals')).toHaveCount(0);
  await expect(page.locator('nav a[href="/arrivals"]')).toHaveCount(0);

  // A truck forming AT his warehouse moves HIS number.
  const before = await batchCount(page);
  await login(page, OWNER);
  await page.goto('/batches');
  // The origin has to be HIS warehouse or his number would not move — the
  // quick form defaults to the first code alphabetically.
  await page.locator('select[name="originId"]').selectOption({ label: 'YW' });
  await page.locator('select[name="destId"]').selectOption({ label: 'TAS1' });
  await page.getByTestId('create-quick-batch').click();
  await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
  const batchUrl = page.url();

  await login(page, YW_OPERATOR);
  expect(await batchCount(page)).toBe(before + 1);

  // …and retiring it takes the number back down. This is also the cleanup:
  // the next spec inherits this database (#154).
  await login(page, OWNER);
  await page.goto(batchUrl);
  await page.getByTestId('cancel-batch').click();
  await page.locator('#cancel-reason').fill(`flow sinov ${runId}`);
  // The confirm is a real `window.confirm`, and Playwright DISMISSES dialogs
  // unless told otherwise — without this the cancel silently never happens
  // and the cleanup assertion is the only thing that notices (m9m's rule).
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('cancel-batch-confirm').click();
  await expect(page.getByTestId('cancel-batch')).toHaveCount(0, { timeout: 15_000 });

  await login(page, YW_OPERATOR);
  expect(await batchCount(page)).toBe(before);
});

test('everyone else keeps the tile home', async ({ page }) => {
  // The owner is not warehouse-scoped: his day is not the warehouse day, and
  // drawing him a skladchi screen would be the wrong kind of helpful.
  await login(page, OWNER);
  await expect(page.getByTestId('flow-receive')).toHaveCount(0);
  await expect(page.getByTestId('home-tasks').or(page.locator('main a[href="/bugun"]')).first()).toBeVisible();
});
