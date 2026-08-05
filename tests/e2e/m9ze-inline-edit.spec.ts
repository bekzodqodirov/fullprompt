import { expect, test } from '@playwright/test';

/**
 * Correcting a lead where you are reading it.
 *
 * The rules are proven in the integration suite. What only a browser can show
 * is the interaction — a fact that is text until you press it, a save button
 * that appears only once something differs — and the one thing that could
 * quietly destroy work: the ✏️ form below holds the SAME columns, its inputs
 * are uncontrolled, and without remounting it after an inline save, pressing
 * Save there would put the old value back.
 *
 * It loses the lead it creates at the end (a lead is never deleted here).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const NAME = `Inline e2e ${String(Date.now()).slice(-6)}`;
/**
 * The card's own URL, captured when it is created.
 *
 * Finding it again through the funnel was the first draft, and it is the
 * wrong door: the board is capped and every earlier spec adds leads to the
 * same first column, so «my card» is only reliably reachable by its address.
 */
let cardUrl = '';

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

/**
 * Open the card the first test made.
 *
 * The check is not ceremony: a failed test costs Playwright its worker, the
 * next test re-imports this file with `cardUrl` back to '', and `goto('')`
 * lands quietly on the HOME page — where every locator here times out after a
 * minute and blames the wrong thing.
 */
async function openCard(page: import('@playwright/test').Page) {
  expect(cardUrl, 'the first test captures the card URL').not.toBe('');
  await login(page);
  await page.goto(cardUrl);
}

test('the facts are readable without opening anything, and correctable in place', async ({
  page,
}) => {
  await login(page);
  await page.goto('/crm/leads/new');
  await page.locator('input[name="name"]').fill(NAME);
  await page.locator('input[name="phone"]').fill('+998900000000');
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/crm\/leads\/[0-9a-f-]+$/);
  cardUrl = new URL(page.url()).pathname;

  // The phone is on the card, in words — it used to live inside a folded form.
  const facts = page.getByTestId('lead-facts');
  await expect(facts).toBeVisible();
  await expect(facts.getByTestId('fact-phone')).toContainText('+998900000000');

  // Press it: it becomes a box, and no save button until something differs.
  await facts.getByTestId('fact-phone-open').click();
  await expect(facts.getByTestId('fact-phone-input')).toBeVisible();
  await expect(facts.getByTestId('fact-phone-save')).toHaveCount(0);

  await facts.getByTestId('fact-phone-input').fill('+998911112233');
  await expect(facts.getByTestId('fact-phone-save')).toBeVisible();
  await facts.getByTestId('fact-phone-save').click();

  await expect(facts.getByTestId('fact-phone')).toContainText('+998911112233', {
    timeout: 15_000,
  });
});

test('the ✏️ form below does not put the old value back', async ({ page }) => {
  await openCard(page);

  // Both writers touch `phone`. Open the form (which is rendered from the
  // server's current row) and save it untouched: the inline value must stand.
  await page.getByTestId('lead-edit-panel').click();
  const form = page.locator('form').filter({ has: page.locator('input[name="phone"]') }).first();
  await expect(form.locator('input[name="phone"]')).toHaveValue('+998911112233');

  await form.locator('button[type="submit"]').first().click();
  // The form must keep its own «saved» line. Round 61 keyed the WHOLE form on
  // the row's timestamp to fix the value hazard, which remounted it after
  // every save and threw this away — silently, because nothing asked.
  await expect(form.getByText('✅')).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await expect(page.getByTestId('lead-facts').getByTestId('fact-phone')).toContainText(
    '+998911112233',
  );
});

test('a sitting reads as one entry, with the rows one press away', async ({ page }) => {
  await openCard(page);

  // A second correction, minutes after the first: one person, one sitting.
  const facts = page.getByTestId('lead-facts');
  await facts.getByTestId('fact-company-open').click();
  await facts.getByTestId('fact-company-input').fill('Alfa MCHJ');
  await facts.getByTestId('fact-company-save').click();
  await expect(facts.getByTestId('fact-company')).toContainText('Alfa MCHJ', { timeout: 15_000 });

  await page.getByTestId('lead-history-panel').click();
  const entries = page.getByTestId('history-list').getByTestId('history-entry');
  // Two: the lead being opened, and the corrections merged into one. Three
  // would mean a card per corrected field — and the ✏️ form saved untouched in
  // the previous test would be a fourth if a no-op still wrote a row.
  await expect(entries).toHaveCount(2);
  const merged = entries.first();
  await expect(merged).toContainText('Alfa MCHJ');
  await expect(merged).toContainText('+998911112233');

  // Folded, never dropped: each row keeps its own time. By testid, because a
  // bare `ol li` also matches the change lines nested inside each row.
  await merged.locator('summary').click();
  await expect(merged.getByTestId('history-row')).toHaveCount(2);
});

test('a refused save keeps what was typed', async ({ page }) => {
  await openCard(page);

  const facts = page.getByTestId('lead-facts');
  await facts.getByTestId('fact-name-open').click();
  // A lead must have a name; emptying it is refused by the service.
  await facts.getByTestId('fact-name-input').fill('x');
  await facts.getByTestId('fact-name-save').click();

  await expect(facts.getByTestId('fact-name-error')).toBeVisible({ timeout: 15_000 });
  // Still open, still holding the typed value — the rule three rounds bought.
  await expect(facts.getByTestId('fact-name-input')).toHaveValue('x');
});

test('the lead it created is closed, so it leaves the board', async ({ page }) => {
  await login(page);
  await page.goto('/crm?scope=all');
  const card = page
    .locator('[data-testid="funnel-mobile"]')
    .getByTestId('lead-card')
    .filter({ hasText: NAME })
    .first();
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
