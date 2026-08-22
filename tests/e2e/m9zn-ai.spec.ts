import { expect, test } from '@playwright/test';

/**
 * The /ai screen — the AI round.
 *
 * CI has no ANTHROPIC_API_KEY, so what only this spec can prove is the
 * honest part (m9x's precedent): the screen is reachable by URL, says
 * «sozlanmagan» in a sentence instead of offering a dead chat box, and the
 * MENU carries no AI door while the key is absent — a door to that sentence
 * would be clutter, and deploy morning is when everyone would tap it. The
 * loop, the tiers and the SQL fence are integration-proven with a scripted
 * model; the first live question is watched in docker logs, as every
 * external integration before it was.
 *
 * Creates nothing, leaves nothing (#154): an unconfigured visit writes no
 * ai_questions row (asked BEFORE the ledger, pinned in integration).
 */

const ADMIN = '+998900000001';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(ADMIN);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('unconfigured /ai says so honestly, and the menu offers no door to it', async ({ page }) => {
  await login(page);
  // No key → no tile on the home screen…
  await expect(page.locator('a[href="/ai"]')).toHaveCount(0);
  // …but the route answers, with the sentence, not a dead chat.
  await page.goto('/ai');
  await expect(page.getByTestId('ai-not-configured')).toBeVisible();
  await expect(page.getByTestId('ai-question')).toHaveCount(0);
});
