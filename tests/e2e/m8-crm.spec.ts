import { expect, test } from '@playwright/test';

/**
 * Phase 2.3 CRM end to end: the owner configures the funnel and adds a field
 * of his own, a lead walks the funnel, gets a call logged and becomes a real
 * client card — and a sales manager cannot reach the settings that reshape
 * the funnel for everyone.
 */

const OWNER = '+998900000001';
const SALES = '+998900000009';
const PASSWORD = 'demo1234';
const runId = Date.now().toString().slice(-6);

async function login(page: import('@playwright/test').Page, phone: string) {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(phone);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('a lead walks the funnel and becomes a client', async ({ page }) => {
  await login(page, OWNER);

  // The owner shapes the CRM first: a stage of his own and a custom field.
  // The add forms live in collapsed panels — the settings page is long and
  // most visits are to look, not to add.
  await page.goto('/crm/settings');
  const addStage = page.locator('details').filter({ has: page.getByTestId('save-stage') });
  await addStage.locator('summary').click();
  await addStage.locator('input[name="name"]').fill(`Sinov bosqichi ${runId}`);
  await page.getByTestId('save-stage').click();
  // Scoped to THIS panel: a ✅ left over from another form would let the test
  // race ahead while the save was still in flight.
  await expect(addStage.getByText('✅')).toBeVisible();

  const addField = page.locator('details').filter({ has: page.getByTestId('save-field') });
  await addField.locator('summary').click();
  await addField.locator('input[name="label"]').fill(`Shahar ${runId}`);
  await addField.locator('select[name="type"]').selectOption('select');
  await addField.locator('input[name="options"]').fill('Toshkent, Andijon');
  await page.getByTestId('save-field').click();
  await expect(addField.getByText('✅')).toBeVisible();

  // A new lead, answering the field that did not exist a minute ago.
  await page.goto('/crm/leads/new');
  await page.getByTestId('lead-name').fill(`Sinov mijoz ${runId}`);
  await page.locator('input[name="phone"]').fill(`+99890${runId}`);
  await page.getByLabel(`Shahar ${runId}`).selectOption('Andijon');
  await page.getByTestId('save-lead').click();
  await expect(page).toHaveURL(/\/crm\/leads\/[0-9a-f-]+$/);

  // A call, with the next one booked for today so it lands on the call list.
  const today = new Date().toISOString().slice(0, 10);
  const activity = page.locator('form').filter({ has: page.getByTestId('save-activity') });
  await page.getByTestId('activity-note').fill('narx aytdim');
  await activity.locator('input[name="nextActionAt"]').fill(today);
  await page.getByTestId('save-activity').click();
  await expect(page.getByText('narx aytdim')).toBeVisible();

  // Booked for today, so it is on the call list.
  await page.goto('/crm/today');
  await expect(page.getByText(`Sinov mijoz ${runId}`)).toBeVisible();

  // /crm IS the board now (owner: the CRM opens on the funnel, not a table).
  await page.goto('/crm?scope=all');
  await expect(page.getByText(`Sinov mijoz ${runId}`)).toBeVisible();

  // Drag the card from one column to the next with a real pointer gesture —
  // HTML5 drag-and-drop does not fire on touch, so this is what the phone
  // actually does: press, hold, move, release.
  await page.goto('/crm?scope=all');
  const card = page.getByTestId('lead-card').filter({ hasText: `Sinov mijoz ${runId}` });
  const from = (await card.boundingBox())!;
  const target = page.getByTestId('column-open').nth(1);
  const to = (await target.boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  // The project runs Playwright in mobile emulation, so these arrive as TOUCH
  // pointer events — which means the card only comes off the board after the
  // long press, exactly like a real finger.
  await page.waitForTimeout(400);
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + 20, { steps: 5 });
  // Drop on the VISIBLE sliver of the next column: at 360 px only ~76 px of
  // it is on screen, and a point outside the viewport has no element under
  // it at all. Real fingers reach the rest through the edge auto-scroll.
  await page.mouse.move(to.x + 16, to.y + 60, { steps: 10 });
  await page.mouse.up();

  // The card lands in the new column and stays there after a reload.
  await expect(target.getByText(`Sinov mijoz ${runId}`)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('column-open').nth(1).getByText(`Sinov mijoz ${runId}`)).toBeVisible();

  // Won → convert. The convert panel opens by itself on a won stage, so the
  // last step of a deal is never a tap away from being forgotten.
  await page.goto('/crm?scope=all');
  await page.getByText(`Sinov mijoz ${runId}`).click();
  await expect(page.getByLabel(`Shahar ${runId}`)).toHaveValue('Andijon');
  await page.getByTestId('stage-won').click();
  await expect(page.getByTestId('convert-lead')).toBeVisible();
  await page.getByTestId('convert-lead').click();
  await expect(page).toHaveURL(/\/admin\/clients\/[0-9a-f-]+$/);
  // The new client card carries the CRM half too.
  await expect(page.getByTestId('activity-note')).toBeVisible();
});

test('a sales manager works leads but cannot reshape the funnel', async ({ page }) => {
  await login(page, SALES);
  await page.goto('/crm');
  await expect(page).toHaveURL('/crm');

  await page.goto('/crm/settings');
  await expect(page).toHaveURL('/crm');
  await page.goto('/crm/people');
  await expect(page).toHaveURL('/crm');
});
