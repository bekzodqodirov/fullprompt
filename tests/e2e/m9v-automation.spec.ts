import { expect, test } from '@playwright/test';

/**
 * Phase 7 in the browser: the owner writes a rule on the form, moves a real
 * deal into the chosen stage, and the task the rule promised EXISTS on the
 * task list. The rule is deleted at the end — a rule is CONFIGURATION, and
 * one left behind would silently fire on every later spec's stage moves
 * (#183). The task it made is data and stays.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);

test('a rule written on the form opens a task when the deal reaches the stage', async ({
  page,
}) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // Write the rule: deal enters <last stage> → task to whoever moved it.
  // The panel opens itself when the list is empty — only tap it shut⁄open
  // when the form is not already on screen.
  await page.goto('/admin/rules');
  if (!(await page.getByTestId('rule-form').isVisible())) {
    await page.getByTestId('new-rule-panel').click();
  }
  await page.getByTestId('rule-name').fill(`Qoida ${runId}`);
  const stagePick = page.getByTestId('rule-stage');
  // The LAST stage used to be the pick, and every seeded funnel puts «lost»
  // last — so this spec was moving a deal into a lost stage through the edit
  // form, with no reason typed, which round 83 made a refusal. Choose by KIND
  // and never by position (#59): the owner names his own funnel, and the rule
  // being tested is about entering a stage, not about which one.
  const stageValues = await stagePick
    .locator('option:not([data-kind="lost"])')
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
  const targetStage = stageValues[stageValues.length - 1]!;
  await stagePick.selectOption(targetStage);
  await page.getByTestId('rule-task-title').fill(`Avto vazifa ${runId}`);
  await page.getByTestId('rule-assignee').selectOption('actor');
  await page.getByTestId('save-rule').click();
  await expect(page.getByTestId('rule-row').filter({ hasText: `Qoida ${runId}` })).toBeVisible();

  // A deal of our own, moved into that stage through the ordinary edit form.
  await page.goto('/admin/clients?q=GS777');
  await page.locator('a[href^="/admin/clients/"]:not([href$="/new"])').first().click();
  await page.getByTestId('client-new-deal').click();
  await page.getByTestId('deal-title').fill(`Avto bitim ${runId}`);
  await page.getByTestId('save-deal').click();
  await expect(page).toHaveURL(/\/bitimlar\/[0-9a-f-]+$/);

  await page.getByTestId('deal-edit-panel').click();
  await page.getByTestId('deal-form').locator('select[name="stageId"]').selectOption(targetStage);
  await page.getByTestId('save-deal').click();
  await expect(page.getByTestId('deal-form').locator('button[type="submit"]')).toContainText('✅');

  // The event worker fires on the kick the action sent; the task appears.
  await expect
    .poll(
      async () => {
        await page.goto('/bugun');
        return page.getByText(`Avto vazifa ${runId}`).count();
      },
      { timeout: 30_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBeGreaterThan(0);

  // The rule proudly counts its work (whatever locale the counter speaks).
  await page.goto('/admin/rules');
  const row = page.getByTestId('rule-row').filter({ hasText: `Qoida ${runId}` });
  await expect(row).not.toContainText(/Ещё не|Hali ishlamagan|Has not fired/);

  // …and then leaves no configuration behind.
  page.on('dialog', (dialog) => void dialog.accept());
  await row.getByTestId('rule-delete').click();
  await expect(page.getByTestId('rule-row').filter({ hasText: `Qoida ${runId}` })).toHaveCount(0);
});
