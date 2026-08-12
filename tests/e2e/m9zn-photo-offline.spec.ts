import { expect, test } from '@playwright/test';
import sharp from 'sharp';

/**
 * Round 97: adding a photo must not ask a foreign server for permission.
 *
 * The owner, receiving cargo: «yuk qabul qilganda rasimni kirgizgandan keyin
 * prixodga ruxsat chiqmayabti». `browser-image-compression` does its work in a
 * Web Worker, and the worker it builds fetches the library itself from
 * cdn.jsdelivr.net at runtime — on every single photograph. Measured in this
 * container, which has no route to the public internet: 12.7 s of nothing,
 * then a silent fall-back. In Yiwu, Guangzhou and Kashgar, where every receipt
 * in this business is actually created, jsDelivr is not reliably reachable at
 * all.
 *
 * This spec asserts the fix as a FACT ABOUT THE NETWORK rather than as a
 * timing, because a timing assertion on a warehouse phone is a flake: no
 * request leaves this origin, and the photo lands anyway.
 *
 * It deliberately does not confirm the receipt — it is about the photo step,
 * and every later spec's state stays as it found it.
 */

const OPERATOR = '+998900000002';
const PASSWORD = 'demo1234';

test('a photo is compressed and sent without touching a CDN', async ({ page }) => {
  const foreign: string[] = [];
  // Anything that is not our own origin, recorded rather than blocked: a
  // blocked request would prove only that blocking works.
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost:3000') && !r.url().startsWith('blob:')) {
      foreign.push(r.url());
    }
  });

  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OPERATOR);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/receive');
  await page.evaluate(() => localStorage.removeItem('gsr-receipt-draft'));
  await page.reload();

  const photo = await sharp({
    create: { width: 1200, height: 900, channels: 3, background: { r: 140, g: 120, b: 90 } },
  })
    .jpeg()
    .toBuffer();

  await page
    .locator('#mobile-product-lines input[type="file"]')
    .first()
    .setInputFiles({ name: 'yuk.jpg', mimeType: 'image/jpeg', buffer: photo });

  // The thumbnail is the proof the whole path ran: compress → upload → the
  // attachment route serving it back.
  await expect(page.locator('#mobile-product-lines img[src*="/api/attachments/"]').first()).toBeVisible({
    timeout: 20_000,
  });

  // …and nothing left this origin to make it happen. Before the fix this list
  // held cdn.jsdelivr.net and the wait was thirteen seconds.
  expect(foreign).toEqual([]);
});

test('the tile says it is working, so a slow phone is not a dead screen', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[name="identifier"]').fill(OPERATOR);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('main form button[type="submit"]').first().click();
  await expect(page).toHaveURL('/');

  await page.goto('/receive');
  await page.evaluate(() => localStorage.removeItem('gsr-receipt-draft'));
  await page.reload();

  // Hold the upload open so the in-flight state is observable at all. This is
  // the state a warehouse phone is in for seconds at a time, and the screen
  // used to look exactly the same as before the tap — which is why the
  // operator taps again, and why the report reads «nothing happens».
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/files/upload', async (route) => {
    await held;
    await route.continue();
  });

  const photo = await sharp({
    create: { width: 600, height: 400, channels: 3, background: { r: 90, g: 140, b: 120 } },
  })
    .jpeg()
    .toBuffer();
  await page
    .locator('#mobile-product-lines input[type="file"]')
    .first()
    .setInputFiles({ name: 'yuk.jpg', mimeType: 'image/jpeg', buffer: photo });

  await expect(page.getByTestId('photo-uploading')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('lot-photo-tile').first()).toHaveAttribute('aria-busy', 'true');
  // And the confirm cannot fire meanwhile — filing the receipt now would file
  // it without the photograph that is a second from landing on it.
  await expect(page.getByTestId('confirm-receipt')).toBeDisabled();

  release();
  await expect(page.getByTestId('photo-uploading')).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId('lot-photo-tile').first()).toHaveAttribute('aria-busy', 'false');
});
