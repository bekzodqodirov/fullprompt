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

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('a card is dragged from one column to the next', async ({ page }) => {
  await login(page);

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

test('a finger does not drag, and the card it cannot drag has a button', async ({ page }) => {
  // Which board a viewer gets is decided by WIDTH alone, so a tablet lands on
  // this one. Its drag used to arm a 250 ms hold for every pointer that was
  // not a mouse — the touch drag the owner refused twice. Simulated with real
  // PointerEvents rather than the touchscreen, because this project runs with
  // hasTouch:false and the guard reads `pointerType`, which is what matters.
  //
  // It reuses the lead the previous test dragged into `column-open` nth(1),
  // so it adds nothing to the board.
  await login(page);
  await page.goto('/crm?scope=all');
  const board = page.getByTestId('funnel-desktop');
  await expect(board).toBeVisible();

  const home = board.getByTestId('column-open').nth(1);
  const card = home.getByTestId('lead-card').filter({ hasText: `Drag mijoz ${runId}` });
  await expect(card).toBeVisible();
  const from = (await card.boundingBox())!;
  const target = board.getByTestId('column-open').first();
  const to = (await target.boundingBox())!;

  const touch = (type: string, x: number, y: number) =>
    card.dispatchEvent(type, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });

  await touch('pointerdown', from.x + from.width / 2, from.y + 20);
  // Well past the 8 px threshold, and past the 250 ms the hold used to want.
  await touch('pointermove', from.x + from.width / 2 + 40, from.y + 20);
  await page.waitForTimeout(400);
  await touch('pointermove', to.x + to.width / 2, to.y + 60);
  await touch('pointerup', to.x + to.width / 2, to.y + 60);

  // Nothing lifted, nothing moved, and the board said nothing went wrong.
  await expect(page.getByTestId('kanban-error')).toHaveCount(0);
  await expect(target.getByText(`Drag mijoz ${runId}`)).toHaveCount(0);
  await expect(home.getByText(`Drag mijoz ${runId}`)).toBeVisible();

  // …and the way a tablet DOES move a card is on the card itself.
  await expect(card.getByTestId('move-other')).toBeVisible();
  await card.getByTestId('move-other').click();
  await expect(page.getByTestId('move-to-lost').first()).toBeVisible();
});
