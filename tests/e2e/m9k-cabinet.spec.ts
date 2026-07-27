import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { clientLabels } from '../../src/modules/platform/telegram/client-labels';
import { E2E_BOT_TOKEN } from './bot-token';

/**
 * The client's Mini App — the only screen in this system a CUSTOMER opens.
 *
 * What is checked here is everything that cannot be checked in a unit test:
 * that `/cabinet` is reachable WITHOUT a staff session (it sits in its own
 * route group; one wrong folder and every client meets an employee login
 * form), that the API fails closed for a request with no signed blob, and
 * that a real Telegram user who is not a customer is told what to do instead
 * of being shown a broken screen.
 *
 * Deliberately leaves NO database state behind (#154, #183): it signs
 * `initData` for a Telegram id that belongs to nobody, so nothing is linked,
 * nothing is created, and the spec's position in the run order does not
 * matter.
 */

/** Telegram's construction — the same maths the server will redo. */
function signedInitData(userId: number, token = E2E_BOT_TOKEN): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: 'Nobody', language_code: 'ru' }),
  };
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/**
 * Stand in for telegram.org — by SERVING the script, not by racing it.
 *
 * The layout loads `telegram-web-app.js` `beforeInteractive`, and that script
 * ASSIGNS `window.Telegram`. A stand-in installed with `addInitScript` runs
 * first and is then overwritten by the real one — with an empty `initData`,
 * because the browser is not really a Telegram webview. It cost a red CI: the
 * two signed-blob tests passed on a machine with no route to telegram.org and
 * failed on the runner, which has one.
 *
 * Serving it ourselves fixes both halves at once. Nothing can overwrite the
 * stand-in because it IS the script, and the spec stops depending on the
 * public internet — a test that needs telegram.org to be reachable is a test
 * that fails for reasons having nothing to do with this app.
 *
 * `initData: null` means "not inside Telegram at all": an empty script, so
 * `window.Telegram` never exists.
 */
async function telegramScript(page: import('@playwright/test').Page, initData: string | null) {
  const body =
    initData === null
      ? '/* an ordinary browser: Telegram never defines itself here */'
      : `window.Telegram = { WebApp: {
           initData: ${JSON.stringify(initData)},
           initDataUnsafe: { user: { language_code: 'ru' } },
           ready() {}, expand() {},
         } };`;
  await page.route('**/telegram-web-app.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body }),
  );
}

/**
 * The stand-in really took. Asserted before every signed-blob expectation,
 * because the failure mode this spec already suffered was SILENT: with no
 * `initData` the screen falls back to "open me inside Telegram", every
 * assertion below reads a plausible sentence, and the test looks like a
 * product bug instead of a broken fixture.
 */
async function assertInsideTelegram(page: import('@playwright/test').Page) {
  const blob = await page.evaluate(
    () => (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData ?? '',
  );
  expect(blob, 'the Telegram stand-in did not survive to the page').not.toBe('');
}

test('the cabinet API refuses a request carrying no signed blob', async ({ request }) => {
  // Not a redirect to /login, not an empty 200 — a refusal. Anything else and
  // the cabinet's identity would be "whoever asks".
  const data = await request.get('/api/cabinet/data');
  expect(data.status()).toBe(401);

  const photo = await request.get('/api/cabinet/photo/00000000-0000-0000-0000-000000000000?i=0');
  expect(photo.status()).toBe(401);
});

test('opened in an ordinary browser it explains itself, and does not bounce to the staff login', async ({
  page,
}) => {
  await telegramScript(page, null);
  await page.goto('/cabinet');
  // Still on /cabinet: the route group is OUTSIDE (protected). A client who
  // taps the button and lands on an employee login screen is a support call.
  await expect(page).toHaveURL(/\/cabinet$/);
  await expect(page.getByTestId('cab-notice')).toBeVisible();
});

test('a genuine Telegram user who is not a customer is told to ask for a link', async ({ page }) => {
  await telegramScript(page, signedInitData(910_000_777));
  await page.goto('/cabinet');
  await assertInsideTelegram(page);
  // The 403 branch, in the language Telegram reports — distinct from both the
  // generic load error and the "open me inside Telegram" notice. Signed with
  // the server's own token, so this also proves the HMAC agrees end to end.
  // Compared against the dictionary rather than a pasted sentence: the three
  // notices differ only in wording, and a copy here would still pass if the
  // screen showed the wrong one after a re-translation.
  await expect(page.getByTestId('cab-notice')).toHaveText(clientLabels('ru').notLinkedApp);
  // Nothing to retry — the link is missing, not the network.
  await expect(page.getByRole('button', { name: clientLabels('ru').retry })).toHaveCount(0);
});

test('a tampered blob is refused, whatever the webview claims', async ({ page }) => {
  // The attack the whole design is against: editing the id in a blob signed
  // for somebody else. It must die at the signature, not at some later check
  // — and the client is shown the ordinary failure, not a hint that they were
  // one step away from somebody else's cargo.
  const genuine = signedInitData(910_000_777);
  await telegramScript(page, genuine.replace('910000777', '910000778'));
  await page.goto('/cabinet');
  await assertInsideTelegram(page);
  await expect(page.getByTestId('cab-notice')).toHaveText(clientLabels('ru').loadError);
});

/**
 * The screen itself.
 *
 * Served a fixed payload rather than a real client, for the same reason the
 * tests above sign for nobody: this spec must be movable in the run order, and
 * a linked chat is configuration left behind (#183). What the server returns
 * is covered by `client-cabinet.integration.test.ts`; what is covered HERE is
 * that the numbers, the stages and the photographs actually reach the glass.
 */
const PAYLOAD = {
  locale: 'ru',
  totals: { boxes: 10, weightKg: 68.5, volumeM3: 1.02, balanceUsd: 250 },
  clients: [
    {
      id: 'c1',
      clientCode: 'GS777',
      name: 'Test client',
      cargo: [
        {
          lotId: 'lot-1',
          letter: 'A',
          productNameZh: '手机壳',
          productNameRu: 'Чехлы',
          statuses: { in_stock: 4, in_transit: 6 },
          total: 10,
          warehouseCodes: ['YW'],
          hasPhotos: true,
          weightKg: 68.5,
          volumeM3: 1.02,
          perBoxKg: 6.85,
          perBoxM3: 0.102,
          photoCount: 2,
        },
      ],
      balanceUsd: 250,
      recent: [
        { type: 'charge', amount: 250, currency: 'USD', amountUsd: 250, txDate: '2026-07-20', voided: false },
      ],
      history: [
        { letter: 'B', productNameZh: '杂货', productNameRu: null, n: 3, lastAt: '2026-06-01T09:00:00Z' },
      ],
    },
  ],
};

/** A 1×1 PNG — enough to become an object URL and land in the strip. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function cabinetWithData(page: import('@playwright/test').Page) {
  await telegramScript(page, signedInitData(910_000_777));
  await page.route('**/api/cabinet/data', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(PAYLOAD) }),
  );
  await page.route('**/api/cabinet/photo/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL }),
  );
  await page.goto('/cabinet');
  await assertInsideTelegram(page);
}

test('the cargo screen shows the count, the kilos and the cubes', async ({ page }) => {
  await cabinetWithData(page);

  // The three figures the owner asked for, in the header and again per lot.
  const head = page.locator('.cab-totals');
  await expect(head).toContainText('10');
  await expect(head).toContainText('68.5');
  await expect(head).toContainText('1.02');

  const lot = page.getByTestId('cab-lot');
  await expect(lot).toContainText('Чехлы');
  await expect(lot).toContainText('YW');

  // Two stages, so the bar is drawn — and drawn to scale: 4 of 10 and 6 of 10.
  const segments = page.getByTestId('cab-bar').locator('i');
  await expect(segments).toHaveCount(2);
  await expect(segments.first()).toHaveAttribute('style', /40%/);
  await expect(segments.last()).toHaveAttribute('style', /60%/);

  // And said in words too, because a bar alone does not say WHICH stage.
  await expect(lot).toContainText('на складе');
  await expect(lot).toContainText('в пути');
});

test('a photograph opens full screen and closes again', async ({ page }) => {
  await cabinetWithData(page);
  const strip = page.getByTestId('cab-photos');
  await expect(strip.locator('img')).toHaveCount(2);

  await expect(page.getByTestId('cab-lightbox')).toHaveCount(0);
  await strip.locator('button').first().click();
  await expect(page.getByTestId('cab-lightbox')).toBeVisible();
  await page.getByTestId('cab-lightbox').click();
  await expect(page.getByTestId('cab-lightbox')).toHaveCount(0);
});

test('the other two tabs carry the money and the history', async ({ page }) => {
  await cabinetWithData(page);

  await page.getByTestId('cab-tab-balance').click();
  const balance = page.getByTestId('cab-balance');
  await expect(balance).toContainText('$250.00');
  // Owing, and said so — not a bare number the client has to interpret.
  await expect(balance).toHaveAttribute('data-owing', 'true');
  await expect(balance).toContainText(clientLabels('ru').debtYes);

  await page.getByTestId('cab-tab-history').click();
  await expect(page.getByTestId('cab-lot')).toHaveCount(0);
  await expect(page.locator('.cab-body')).toContainText('杂货');
});
