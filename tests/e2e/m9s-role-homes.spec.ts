import { expect, test } from '@playwright/test';

/**
 * The other three role homes (owner: "har bir hodim qiladigan ishiga qarab
 * layout tuz" — round 11 built the skladchi's, this round the rest). Same
 * discipline as m9o: testids and digits only, so the spec is honest in all
 * four languages; any number that is moved is moved BACK, because the next
 * spec inherits this database (#154).
 */

const LOGIST = '+998900000003';
const SALES = '+998900000009';
const ACCOUNTANT = '+998900000010';
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
async function countOf(page: import('@playwright/test').Page, testid: string): Promise<number> {
  await page.goto('/');
  await expect(page.getByTestId(testid)).toBeVisible();
  const badge = page.getByTestId(`${testid}-count`);
  if ((await badge.count()) === 0) return 0;
  return Number((await badge.innerText()).trim());
}

test('the logist wakes up to the verdict queue, with live numbers', async ({ page }) => {
  await login(page, LOGIST);

  await expect(page.getByTestId('logist-flow-hero')).toBeVisible();
  await expect(page.getByTestId('logist-flow-batches')).toBeVisible();
  await expect(page.getByTestId('logist-flow-arrivals')).toBeVisible();
  await expect(page.getByTestId('logist-flow-transit')).toBeVisible();
  await expect(page.getByTestId('logist-flow-costs')).toBeVisible();
  // Not the warehouse home, and not anybody else's.
  await expect(page.getByTestId('flow-receive')).toHaveCount(0);
  await expect(page.getByTestId('sales-flow-hero')).toHaveCount(0);

  // A promise recorded moves the logist's arrivals number — company-wide,
  // because a logist is unscoped on purpose.
  const before = await countOf(page, 'logist-flow-arrivals');
  await page.goto('/arrivals');
  const add = page.locator('details').filter({ has: page.getByTestId('save-arrival') });
  await add.locator('summary').click();
  await page.getByTestId('arrival-client').fill('GS777');
  await page.getByRole('button', { name: /GS777/ }).first().click();
  await page.locator('input[name="note"]').fill(`Rol sinov ${runId}`);
  await page.getByTestId('save-arrival').click();
  await expect(add.getByText('✅')).toBeVisible({ timeout: 15_000 });

  expect(await countOf(page, 'logist-flow-arrivals')).toBe(before + 1);

  // …and the cancel is the cleanup (#154).
  await page.goto('/arrivals');
  const row = page.getByTestId('expected-row').filter({ hasText: `Rol sinov ${runId}` });
  await row.locator('input[name="reason"]').fill('sinov tugadi');
  await row.locator('button[title]').last().click();
  await expect(
    page.getByTestId('expected-row').filter({ hasText: `Rol sinov ${runId}` }),
  ).toHaveCount(0);
  expect(await countOf(page, 'logist-flow-arrivals')).toBe(before);
});

test('the sales manager wakes up to the call list', async ({ page }) => {
  await login(page, SALES);

  await expect(page.getByTestId('sales-flow-hero')).toBeVisible();
  await expect(page.getByTestId('sales-flow-crm')).toBeVisible();
  await expect(page.getByTestId('sales-flow-chats')).toBeVisible();
  await expect(page.getByTestId('sales-flow-debtors')).toBeVisible();
  await expect(page.getByTestId('sales-flow-deals')).toBeVisible();
  await expect(page.getByTestId('logist-flow-hero')).toHaveCount(0);
  await expect(page.getByTestId('flow-receive')).toHaveCount(0);

  // The hero opens the morning screen itself.
  await page.getByTestId('sales-flow-hero').click();
  await expect(page).toHaveURL('/crm/today');
});

test('the accountant wakes up to the money', async ({ page }) => {
  await login(page, ACCOUNTANT);

  await expect(page.getByTestId('acc-flow-hero')).toBeVisible();
  await expect(page.getByTestId('acc-flow-receivables')).toBeVisible();
  await expect(page.getByTestId('acc-flow-unassigned')).toBeVisible();
  await expect(page.getByTestId('acc-flow-recurring')).toBeVisible();
  await expect(page.getByTestId('acc-flow-costs')).toBeVisible();
  await expect(page.getByTestId('sales-flow-hero')).toHaveCount(0);
  await expect(page.getByTestId('flow-receive')).toHaveCount(0);

  await page.getByTestId('acc-flow-hero').click();
  await expect(page).toHaveURL('/accounting');
});
