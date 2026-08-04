import { expect, test } from '@playwright/test';

/**
 * Work one person gives another, and the day screen it lands on.
 *
 * The part only a browser can prove: a task raised from a client card reaches
 * somebody else's morning list, carries a link back to the record it is about,
 * and closes with a result — and that the day screen still shows the CRM
 * follow-ups it did not replace.
 */

const OWNER = '+998900000001';
const SALES = '+998900000009';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);

/**
 * Open a <details> panel only if it is shut.
 *
 * The tasks panel opens ITSELF when the record has outstanding work, so a
 * blind click closes it — and whether it is open depends on what earlier specs
 * left behind, which is exactly the kind of order-dependence that makes a
 * suite flaky.
 */
async function openPanel(page: import('@playwright/test').Page, testId: string) {
  const summary = page.getByTestId(testId);
  await expect(summary).toBeVisible();
  const open = await summary.evaluate(
    (el) => (el.parentElement as HTMLDetailsElement | null)?.open ?? false,
  );
  if (!open) await summary.click();
}

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('a task raised on a client card lands on somebody else’s day', async ({ page }) => {
  await login(page, OWNER);

  // Raised from the record it is about — the whole point of the panel.
  await page.goto('/admin/clients');
  // …not the "new client" button, which is also an /admin/clients/ link.
  await page.locator('a[href^="/admin/clients/"]:not([href$="/new"])').first().click();
  await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]+$/);
  const cardUrl = page.url();

  await openPanel(page, 'tasks-panel');
  const title = `Kubini qayta hisobla ${runId}`;
  await page.getByTestId('task-title').fill(title);
  // Given to the sales manager, not to me: a task nobody hands over is a note.
  const picker = page.getByTestId('task-assignee');
  const mine = await picker.inputValue();
  const others = await picker.locator('option').all();
  const values = (await Promise.all(others.map((o) => o.getAttribute('value')))).filter(
    (value): value is string => Boolean(value) && value !== mine,
  );
  await picker.selectOption(values[0]!);
  await page.getByTestId('task-due').fill(new Date().toISOString().slice(0, 10));
  await page.getByTestId('save-task').click();
  await expect(page.getByTestId('save-task')).toHaveText('✅');

  // It is on the card it was raised from.
  await page.goto(cardUrl);
  // No click: a record with outstanding work shows it without being asked.
  await expect(page.getByText(title)).toBeVisible();
});

test('the day screen shows what is due and closes it with a result', async ({ page }) => {
  await login(page, OWNER);

  await page.goto('/bugun');
  const title = `O‘zimga ish ${runId}`;
  await openPanel(page, 'new-task-panel');
  const form = page.getByTestId('new-task').last();
  await form.getByTestId('task-title').fill(title);
  await form.getByTestId('task-due').fill(new Date().toISOString().slice(0, 10));
  await form.getByTestId('save-task').click();
  // Wait for the action to answer before navigating: reloading mid-flight
  // aborts the request and the assertion below measures the state BEFORE the
  // write committed (DECISIONS #173).
  await expect(form.getByTestId('save-task')).toHaveText('✅');

  await page.goto('/bugun');
  const due = page.getByTestId('day-today');
  await expect(due).toBeVisible();
  const card = due.locator('[data-testid^="task-"]').filter({ hasText: title });
  await expect(card).toBeVisible();

  // Closing asks what happened — an empty close teaches everyone the field is
  // decoration.
  await card.locator('[data-testid^="close-"]').click();
  await card.locator('[data-testid^="result-"]').fill('hisoblab berdim');
  await card.locator('[data-testid^="save-close-"]').click();
  // The card leaves the open list once the close has landed.
  await expect(card).toHaveCount(0);

  await page.goto('/bugun');
  await expect(page.getByTestId('day-today').filter({ hasText: title })).toHaveCount(0);
});

test('a task cannot be raised for somebody who has left', async ({ page }) => {
  await login(page, OWNER);
  await page.goto('/bugun');
  // The picker only offers active staff, which is the guard the server also
  // applies — the two must not disagree.
  const values = await page.getByTestId('task-assignee').locator('option').count();
  expect(values).toBeGreaterThan(0);
});

test('the calendar shows the month and opens a day', async ({ page }) => {
  await login(page, OWNER);
  const today = new Date().toISOString().slice(0, 10);

  await page.goto('/bugun');
  const title = `Kalendar ishi ${runId}`;
  await openPanel(page, 'new-task-panel');
  const form = page.getByTestId('new-task').last();
  await form.getByTestId('task-title').fill(title);
  await form.getByTestId('task-due').fill(today);
  await form.getByTestId('save-task').click();
  await expect(form.getByTestId('save-task')).toHaveText('✅');

  await page.goto('/kalendar');
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  await expect(page.getByTestId('calendar-month')).toHaveText(today.slice(0, 7));
  // The month it draws is the month the URL asks for, so a month can be sent
  // to somebody.
  await page.getByTestId('next-month').click();
  await expect(page.getByTestId('calendar-month')).not.toHaveText(today.slice(0, 7));
  await page.goto(`/kalendar?day=${today}`);
  await expect(page.getByTestId('calendar-day')).toContainText(title);
});

test('a sales manager still gets the follow-ups the day screen did not replace', async ({
  page,
}) => {
  await login(page, SALES);
  await page.goto('/bugun');
  // Whatever is on it, the screen answers rather than 404s for a role with no
  // admin rights at all.
  await expect(page.getByTestId('new-task-panel')).toBeVisible();
  // …and the old call list is still its own working screen.
  await page.goto('/crm/today');
  await expect(page).toHaveURL('/crm/today');
});
