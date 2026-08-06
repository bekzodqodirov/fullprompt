import { expect, test } from '@playwright/test';

/**
 * The /profile «Qo'ng'iroq yozuvi» section — the calls round's browser half.
 *
 * What only this spec can prove: the section renders, a press mints a code a
 * person can read into the phone, and the revoke takes the row off the
 * screen. The phone's side of the contract (410 stops it, the client-book
 * door, viewer scoping) is integration-proven in calls.integration.test.ts;
 * the audio player needs bytes only a real phone can send, so the panel is
 * proven at the service and looked at in screenshots.
 *
 * Cleanup is the revoke itself: a revoked device is filtered from every
 * read and answers 410 — inert data, not configuration (#154). The spec
 * still revokes EVERYTHING it sees so the next run's profile is bare.
 */

const SALES = '+998900000009';
const PASSWORD = 'demo1234';

test('a staff member mints a pairing code and revokes the device', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(SALES);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/profile');
  await page.getByTestId('call-device-add').click();
  // The code the person reads into the app: 6 characters, no 0/O/1/I.
  await expect(page.getByTestId('call-pair-code').first()).toHaveText(/^[A-Z2-9]{6}$/);

  // Revoke every device row — the section must end the spec empty.
  for (;;) {
    const count = await page.getByTestId('call-device-revoke').count();
    if (count === 0) break;
    await page.getByTestId('call-device-revoke').first().click();
    await expect(page.getByTestId('call-device-revoke')).toHaveCount(count - 1, {
      timeout: 10_000,
    });
  }
  await expect(page.getByTestId('call-pair-code')).toHaveCount(0);
});
