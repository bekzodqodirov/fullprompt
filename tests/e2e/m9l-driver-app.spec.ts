import { expect, test } from '@playwright/test';

/**
 * Handing the driver app out as a link (owner: "driver appni gitni ichidan
 * emas 1 link orqali skachat qilib oladgan qilib ber").
 *
 * The one thing that cannot be proved anywhere else is that `/driver` is
 * reachable by somebody with NO session. A driver is not a user of this
 * system and never will be; if this page ever slips under `(protected)` it
 * becomes a staff login screen shown to a driver in a warehouse yard, and
 * nobody on our side would notice — the whole company is logged in.
 *
 * Deliberately does NOT publish an APK: what may be published, and what the
 * validation refuses, is `tests/unit/driver-apk.test.ts`. Publishing here
 * would leave a build behind for every later spec to render (#183), and the
 * upload has no undo.
 */

const OPERATOR = '+998900000006';
const PASSWORD = 'demo1234';

test('a driver with no login reaches the download page', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/driver');
  // Still on /driver, not bounced to the staff login.
  await expect(page).toHaveURL(/\/driver$/);
  await expect(page.getByRole('heading', { name: 'GSR Driver' })).toBeVisible();
});

test('before anything is published it says so instead of failing', async ({ page }) => {
  // A fresh server has no APK, and the page a driver opens must say that in
  // words rather than crash — the warehouse worker standing beside them needs
  // to know whose problem it is.
  await page.context().clearCookies();
  await page.goto('/driver');
  await expect(page.getByTestId('driver-none')).toBeVisible();
  await expect(page.getByTestId('driver-download')).toHaveCount(0);
});

test('the download answers 404 rather than an empty file', async ({ request }) => {
  // An empty 200 would install as a corrupt APK and the driver would blame
  // their phone.
  const res = await request.get('/driver/apk');
  expect(res.status()).toBe(404);
});

test('the publish endpoint refuses a caller with no session', async ({ request }) => {
  // The upload is a route handler rather than a server action — server actions
  // cap the body at 1 MB and an APK is megabytes — so it carries its own gate
  // instead of inheriting the admin layout's.
  const res = await request.post('/api/driver-app', {
    multipart: {
      version: '9.9',
      apk: { name: 'x.apk', mimeType: 'application/octet-stream', buffer: Buffer.from('PK\x03\x04') },
    },
  });
  expect(res.status()).toBe(403);
});

test('publishing a build is not open to the whole warehouse', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OPERATOR);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  // This replaces the file every driver's phone installs next. An operator
  // has no business there, and the page carries its own gate rather than
  // trusting the admin layout (#198).
  await page.goto('/admin/driver-app');
  await expect(page).toHaveURL('/');
});
