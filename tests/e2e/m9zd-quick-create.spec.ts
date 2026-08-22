import { expect, test } from '@playwright/test';

/**
 * «+» — a lead in two boxes, from wherever you are.
 *
 * What only a browser can show: the button opens a panel over the page
 * instead of leaving it, the save stays put, and the confirmation names what
 * was made. The defaults underneath (first stage, owner = you) are proven in
 * the integration suite.
 *
 * It loses the lead it creates at the end. A lead is never deleted here — «a
 * finished lead leaves the board, never the database» — so losing it with a
 * reason is the honest cleanup and keeps it off every later spec's funnel.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const NAME = `Tez lid ${String(Date.now()).slice(-6)}`;
const BOARD = '[data-testid="funnel-mobile"]';

test.beforeEach(async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
});

test('a lead is added from the app bar without leaving the page', async ({ page }) => {
  await page.goto('/stock');
  await page.getByTestId('quick-create').click();
  await expect(page.getByTestId('quick-panel')).toBeVisible();
  // It opened OVER the page — the whole point of the button.
  await expect(page).toHaveURL('/stock');

  // The owner may create both kinds, so a kind is chosen first.
  await page.getByTestId('quick-kind-lead').click();
  await expect(page.getByTestId('quick-save')).toBeDisabled();

  await page.getByTestId('quick-name').fill(NAME);
  await page.getByTestId('quick-phone').fill('+998901234567');
  await expect(page.getByTestId('quick-save')).toBeEnabled();
  await page.getByTestId('quick-save').click();

  // Still on /stock, with the new lead named back at us.
  await expect(page.getByTestId('quick-panel')).toHaveCount(0);
  await expect(page).toHaveURL('/stock');
  await expect(page.getByTestId('quick-made')).toContainText(NAME, { timeout: 15_000 });
});

test('the lead it made is really on the funnel', async ({ page }) => {
  await page.goto('/crm?scope=all');
  await expect(
    page.locator(BOARD).getByTestId('lead-card').filter({ hasText: NAME }),
  ).toHaveCount(1);
});

test('a half-typed name is not thrown away by a stray tap', async ({ page }) => {
  await page.goto('/stock');
  await page.getByTestId('quick-create').click();
  await page.getByTestId('quick-kind-lead').click();
  await page.getByTestId('quick-name').fill('yarim yozilgan');

  // Refuse the confirm: the panel and the words stay.
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.locator('[role="dialog"] > button').first().click();
  await expect(page.getByTestId('quick-panel')).toBeVisible();
  await expect(page.getByTestId('quick-name')).toHaveValue('yarim yozilgan');

  // Accept it, and it closes.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.locator('[role="dialog"] > button').first().click();
  await expect(page.getByTestId('quick-panel')).toHaveCount(0);
});

/**
 * The CLIENT path answers with the CODE, big and copyable (round 107, owner:
 * «yangi client ochganda qanday kod berilganini bilish imkoni yo'qku»). The
 * panel stays open on a banner instead of closing to a toast — the code goes
 * on cartons the same day, so it must be unmissable and one tap to copy.
 */
const CLIENT_NAME = `Tez mijoz ${String(Date.now()).slice(-6)}`;
let mintedCode = '';
let cardUrl = '';

test('a client is added and the minted code is shown big, with a copy button', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/stock');
  await page.getByTestId('quick-create').click();
  await page.getByTestId('quick-kind-client').click();
  await page.getByTestId('quick-name').fill(CLIENT_NAME);
  await page.getByTestId('quick-phone').fill('+998907654321');
  await page.getByTestId('quick-save').click();

  // The panel did NOT close — it answers with the code.
  await expect(page.getByTestId('quick-client-made')).toBeVisible({ timeout: 15_000 });
  const code = (await page.getByTestId('quick-client-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{2,10}$/);
  mintedCode = code;

  // One tap = on the clipboard, and the button says so.
  await page.getByTestId('quick-copy-code').click();
  await expect(page.getByTestId('quick-copy-code')).toContainText('✓');
  const onClipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(onClipboard).toBe(code);

  // The card link carries the person to the same code, where the copy chip
  // lives for every later visit.
  await page.getByTestId('quick-to-card').click();
  await expect(page.locator('h1')).toContainText(code);
  await expect(page.getByTestId('copy-chip')).toBeVisible();
  cardUrl = page.url();
});

test('the client it created is deactivated (cleanup as a test)', async ({ page }) => {
  // Reach the card by the URL captured at creation, never through a list an
  // earlier spec may have reshaped (m9ze's rule) — and assert it was captured,
  // or a failed create would make this pass by doing nothing.
  expect(mintedCode, 'the create test must have minted a code').not.toBe('');
  await page.goto(cardUrl);
  await expect(page.locator('h1')).toContainText(mintedCode);
  // The header's toggle: btn-danger while the client is active.
  await page.locator('button.btn-danger').first().click();
  await expect(page.locator('button.btn-primary').first()).toBeVisible();
});

test('the lead it created is closed, so it leaves the board', async ({ page }) => {
  await page.goto('/crm?scope=all');
  const card = page.locator(BOARD).getByTestId('lead-card').filter({ hasText: NAME }).first();
  if ((await card.count()) === 0) return;
  await card.getByTestId('card-select').click();

  const bar = page.getByTestId('bulk-bar');
  const lost = await bar
    .getByTestId('bulk-stage')
    .locator('option[data-kind="lost"]')
    .first()
    .getAttribute('value');
  await bar.getByTestId('bulk-stage').selectOption(lost!);
  await bar.getByTestId('bulk-reason').fill('e2e tozalash');
  await bar.getByTestId('bulk-move').click();
  await expect(bar.getByTestId('bulk-result')).toContainText('1', { timeout: 15_000 });
});
