import { expect, test } from '@playwright/test';

/**
 * Correcting a deal and a client where you are reading them.
 *
 * The rules are proven in the integration suite. What only a browser shows is
 * the hazard round 61 found and this round inherits twice over: both cards
 * carry a ✏️ form holding the SAME columns, with uncontrolled inputs, so
 * without remounting it after an inline save, pressing Save there would put
 * the old value back on a live record.
 *
 * It edits an EXISTING seeded client rather than making one — a client code is
 * a lifetime sequence, and a spec that mints one moves the owner's counter.
 * Which means it must put both records back: what a spec leaves behind is the
 * next spec's input (#154), and a cleanup that is not a TEST is a cleanup
 * nobody watches (round 57).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const NOTE = `e2e ${String(Date.now()).slice(-6)}`;

let clientUrl = '';
let dealUrl = '';
let originalNote = '';
let originalTitle = '';

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('a client note is correctable on the card, and the form below keeps it', async ({ page }) => {
  await login(page);
  await page.goto('/admin/clients');
  await page.getByTestId('clients-table').locator('a[href^="/admin/clients/"]').first().click();
  await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]+$/);
  clientUrl = new URL(page.url()).pathname;

  const facts = page.getByTestId('client-facts');
  await expect(facts).toBeVisible();

  await facts.getByTestId('fact-client-notes-open').click();
  originalNote = await facts.getByTestId('fact-client-notes-input').inputValue();
  await facts.getByTestId('fact-client-notes-input').fill(NOTE);
  await facts.getByTestId('fact-client-notes-save').click();
  await expect(facts.getByTestId('fact-client-notes')).toContainText(NOTE, { timeout: 15_000 });

  // The ✏️ form holds `notes` too. Save it untouched: the inline value stands.
  const form = page.locator('form').filter({ has: page.locator('textarea[name="notes"]') }).first();
  await expect(form.locator('textarea[name="notes"]')).toHaveValue(NOTE);
  await form.locator('button[type="submit"]').first().click();
  await page.reload();
  await expect(page.getByTestId('client-facts').getByTestId('fact-client-notes')).toContainText(NOTE);
});

test('the sales manager is a picker, and «nobody» is a real answer', async ({ page }) => {
  expect(clientUrl, 'the first test captures the client URL').not.toBe('');
  await login(page);
  await page.goto(clientUrl);

  const field = page.getByTestId('fact-client-manager');
  await field.getByTestId('fact-client-manager-open').click();
  const picker = field.getByTestId('fact-client-manager-input');
  await expect(picker).toBeVisible();
  // The empty option exists: a client can sit unassigned, and a picker with no
  // way back to that would make the first pick permanent.
  await expect(picker.locator('option[value=""]')).toHaveCount(1);
  await field.getByTestId('fact-client-manager-cancel').click();
});

test('a deal title is correctable, and the quote is not offered at all', async ({ page }) => {
  await login(page);
  await page.goto('/bitimlar');
  const card = page.locator('[data-testid="funnel-mobile"]').getByTestId('deal-card').first();
  if ((await card.count()) === 0) test.skip(true, 'no deal on the board to read');
  await card.click();
  await expect(page).toHaveURL(/\/bitimlar\/[0-9a-f-]+$/);

  const facts = page.getByTestId('deal-facts');
  await expect(facts).toBeVisible();
  // Two facts and no more: the amount, the sizes and the currency carry the
  // name of whoever quoted them, and only the form that stamps it may write.
  await expect(facts.getByTestId('fact-deal-title')).toBeVisible();
  await expect(facts.getByTestId('fact-deal-note')).toBeVisible();
  await expect(facts.locator('[data-testid^="fact-deal-quoted"]')).toHaveCount(0);

  dealUrl = new URL(page.url()).pathname;
  const title = `e2e ${String(Date.now()).slice(-5)}`;
  await facts.getByTestId('fact-deal-title-open').click();
  originalTitle = await facts.getByTestId('fact-deal-title-input').inputValue();
  await facts.getByTestId('fact-deal-title-input').fill(title);
  await facts.getByTestId('fact-deal-title-save').click();
  await expect(facts.getByTestId('fact-deal-title')).toContainText(title, { timeout: 15_000 });

  // Same hazard, same proof: the ✏️ form below holds `title`.
  await page.getByTestId('deal-edit-panel').click();
  const form = page.locator('form').filter({ has: page.locator('input[name="title"]') }).first();
  await expect(form.locator('input[name="title"]')).toHaveValue(title);
});

// Cleanup as a TEST, not an afterAll: `browser.newPage()` there has neither
// baseURL nor login, so the cleanup silently does nothing and the next spec
// inherits the edit (round 57 shipped exactly that lie).
test('the client note is restored', async ({ page }) => {
  expect(clientUrl, 'the first test captures the client URL').not.toBe('');
  await login(page);
  await page.goto(clientUrl);
  const facts = page.getByTestId('client-facts');
  await facts.getByTestId('fact-client-notes-open').click();
  await facts.getByTestId('fact-client-notes-input').fill(originalNote);
  // Empty is a real note for most seeded clients, and the save button appears
  // for it just the same — what it needs is a DIFFERENCE, which there is.
  await facts.getByTestId('fact-client-notes-save').click();
  await expect(facts.getByTestId('fact-client-notes-input')).toHaveCount(0, { timeout: 15_000 });
});

test('the deal title is restored', async ({ page }) => {
  test.skip(dealUrl === '', 'no deal was edited');
  await login(page);
  await page.goto(dealUrl);
  const facts = page.getByTestId('deal-facts');
  await facts.getByTestId('fact-deal-title-open').click();
  await facts.getByTestId('fact-deal-title-input').fill(originalTitle);
  await facts.getByTestId('fact-deal-title-save').click();
  await expect(facts.getByTestId('fact-deal-title-input')).toHaveCount(0, { timeout: 15_000 });
});
