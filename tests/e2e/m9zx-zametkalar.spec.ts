import { expect, test } from '@playwright/test';

/**
 * Zametkalar in the browser.
 *
 * What the rules do is proven in the unit and integration suites. What only a
 * browser can show is that the door exists, that a note stores its text, its
 * point and a real uploaded FILE, that a part can be swapped without
 * destroying the note — his own maintenance case, «the warehouse moved» — and
 * that it can be taken back off.
 *
 * The note it creates is PERSONAL and it is deleted in a final TEST: a company
 * note is on every colleague's screen and in every colleague's bot list for
 * the rest of the run, and a note is configuration (#183). Cleanup is a test
 * and never an `afterAll` — `browser.newPage()` there has neither baseURL nor
 * login and silently does nothing (round 57's recorded lie).
 *
 * NOT covered here, and stated: the bot half. Nothing in this repository can
 * prove that the bot re-sends the sheet into a chat — there is no grammy
 * harness, this container cannot reach Telegram and CI has no bot token. The
 * first real tap is watched in the container's own logs.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const STAMP = Date.now().toString().slice(-6);
const TITLE = `Xitoy sklad ${STAMP}`;

test.describe.configure({ mode: 'serial' });

async function login(page: import('@playwright/test').Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

const row = (page: import('@playwright/test').Page, title: string) =>
  page.locator('[data-testid="note-row"]').filter({ hasText: title });

test('a note carries text, a pin and a file, and is written as one', async ({ page }) => {
  await login(page);
  await page.goto('/zametkalar');
  await expect(page.getByTestId('notes-hint')).toBeVisible();

  await page.getByTestId('add-note').click();
  const form = page.getByTestId('note-form');
  await form.getByLabel('Nomi').fill(TITLE);
  await form.getByLabel('Matn').fill('Marking: GSR-777. Telefon: +86 000 000.');
  // The pair a map app puts on the clipboard, in ONE box — two decimal-degree
  // inputs refuse exactly this.
  await form.getByLabel('Koordinata yoki xarita havolasi').fill('29.306, 120.077');
  await form.getByLabel('Joy nomi').fill('Yiwu ombori');
  await form.getByLabel('Manzil').fill('Yiwu, Zhejiang');
  await form.getByTestId('note-file').setInputFiles({
    name: 'sklad.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  });
  await expect(page.getByTestId('note-uploaded')).toContainText('sklad.jpg');
  await page.getByTestId('save-note').click();

  const card = row(page, TITLE);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Marking: GSR-777');
  await expect(card).toContainText('Yiwu, Zhejiang');
  await expect(card.getByTestId('note-parts')).toContainText('sklad.jpg');
});

test('a wrong part is swapped without destroying the note', async ({ page }) => {
  await login(page);
  await page.goto('/zametkalar');
  const card = row(page, TITLE);
  page.once('dialog', (d) => void d.accept());
  await card.getByTestId('delete-part').first().click();
  await expect(card.getByTestId('note-parts')).toHaveCount(0);
  // …and the note itself is still there, with its words and its address.
  await expect(card).toContainText('Marking: GSR-777');
});

test('an empty note is refused in words', async ({ page }) => {
  await login(page);
  await page.goto('/zametkalar');
  await page.getByTestId('add-note').click();
  const form = page.getByTestId('note-form');
  await form.getByLabel('Nomi').fill(`Bo'sh ${STAMP}`);
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('note-error')).toBeVisible();
});

test('cleanup: the note is taken back off', async ({ page }) => {
  await login(page);
  await page.goto('/zametkalar');
  const card = row(page, TITLE);
  page.once('dialog', (d) => void d.accept());
  await card.getByTestId('delete-note').click();
  await expect(row(page, TITLE)).toHaveCount(0);
});
