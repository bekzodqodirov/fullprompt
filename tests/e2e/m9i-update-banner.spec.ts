import { expect, test } from '@playwright/test';

/**
 * "Deploy qildim lekin tugma chiqmadi."
 *
 * Three times in one week a shipped fix was reported as not shipped, and every
 * time the code was on the server and the phone was rendering a page the
 * service worker had kept. There is no way for the person holding the phone to
 * tell that apart from a broken deploy, so the app has to say it.
 *
 * The mechanism is a comparison: the build stamp compiled into the bundle
 * versus the one `/api/version` reports live. The interesting case cannot be
 * produced by a normal run — both sides come from the same build — so the
 * server's answer is stubbed to a future build, which is precisely what a
 * deploy looks like to a screen that stayed open through it.
 *
 * Asserted on a PHONE viewport because that is the only place this ever
 * mattered: a sticky bar that covers the header on a 390 px screen would be a
 * worse bug than the one it fixes.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

test('no banner while the phone and the server agree', async ({ page }) => {
  await login(page);
  // The guard that keeps this from nagging all day: same build, no bar. It
  // also proves the stub below is what produces the banner, not merely the
  // component being mounted.
  await expect(page.getByTestId('update-banner')).toHaveCount(0);
});

test('the app says so when the server has moved on', async ({ page }) => {
  await login(page);

  await page.route('**/api/version', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ build: '2099-01-01 00:00 UTC' }),
    }),
  );
  await page.reload();

  const banner = page.getByTestId('update-banner');
  await expect(banner).toBeVisible();

  // It must not sit on top of the header it is stuck under.
  const header = page.locator('header').first();
  const bar = await banner.boundingBox();
  const head = await header.boundingBox();
  expect(bar).toBeTruthy();
  expect(head).toBeTruthy();
  expect(bar!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1);

  // And the one tap has to be reachable, not clipped off a narrow screen.
  const button = page.getByTestId('update-now');
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
