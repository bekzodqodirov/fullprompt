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
  // No street map in the fixture: the map still zooms and pans, over a plain field.
  basemap: false,
  // Item 11: where the cargo is — one truck on the road, one warehouse.
  map: [
    {
      key: 'truck:b1',
      kind: 'truck',
      name: 'Kashgar → Andijan',
      point: { x: 74.6, y: 39.6 },
      live: false,
      route: [
        { x: 75.98, y: 39.47 },
        { x: 73.91, y: 39.68 },
        { x: 72.34, y: 40.78 },
      ],
      remainingDays: [2, 4],
      boxes: 6,
      kg: 41.1,
      m3: 0.612,
      lots: [{ lotId: 'lot-1', letter: 'A', productNameZh: '手机壳', productNameRu: 'Чехлы', boxes: 6, kg: 41.1, m3: 0.612 }],
    },
    {
      key: 'warehouse:w1',
      kind: 'warehouse',
      name: 'Yiwu',
      point: { x: 120.07, y: 29.3 },
      live: false,
      route: [],
      remainingDays: null,
      boxes: 4,
      kg: 27.4,
      m3: 0.408,
      lots: [{ lotId: 'lot-1', letter: 'A', productNameZh: '手机壳', productNameRu: 'Чехлы', boxes: 4, kg: 27.4, m3: 0.408 }],
    },
  ],
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
          groups: [
            {
              stage: 'export_transit',
              n: 6,
              transit: {
                fromPlace: 'Kashgar',
                toPlace: 'Andijan',
                progress: 0.64,
                etaFromIso: '2030-08-14T00:00:00Z',
                etaToIso: '2030-08-16T00:00:00Z',
              },
            },
            { stage: 'cn_warehouse', n: 4, transit: null },
          ],
          journey: [
            { key: 'received', atIso: '2030-08-01T05:00:00Z' },
            { key: 'toHub', atIso: '2030-08-03T05:00:00Z' },
            { key: 'atHub', atIso: '2030-08-09T05:00:00Z' },
            { key: 'export', atIso: '2030-08-11T05:00:00Z' },
          ],
          total: 10,
          warehousePlaces: ['Yiwu'],
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
      // One handover (F): the goods, both trucks with their dates, who handed
      // it over — and the money PAID in the same window, nothing else.
      history: [
        {
          id: 'h1',
          issuedAt: '2030-08-20T06:00:00Z',
          place: 'Tashkent',
          receiver: 'Aziz',
          issuedBy: 'Sklad hodimi',
          lots: [
            {
              lotId: 'lot-2',
              letter: 'B',
              productNameZh: '杂货',
              productNameRu: null,
              receivedAt: '2030-08-01T05:00:00Z',
              n: 3,
              weightKg: 21,
              volumeM3: 0.3,
              photoCount: 1,
            },
          ],
          legs: [
            { batchCode: 'YW-017', fromPlace: 'Yiwu', toPlace: 'Kashgar', domestic: true, departedAt: '2030-08-03T05:00:00Z', arrivedAt: '2030-08-09T05:00:00Z', n: 3 },
            { batchCode: 'KA-042', fromPlace: 'Kashgar', toPlace: 'Tashkent', domestic: false, departedAt: '2030-08-11T05:00:00Z', arrivedAt: '2030-08-18T05:00:00Z', n: 3 },
          ],
        },
      ],
      payments: [{ txDate: '2030-08-19', amount: 300, currency: 'USD' }],
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
  // The place by NAME, not the warehouse code: staff jargon has no business
  // on the one screen a customer opens.
  await expect(lot).toContainText('Yiwu');

  // Said in words first. Russian, because this fixture's client reads Russian.
  await expect(page.getByTestId('cab-stage')).toContainText('В пути');

  // The ROAD, named at both ends and filled to the schedule's own figure —
  // the owner's rejection of the first version was exactly that an unlabelled
  // strip means nothing («yolni qanchasini bosib otganini korsatadgan …»).
  const road = page.getByTestId('cab-road');
  await expect(road).toContainText('Kashgar');
  await expect(road).toContainText('Andijan');
  await expect(road).toContainText('64%');
  await expect(road.locator('.cab-road-bar i')).toHaveAttribute('style', /64%/);

  // The estimate names its destination and always says «примерно».
  await expect(page.getByTestId('cab-eta')).toContainText('Andijan');
  await expect(page.getByTestId('cab-eta')).toContainText('примерно');

  // «Qachon nima bo'lgan» — the dated history, with real dates on every line.
  const journey = page.getByTestId('cab-journey');
  await expect(journey.locator('li')).toHaveCount(4);
  await expect(journey.locator('li').first()).toContainText('01.08');
  await expect(journey.locator('li').first()).toContainText('Принят на наш склад');
  await expect(journey.locator('li').last()).toContainText('11.08');
  await expect(journey.locator('li').last()).toContainText('Экспорт');

  // The remainder is named under it rather than left unexplained.
  await expect(lot).toContainText('Принят на наш склад в Китае');
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
  // The history is its own cards, never the live cargo's.
  await expect(page.getByTestId('cab-lot')).toHaveCount(0);
  const handover = page.getByTestId('cab-handover');
  await expect(handover).toHaveCount(1);
  await expect(handover).toContainText('杂货');
  await expect(handover).toContainText('20.08.2030');
  await expect(handover).toContainText('Aziz');
  await expect(handover).toContainText('Sklad hodimi');
  await expect(handover.getByTestId('cab-handover-leg')).toHaveCount(2);
  await expect(handover).toContainText('YW-017');
  await expect(handover).toContainText('KA-042');
  await expect(handover.getByTestId('cab-photos')).toBeVisible();
  // Money: what was paid, never a charge.
  await expect(page.getByTestId('cab-payments')).toContainText('+300 USD');
  await expect(page.getByTestId('cab-payments')).not.toContainText('250');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});

/*
 * Round C — the answer first. The fixture above stays EXACTLY what it was
 * (none of the round's optional fields: an older server mid-deploy must still
 * draw), and the round's own screen gets a second fixture that carries them:
 * a manager, the office, a stored language, and a READY lot with a number big
 * enough to need grouping.
 */
const PAYLOAD_C = {
  ...PAYLOAD,
  storedLocale: 'ru',
  office: { name: 'GSR LOGISTICS', phone: '+998711234567' },
  clients: [
    {
      ...PAYLOAD.clients[0]!,
      manager: { name: 'Dilnoza', phone: '+998901234567', telegramUrl: 'https://t.me/dilnoza_gsr' },
      readyPlaces: [{ name: 'Toshkent 1', address: null }],
      cargo: [
        ...PAYLOAD.clients[0]!.cargo,
        {
          lotId: 'lot-9',
          letter: 'B',
          productNameZh: '夹克',
          productNameRu: 'Куртки',
          groups: [{ stage: 'ready', n: 12, transit: null }],
          journey: [
            { key: 'received', atIso: '2030-07-01T05:00:00Z' },
            // No «customs» step on purpose: landed cargo's journey often lacks
            // it, and the ✅ below must come from `readyCleared` alone.
            { key: 'inUz', atIso: '2030-07-20T05:00:00Z' },
            { key: 'ready', atIso: '2030-07-22T05:00:00Z' },
          ],
          total: 12,
          // The server's own split (MA-1): all twelve came off a cleared truck.
          readyCleared: 12,
          warehousePlaces: ['Toshkent 1'],
          hasPhotos: false,
          weightKg: 12845.5,
          volumeM3: 58.214,
          perBoxKg: 1070.46,
          perBoxM3: 4.851,
          photoCount: 0,
        },
      ],
    },
  ],
};

async function cabinetWith(page: import('@playwright/test').Page, payload: unknown, path = '/cabinet') {
  await telegramScript(page, signedInitData(910_000_777));
  await page.route('**/api/cabinet/data', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) }),
  );
  await page.route('**/api/cabinet/photo/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: PIXEL }),
  );
  await page.goto(path);
  await assertInsideTelegram(page);
}

test('the header says where everything is and what is owed; every lot has its five steps (round C)', async ({ page }) => {
  await cabinetWithData(page);
  const ru = clientLabels('ru');

  // The bot's own buckets (`milestoneCounts`): six on the road, four in China.
  const status = page.getByTestId('cab-status');
  await expect(status.locator('[data-step="transit"]')).toContainText(ru.sumTransit);
  await expect(status.locator('[data-step="transit"]')).toContainText('6');
  await expect(status.locator('[data-step="china"]')).toContainText('4');
  await expect(status.locator('[data-step="ready"]')).toHaveCount(0);

  // What is owed, in one chip, red — and a tap on it is the balance.
  const chip = page.getByTestId('cab-balance-chip');
  await expect(chip).toHaveText(`${ru.chipOwe} $250.00`);
  await expect(chip).toHaveAttribute('data-owing', 'true');

  // Five dots; the bulk stands at «transit», the four left in Yiwu ring «China».
  const steps = page.getByTestId('cab-steps');
  await expect(steps.locator('li')).toHaveCount(5);
  await expect(steps.locator('li[data-state="now"]')).toHaveText(ru.msShortTransit);
  await expect(steps.locator('li[data-also="true"]')).toHaveText(ru.msShortChina);

  // Measured, not hoped: the pinned header cost 199 px of an 800 px phone in
  // Russian before this round; it must never climb back.
  const head = await page.locator('.cab-head').boundingBox();
  expect(head!.height).toBeLessThan(199);
  // Nothing wider than the phone, with the stepper in it.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );

  // A server that sent no people draws no empty contact card.
  await expect(page.getByTestId('cab-manager')).toHaveCount(0);
  await expect(page.getByTestId('cab-office')).toHaveCount(0);

  await chip.click();
  await expect(page.getByTestId('cab-balance')).toBeVisible();
});

test('a push opens the app on its lot: the ready card, the manager, grouped numbers (round C)', async ({ page }) => {
  await cabinetWith(page, PAYLOAD_C, '/cabinet?lot=lot-9');
  const ru = clientLabels('ru');

  // The lot the push was about, ringed and on the glass.
  const focused = page.locator('[data-lot-id="lot-9"]');
  await expect(focused).toHaveAttribute('data-focus', 'true');
  await expect(focused).toBeInViewport();
  // Nearest to the customer first: ready (step 4) above the road (step 2).
  await expect(page.getByTestId('cab-lot').first()).toHaveAttribute('data-lot-id', 'lot-9');
  await expect(page.locator('[data-lot-id="lot-1"]')).not.toHaveAttribute('data-focus', 'true');

  // Thousands grouped — «12 845.5», never «12845.5».
  await expect(focused.locator('.cab-dims')).toContainText(/12\s845\.5/);
  await expect(focused.locator('li[data-state="now"]')).toHaveText(ru.msShortReady);

  // The ready card: how many, where, what is owed first, and whom to call.
  const ready = page.getByTestId('cab-ready');
  await expect(ready).toContainText('Готово к выдаче: 12 коробок');
  await expect(ready).toContainText('Toshkent 1');
  await expect(ready).toContainText('$250.00');

  // The manager, once: a chat link and the number itself, dialable and legible.
  const card = page.getByTestId('cab-manager');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Dilnoza');
  await expect(card).toContainText(ru.managerTitle);
  await expect(card.getByTestId('cab-contact-write')).toHaveAttribute('href', 'https://t.me/dilnoza_gsr');
  const call = card.getByTestId('cab-contact-call');
  await expect(call).toHaveAttribute('href', 'tel:+998901234567');
  await expect(call).toContainText('+998 90 123 45 67');
  // Every code has a manager, so no office card.
  await expect(page.getByTestId('cab-office')).toHaveCount(0);
});

test('the language is switched from inside the app, and a refusal switches it back (round C)', async ({ page }) => {
  const posted: { body: unknown; initData: string | null }[] = [];
  let answer = 200;
  await page.route('**/api/cabinet/locale', async (route) => {
    posted.push({ body: route.request().postDataJSON(), initData: route.request().headers()['x-telegram-init-data'] ?? null });
    await route.fulfill({
      status: answer,
      contentType: 'application/json',
      body: JSON.stringify(answer === 200 ? { ok: true, locale: 'uz', changed: true } : { error: 'too_fast' }),
    });
  });
  await cabinetWith(page, PAYLOAD_C);

  // The STORED choice is the one lit.
  await expect(page.getByTestId('cab-lang-ru')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('cab-lang-uz')).toHaveAttribute('aria-pressed', 'false');

  await page.getByTestId('cab-lang-uz').click();
  await expect(page.getByTestId('cab-tab-cargo')).toContainText(clientLabels('uz').tabCargo);
  await expect(page.getByTestId('cab-lang-uz')).toHaveAttribute('aria-pressed', 'true');
  // The choice travels with the signed blob in the HEADER, never in the body.
  expect(posted).toHaveLength(1);
  expect(posted[0]!.body).toEqual({ locale: 'uz' });
  expect(posted[0]!.initData).toBeTruthy();

  // Refused (the server's ten-second brake): the screen goes back to what the
  // chat actually holds.
  answer = 429;
  await page.getByTestId('cab-lang-en').click();
  await expect.poll(() => posted.length).toBe(2);
  await expect(page.getByTestId('cab-tab-cargo')).toContainText(clientLabels('uz').tabCargo);
  await expect(page.getByTestId('cab-lang-uz')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('cab-lang-en')).toHaveAttribute('aria-pressed', 'false');
});

test('↻ asks again, and a day-old window says to reopen it instead of offering a retry (round C)', async ({ page }) => {
  let calls = 0;
  await telegramScript(page, signedInitData(910_000_777));
  await page.route('**/api/cabinet/data', (route) => {
    calls += 1;
    return calls === 1
      ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(PAYLOAD) })
      : route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'expired' }) });
  });
  await page.route('**/api/cabinet/photo/**', (route) => route.fulfill({ contentType: 'image/png', body: PIXEL }));
  await page.goto('/cabinet');
  await assertInsideTelegram(page);
  await expect(page.getByTestId('cab-lot')).toBeVisible();

  await page.getByTestId('cab-refresh').click();
  await expect(page.getByTestId('cab-notice')).toHaveText(clientLabels('ru').expiredApp);
  await expect(page.getByRole('button', { name: clientLabels('ru').retry })).toHaveCount(0);
  expect(calls).toBe(2);
});

test('the map is a real map: markers to tap, and every place listed under it (item 11)', async ({ page }) => {
  await cabinetWithData(page);
  await page.getByTestId('cab-map-open').click();
  await expect(page.getByTestId('cab-map-screen')).toBeVisible();
  // Leaflet owns the canvas: a pinch zooms it, the page underneath stays put.
  const canvas = page.getByTestId('cab-map-canvas');
  await expect(canvas.locator('.leaflet-map-pane')).toHaveCount(1);
  expect(await canvas.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  // The first place is open on arrival: the truck, by its road and its days.
  const sheet = page.getByTestId('cab-map-sheet');
  await expect(sheet).toContainText('Kashgar → Andijan');
  await expect(sheet).toContainText('~2–4');
  await expect(sheet).toContainText('Чехлы');
  // A tap on the warehouse MARKER opens that place's row.
  await page.getByTestId('cab-map-marker-warehouse').click();
  await expect(page.getByTestId('cab-map-warehouse')).toHaveAttribute('aria-expanded', 'true');
  await expect(sheet).toContainText('27.4');
  // …and a tap on a row opens it too, from the list.
  await page.getByTestId('cab-map-truck').click();
  await expect(page.getByTestId('cab-map-truck')).toHaveAttribute('aria-expanded', 'true');
  // Nothing wider than the phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
  // Closing gives the page its scroll back.
  await page.locator('.cab-map-close').click();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
});
