import { expect, test } from '@playwright/test';

/**
 * Phase 4 in the browser: typing @ in a note offers colleagues, picking one
 * inserts the canonical name, and the saved note carries it. Who gets PINGED
 * is proven at the integration layer (internal-chat) — the browser's half is
 * the dropdown and the text. The spec creates its own lead and leaves no
 * configuration behind (#154/#183).
 */

const SALES = '+998900000009';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);

test('an @ in a note finds a colleague and survives the save', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(SALES);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/crm/leads/new');
  await page.getByTestId('lead-name').fill(`Mention sinov ${runId}`);
  await page.getByTestId('save-lead').click();
  await expect(page).toHaveURL(/\/crm\/leads\/[0-9a-f-]+$/);

  // Type @ plus a prefix of a seeded colleague ("Logist Demo").
  const note = page.getByTestId('feed-note-body');
  await note.click();
  await note.fill(`@Logist`);
  await expect(page.getByTestId('mention-list')).toBeVisible();
  await page.getByTestId('mention-option').filter({ hasText: 'Logist Demo' }).first().click();
  // The canonical full name replaced the fragment.
  await expect(note).toHaveValue(/@Logist Demo /);

  await note.fill((await note.inputValue()) + `narxni tekshiring ${runId}`);
  // The mobile project emulates touch: press the button, never Enter.
  await page
    .getByTestId('feed-note-box')
    .locator('button[type="submit"]')
    .click();
  await expect(
    page.getByTestId('feed-list').getByText(`narxni tekshiring ${runId}`),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('feed-list').getByText('@Logist Demo').first()).toBeVisible();
});
