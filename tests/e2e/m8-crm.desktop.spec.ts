import { expect, test } from '@playwright/test';

/**
 * The funnel's desktop shape: every stage as a column, and a card dragged
 * between them with a real pointer gesture.
 *
 * This lives in its own spec because it needs a viewport where the drag board
 * exists at all — a phone gets one stage at a time and moves cards by tapping
 * (tests/e2e/m8-crm.spec.ts). The playwright config routes *.desktop.spec.ts
 * to the desktop project.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);

test('a card is dragged from one column to the next', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/crm/leads/new');
  await page.getByTestId('lead-name').fill(`Drag mijoz ${runId}`);
  await page.getByTestId('save-lead').click();
  await expect(page).toHaveURL(/\/crm\/leads\/[0-9a-f-]+$/);

  await page.goto('/crm?scope=all');
  const board = page.getByTestId('funnel-desktop');
  await expect(board).toBeVisible();
  // The phone's single-stage view is not rendered at this width.
  await expect(page.getByTestId('funnel-mobile')).toBeHidden();

  const card = board.getByTestId('lead-card').filter({ hasText: `Drag mijoz ${runId}` });
  const from = (await card.boundingBox())!;
  const target = board.getByTestId('column-open').nth(1);
  const to = (await target.boundingBox())!;

  // A mouse skips the long press and picks the card up as soon as it has
  // actually moved — a hold would only slow a desktop user down.
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + 20, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 60, { steps: 10 });
  await page.mouse.up();

  // It lands in the new column and stays there after a reload.
  await expect(target.getByText(`Drag mijoz ${runId}`)).toBeVisible();
  await page.reload();
  await expect(
    page.getByTestId('funnel-desktop').getByTestId('column-open').nth(1).getByText(`Drag mijoz ${runId}`),
  ).toBeVisible();
});
