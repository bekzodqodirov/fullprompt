import { expect, test } from '@playwright/test';

/**
 * VED phase A — the queue, in a browser.
 *
 * What only a browser can prove: that the seller's panel really posts a
 * request from a card, that the queue screen renders it for a `ved.docs`
 * holder, and that «Olaman» → «Bajarildi» closes it. The service's rules —
 * the deadline, the checklist, the races, the clock stops — are proven
 * against the database in `calc-queue.integration.test.ts`.
 *
 * It runs LAST in the file order, so its leftovers would only ever reach a
 * later RUN — which is the worst shape, because that run's diff is innocent.
 * Hence the closing test: a request left open sits in a company-wide queue,
 * puts a number on the VED home, and after two hours starts telegraphing the
 * owner about a fixture (#183, and #508 — cleanup is a TEST, never an
 * afterAll, which has neither baseURL nor login).
 */

const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

let leadName = '';
let requestUrl = '';

test.describe.configure({ mode: 'serial' });

test('a seller sends a calculation from a lead card', async ({ page }) => {
  await login(page, ADMIN);

  // A lead of this spec's own, reached by the URL captured at creation — never
  // through the board, which every earlier spec has been adding cards to.
  await page.goto('/crm');
  await page.getByTestId('quick-create').click();
  // The admin may mint more than one kind, so the panel asks which first.
  const pickLead = page.getByTestId('quick-kind-lead');
  if (await pickLead.count()) await pickLead.click();
  const name = `VED e2e ${Date.now()}`;
  leadName = name;
  await page.getByTestId('quick-name').fill(name);
  await page.getByTestId('quick-save').click();
  const made = page.getByTestId('quick-made');
  await expect(made).toBeVisible({ timeout: 15_000 });
  // Navigated by its href rather than clicked: the toast is a fixed overlay
  // and can sit under the fold on a desktop viewport. The URL is what the
  // rest of this spec needs anyway — the board is capped and every earlier
  // spec has been adding cards to it.
  const href = await made.getByRole('link').first().getAttribute('href');
  expect(href, 'the quick-create toast must link to the lead').toBeTruthy();
  await page.goto(href!);
  await expect(page).toHaveURL(/\/crm\/leads\//, { timeout: 15_000 });

  // The panel is a fold on the rail; the form inside it is the desk half.
  await page.getByTestId('calc-panel').click();
  await page.getByTestId('calc-section-podklyuch').click();
  await page.getByTestId('calc-from-city').fill('Yiwu');
  await page.getByTestId('calc-to-city').fill('Toshkent');
  await page.getByTestId('calc-weight').fill('300');
  await page.getByTestId('calc-volume').fill('2');
  await page.getByTestId('calc-goods').fill('monitor, 10\nkabel, 5');
  await page.getByTestId('calc-send').click();

  // The panel now says the queue has it — badge, and an open row whose link
  // is THIS request. Captured here, because the queue is company-wide and its
  // first row belongs to whoever asked first (an earlier spec, usually).
  await expect(page.getByTestId('calc-open')).toBeVisible({ timeout: 15_000 });
  const openHref = await page.getByTestId('calc-open-link').first().getAttribute('href');
  expect(openHref, 'the panel must link to the request it just opened').toBeTruthy();
  requestUrl = openHref!;
});

test('the queue shows it, and the checklist says what it knows', async ({ page }) => {
  expect(requestUrl, 'the send test must have captured its request').not.toBe('');
  await login(page, ADMIN);
  await page.goto('/hisoblash');
  await expect(page.getByTestId('calc-queue-row').first()).toBeVisible({ timeout: 15_000 });

  await page.goto(requestUrl);
  // Everything the seller submitted, and the goods at his own grain.
  await expect(page.getByTestId('calc-materials')).toBeVisible();
  await expect(page.getByTestId('calc-items')).toBeVisible();
  await expect(page.getByTestId('calc-checklist')).toBeVisible();
});

test('take it, then finish it with the figure the seller is waiting for', async ({ page }) => {
  expect(requestUrl, 'the queue test must have opened a request').not.toBe('');
  await login(page, ADMIN);
  await page.goto(requestUrl);

  // The admin is not the auto-assignee, so «Olaman» is offered.
  const take = page.getByTestId('calc-take');
  if (await take.isVisible()) {
    await take.click();
    await expect(take).toHaveCount(0, { timeout: 15_000 });
  }

  await page.getByTestId('calc-finish-open').click();
  await page.getByTestId('calc-answer-amount').fill('480');
  await page.getByTestId('calc-answer-note').fill('e2e');
  await page.getByTestId('calc-finish').click();

  // Closed: the answer is on the record, and the actions are gone.
  await expect(page.getByTestId('calc-answer')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('calc-finish-open')).toHaveCount(0);
});

test('the lead it created is closed (cleanup as a test)', async ({ page }) => {
  expect(leadName, 'the first test must have minted a lead').not.toBe('');
  await login(page, ADMIN);

  // The request is already closed by the test above — what is left is the
  // lead, which would otherwise sit on the funnel for ever. Closed through
  // the BULK bar, because round 87 took lost stages out of the edit form's
  // picker: a loss needs a typed reason and the form has no box for one.
  await page.goto('/crm?scope=all');
  const card = page
    // This spec runs in the desktop project, where the board renders both
            // shapes into the DOM and CSS picks one — scope, or every card is
            // found twice (#495's lesson).
            .getByTestId('funnel-desktop')
    .getByTestId('lead-card')
    .filter({ hasText: leadName })
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
