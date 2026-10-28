import { expect, request as playwrightRequest, test, type Page } from '@playwright/test';

/**
 * A file downloads where the login cookie does not travel (the owner,
 * 2026-10-27: «download unsuccessful … 3 c» — opened from Telegram's
 * «↗️ Ochish», whose in-app browser hands files to the phone's download
 * manager, which carries no cookie).
 *
 *  1. the press asks for a download link and the download comes from it,
 *     under the file's own name;
 *  2. that link serves the file to a client holding NO cookie at all — the
 *     download manager's position — while the plain address refuses it (the
 *     control: the phone's «unsuccessful», reproduced);
 *  3. a link with one character changed serves nothing.
 */

const OWNER = '+998900000001';
const PASSWORD = 'demo1234';
const BASE = process.env.APP_URL ?? 'http://localhost:3000';

test.describe.configure({ mode: 'serial' });

async function login(page: Page) {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OWNER);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');
}

let linkUrl = '';

test('a file link downloads through a signed link, under the file’s own name', async ({ page }) => {
  await login(page);
  await page.goto('/admin/clients');
  const minted = page.waitForResponse((r) => r.url().endsWith('/api/dl') && r.request().method() === 'POST');
  const download = page.waitForEvent('download');
  await page.getByTestId('clients-xlsx').click();
  const answer = await (await minted).json();
  expect(answer.url).toMatch(/^\/api\/dl\/[\w-]+\.[\w-]+$/);
  linkUrl = answer.url;
  const file = await download;
  expect(file.url()).toContain('/api/dl/');
  expect(file.suggestedFilename()).toMatch(/^clients-.*\.xlsx$/);
});

test('the link serves a client with no cookie; the plain address does not', async () => {
  expect(linkUrl).not.toBe('');
  const stranger = await playwrightRequest.newContext({ baseURL: BASE });
  try {
    const plain = await stranger.get('/api/clients/xlsx');
    // The door refuses a stranger (403 here) — the phone's «unsuccessful».
    expect(plain.status()).toBe(403);

    const viaLink = await stranger.get(linkUrl);
    expect(viaLink.status()).toBe(200);
    expect(viaLink.headers()['content-disposition']).toMatch(/attachment; filename="clients-.*\.xlsx"/);
    // An XLSX is a zip: the bytes, not just the headers, came through.
    expect((await viaLink.body()).subarray(0, 2).toString()).toBe('PK');

    const last = linkUrl.at(-1) === 'A' ? 'B' : 'A';
    const forged = await stranger.get(`${linkUrl.slice(0, -1)}${last}`);
    expect(forged.status()).toBe(404);
  } finally {
    await stranger.dispose();
  }
});
