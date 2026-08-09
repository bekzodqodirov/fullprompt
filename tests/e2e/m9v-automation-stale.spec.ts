import { expect, test } from '@playwright/test';

/**
 * Round 86 in the browser: the two things phase 7's form could not say.
 *
 * A rule that fires because NOTHING happened, and a rule that narrows itself
 * — written the way the owner writes them, then read back off the list. The
 * SWEEP itself is proven in the integration suite (it needs a card that has
 * been sitting still for days, which no browser can wait for); what only a
 * browser can prove is that the form's three parallel condition lists survive
 * the round trip in the right order (#171's shape, one costume on).
 *
 * The rule is deleted at the end — a rule is CONFIGURATION and one left
 * behind fires on every later spec (#183).
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);

test('a time-triggered rule with two conditions is saved and read back', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/admin/rules');
  if (!(await page.getByTestId('rule-form').isVisible())) {
    await page.getByTestId('new-rule-panel').click();
  }
  await page.getByTestId('rule-name').fill(`Qotgan ${runId}`);
  await page.getByTestId('rule-trigger-type').selectOption('lead_stale');

  // The days box exists only for a time trigger.
  await expect(page.getByTestId('rule-stale-days')).toBeVisible();
  await page.getByTestId('rule-stale-days').fill('7');

  /**
   * Two conditions, and the valueless one goes FIRST on purpose.
   *
   * The three lists are zipped by position, so a value box that stops posting
   * shifts every later row's value up by one (#171). Put the valueless row
   * last and the gap falls off the end where nothing notices; put it first
   * and «500» lands on the wrong condition — which is the only arrangement
   * that can fail.
   */
  await page.getByTestId('rule-cond-add').click();
  await page.getByTestId('rule-cond-field').first().selectOption('phone');
  await page.getByTestId('rule-cond-op').first().selectOption('not_empty');
  await page.getByTestId('rule-cond-add').click();
  await page.getByTestId('rule-cond-field').nth(1).selectOption('amount');
  await page.getByTestId('rule-cond-op').nth(1).selectOption('gt');
  // `.nth(1)`, not `.first()`: row 0's box is HIDDEN, not gone — that is the
  // whole mechanism, and it is still in the DOM still posting its blank.
  await page.getByTestId('rule-cond-value').nth(1).fill('500');

  await page.getByTestId('rule-task-title').fill(`{ism} — qo'ng'iroq ${runId}`);
  await page.getByTestId('rule-assignee').selectOption('owner');
  await page.getByTestId('save-rule').click();

  const row = page.getByTestId('rule-row').filter({ hasText: `Qotgan ${runId}` });
  await expect(row).toBeVisible();
  // Both conditions survived, in the order they were written, with the value
  // attached to the condition that was given one.
  const conditions = row.getByTestId('rule-conditions');
  await expect(conditions).toContainText('500');
  const text = (await conditions.textContent()) ?? '';
  expect(text.indexOf('500')).toBeLessThan(text.length - 1);
  expect(text.split('·')).toHaveLength(2);
  // The trigger line states the silence it watches for.
  await expect(row).toContainText('7');

  // A warehouse event has no card, so the conditions block is not offered.
  // The panel folds itself once the list is no longer empty, so it has to be
  // opened again — the save put a rule in it.
  if (!(await page.getByTestId('rule-form').isVisible())) {
    await page.getByTestId('new-rule-panel').click();
  }
  await page.getByTestId('rule-trigger-type').selectOption('event');
  await expect(page.getByTestId('rule-cond-add')).toHaveCount(0);
  await expect(page.getByTestId('rule-stale-days')).toHaveCount(0);

  page.on('dialog', (dialog) => void dialog.accept());
  await row.getByTestId('rule-delete').click();
  await expect(page.getByTestId('rule-row').filter({ hasText: `Qotgan ${runId}` })).toHaveCount(0);
});
