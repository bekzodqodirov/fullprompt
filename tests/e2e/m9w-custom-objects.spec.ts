import { expect, test } from '@playwright/test';

/**
 * Phase 8 in the browser: the owner invents an OBJECT on the admin form and
 * it immediately exists everywhere — a tile on /o, a list, a card carrying
 * the panels every shipped card has. The type is deactivated at the end: an
 * entity is CONFIGURATION, and one left behind puts an extra tile on /o and
 * an extra group on /admin/fields for every later spec (#183). The record
 * under it is data and stays.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const runId = String(Date.now()).slice(-6);

test('an invented object gets a list, a card with fields/tasks, and hides on deactivate', async ({
  page,
}) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // Invent the type. The panel opens itself when the list is empty — only
  // tap it open when the form is not already on screen (the m9v guard).
  await page.goto('/admin/entities');
  if (!(await page.getByTestId('entity-form').isVisible())) {
    await page.getByTestId('new-entity-panel').click();
  }
  await page.getByTestId('entity-label').fill(`Yetkazuvchilar ${runId}`);
  await page.getByTestId('entity-write-choice').selectOption('everyone');
  await page.getByTestId('save-entity').click();
  const typeRow = page.getByTestId('entity-row').filter({ hasText: `Yetkazuvchilar ${runId}` });
  await expect(typeRow).toBeVisible();

  // The front door: a tile with the owner's own label, straight to the list.
  await page.goto('/o');
  await page.getByTestId('object-tile').filter({ hasText: `Yetkazuvchilar ${runId}` }).click();
  await expect(page).toHaveURL(/\/o\/x_[a-z0-9]+$/);

  // A record exists in one tap and lands on its card.
  await page.getByTestId('record-name').fill(`Guangzhou ${runId}`);
  await page.getByTestId('save-record').click();
  await expect(page).toHaveURL(/\/o\/x_[a-z0-9]+\/[0-9a-f-]+$/);
  await expect(page.locator('h1')).toContainText(`Guangzhou ${runId}`);

  // The generic card carries the panels every shipped card has. (The fields
  // panel is deliberately absent until a field is defined — that path is
  // proven end-to-end by the integration suite.)
  await expect(page.getByTestId('tasks-panel')).toBeVisible();

  // Edit through the card and see the save confirmed.
  await page.getByTestId('record-edit-panel').click();
  await page.getByTestId('record-form').locator('textarea[name="note"]').fill(`Yiwu ${runId}`);
  await page.getByTestId('save-record-edit').click();
  await expect(page.getByTestId('save-record-edit')).toContainText('✅');

  // Back on the list the record is a row.
  await page.goBack();
  await expect(
    page.getByTestId('object-row').filter({ hasText: `Guangzhou ${runId}` }),
  ).toBeVisible();

  // Deactivate the type: hidden from /o, never deleted (#183 cleanup).
  await page.goto('/admin/entities');
  await typeRow.getByTestId('entity-toggle').click();
  // Whatever locale the button speaks, it now offers to bring the type back.
  await expect(typeRow.getByTestId('entity-toggle')).toContainText(/Включить|Yoqish|Enable|启用/);
  await page.goto('/o');
  await expect(
    page.getByTestId('object-tile').filter({ hasText: `Yetkazuvchilar ${runId}` }),
  ).toHaveCount(0);
});
